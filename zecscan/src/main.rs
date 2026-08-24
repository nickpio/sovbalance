use std::collections::BTreeMap;
use std::convert::Infallible;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use clap::{Parser, Subcommand};
use rand::rngs::OsRng;
use zcash_address::unified::{Encoding, Ufvk};
use zcash_client_backend::{
    data_api::{
        chain::{error::Error as ChainError, BlockCache, BlockSource, ChainState},
        scanning::ScanRange,
        wallet::ConfirmationsPolicy,
        AccountBirthday, AccountPurpose, WalletRead, WalletWrite,
    },
    proto::{
        compact_formats::CompactBlock,
        service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    },
};
use zcash_client_sqlite::{
    util::SystemClock,
    wallet::init::init_wallet_db,
    WalletDb,
};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::{BlockHeight, Network, NetworkType, NetworkUpgrade, Parameters};

const BATCH_SIZE: u32 = 100;

#[derive(Parser)]
#[command(name = "zec-scan", about = "View-only Zcash scanner for unified viewing keys")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Decode a mainnet unified full viewing key
    Validate {
        #[arg(long)]
        ufvk: Option<String>,
    },
    /// Sync a view-only wallet and print its balance as JSON
    Scan {
        #[arg(long)]
        lwd: String,
        #[arg(long)]
        tls_domain: Option<String>,
        #[arg(long)]
        db: PathBuf,
        #[arg(long)]
        ufvk: Option<String>,
        #[arg(long)]
        birthday: u32,
        #[arg(long, default_value_t = 0)]
        max_seconds: u64,
    },
}

#[derive(Default)]
struct MemBlockCache {
    blocks: Mutex<BTreeMap<u64, CompactBlock>>,
}

impl BlockSource for MemBlockCache {
    type Error = Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let from = from_height.map(u64::from).unwrap_or(0);
        let blocks = self.blocks.lock().expect("mem block cache poisoned");
        for (_, block) in blocks.range(from..).take(limit.unwrap_or(usize::MAX)) {
            with_block(block.clone())?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemBlockCache {
    fn get_tip_height(
        &self,
        range: Option<&ScanRange>,
    ) -> Result<Option<BlockHeight>, Self::Error> {
        let blocks = self.blocks.lock().expect("mem block cache poisoned");
        let tip = match range {
            None => blocks.keys().next_back().copied(),
            Some(range) => {
                let end = u64::from(range.block_range().end);
                blocks.range(..end).next_back().map(|(k, _)| *k)
            }
        };
        Ok(tip.map(|k| BlockHeight::from_u32(k as u32)))
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let start = u64::from(range.block_range().start);
        let end = u64::from(range.block_range().end);
        let blocks = self.blocks.lock().expect("mem block cache poisoned");
        Ok(blocks.range(start..end).map(|(_, b)| b.clone()).collect())
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut blocks = self.blocks.lock().expect("mem block cache poisoned");
        for block in compact_blocks {
            blocks.insert(block.height, block);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let start = u64::from(range.block_range().start);
        let end = u64::from(range.block_range().end);
        let mut blocks = self.blocks.lock().expect("mem block cache poisoned");
        let keys: Vec<u64> = blocks.range(start..end).map(|(k, _)| *k).collect();
        for k in keys {
            blocks.remove(&k);
        }
        Ok(())
    }
}

fn ufvk_arg(cli: Option<String>) -> anyhow::Result<String> {
    if let Some(value) = cli.filter(|s| !s.trim().is_empty()) {
        return Ok(value);
    }
    std::env::var("ZEC_SCAN_UFVK")
        .map_err(|_| anyhow!("missing --ufvk or ZEC_SCAN_UFVK"))
}

fn decode_mainnet_ufvk(raw: &str) -> anyhow::Result<UnifiedFullViewingKey> {
    let trimmed = raw.trim();
    if trimmed.to_ascii_lowercase().starts_with("uivk") {
        anyhow::bail!("incoming viewing keys cannot track spends — export the full viewing key");
    }

    let (network, ufvk) = Ufvk::decode(trimmed)
        .map_err(|_| anyhow!("Enter a mainnet unified viewing key (starts with uview1)"))?;

    match network {
        NetworkType::Main => {}
        NetworkType::Test => anyhow::bail!("testnet viewing keys are not supported"),
        NetworkType::Regtest => anyhow::bail!("regtest viewing keys are not supported"),
    }

    UnifiedFullViewingKey::parse(&ufvk)
        .map_err(|e| anyhow!("Invalid unified viewing key: {e}"))
}

fn open_wallet(path: &Path) -> anyhow::Result<WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create wallet directory {}", parent.display()))?;
    }

    let mut db = WalletDb::for_path(path, Network::MainNetwork, SystemClock, OsRng)
        .with_context(|| format!("open wallet database {}", path.display()))?;
    init_wallet_db(&mut db, None).context("initialize wallet database")?;
    if let Ok(conn) = rusqlite::Connection::open(path) {
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
    }
    Ok(db)
}

fn lwd_endpoint(raw: &str) -> anyhow::Result<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("http://{trimmed}"))
    }
}

fn url_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let host = if let Some(inner) = authority.strip_prefix('[').and_then(|s| s.split(']').next()) {
        inner
    } else {
        authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority)
    };
    Some(host.to_string())
}

fn is_transport_error(err: &dyn std::error::Error) -> bool {
    let mut cur: Option<&dyn std::error::Error> = Some(err);
    while let Some(e) = cur {
        let msg = e.to_string().to_ascii_lowercase();
        if msg.contains("broken pipe")
            || msg.contains("transport error")
            || msg.contains("connection reset")
            || msg.contains("connection error")
        {
            return true;
        }
        cur = e.source();
    }
    false
}

fn channel_endpoint(endpoint: &str) -> anyhow::Result<tonic::transport::Endpoint> {
    Ok(tonic::transport::Channel::from_shared(endpoint.to_string())
        .with_context(|| format!("invalid lightwalletd URL {endpoint}"))?
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .tcp_nodelay(true)
        .http2_keep_alive_interval(Duration::from_secs(10))
        .keep_alive_timeout(Duration::from_secs(10))
        .keep_alive_while_idle(true))
}

#[derive(Debug)]
struct NoCertVerifier;

impl rustls::client::danger::ServerCertVerifier for NoCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn insecure_rustls_config() -> rustls::ClientConfig {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoCertVerifier))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec()];
    config
}

fn as_http(url: &str) -> String {
    match url.strip_prefix("https://") {
        Some(rest) => format!("http://{rest}"),
        None => url.to_string(),
    }
}

async fn open_tls_verified(
    endpoint: &str,
    domain: &str,
) -> anyhow::Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    let tls = tonic::transport::ClientTlsConfig::new()
        .domain_name(domain)
        .with_enabled_roots()
        .assume_http2(true);
    let channel = channel_endpoint(endpoint)?
        .tls_config(tls)
        .with_context(|| format!("TLS config for {endpoint}"))?
        .connect()
        .await
        .with_context(|| format!("connect to lightwalletd at {endpoint}"))?;
    Ok(CompactTxStreamerClient::new(channel))
}

async fn open_tls_insecure(
    endpoint: &str,
    tls_domain: Option<&str>,
) -> anyhow::Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    let sni = tls_domain
        .filter(|d| !d.is_empty())
        .map(|d| d.to_string())
        .or_else(|| url_host(endpoint))
        .unwrap_or_else(|| "localhost".into());
    let tls = tokio_rustls::TlsConnector::from(Arc::new(insecure_rustls_config()));
    let connector = tower::service_fn(move |uri: http::Uri| {
        let tls = tls.clone();
        let sni = sni.clone();
        async move {
            let host = uri.host().unwrap_or("127.0.0.1").to_string();
            let port = uri.port_u16().unwrap_or(443);
            let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
            let _ = tcp.set_nodelay(true);
            let name = rustls::pki_types::ServerName::try_from(sni)
                .or_else(|_| rustls::pki_types::ServerName::try_from(host))
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("{e}")))?;
            let tls_stream = tls.connect(name, tcp).await?;
            Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(tls_stream))
        }
    });

    // tonic rejects https:// unless tls_config() is set. This connector
    // already does TLS, so the Endpoint URI has to stay http://.
    let channel = channel_endpoint(&as_http(endpoint))?
        .connect_with_connector(connector)
        .await
        .with_context(|| format!("connect to lightwalletd at {endpoint}"))?;
    Ok(CompactTxStreamerClient::new(channel))
}

async fn open_tls_client(
    endpoint: &str,
    tls_domain: Option<&str>,
) -> anyhow::Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    let domain = tls_domain.filter(|d| !d.is_empty()).map(|d| d.to_string()).or_else(|| {
        url_host(endpoint).filter(|host| host.parse::<std::net::IpAddr>().is_err())
    });

    if let Some(domain) = domain {
        match open_tls_verified(endpoint, &domain).await {
            Ok(client) => return Ok(client),
            Err(e) => eprintln!("verified TLS failed ({e}); retrying without certificate checks"),
        }
    }

    open_tls_insecure(endpoint, tls_domain).await
}

async fn open_client(
    endpoint: &str,
    tls_domain: Option<&str>,
) -> anyhow::Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    eprintln!("connecting to {endpoint}");
    if endpoint.starts_with("https://") {
        return open_tls_client(endpoint, tls_domain).await;
    }

    let channel = channel_endpoint(endpoint)?
        .connect()
        .await
        .with_context(|| format!("connect to lightwalletd at {endpoint}"))?;
    Ok(CompactTxStreamerClient::new(channel))
}

async fn handshake(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
) -> anyhow::Result<()> {
    client
        .get_lightd_info(service::Empty::default())
        .await
        .context("lightwalletd handshake")?;
    Ok(())
}

async fn open_and_handshake(
    endpoint: &str,
    tls_domain: Option<&str>,
) -> anyhow::Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    let mut client = open_client(endpoint, tls_domain).await?;
    handshake(&mut client).await?;
    Ok(client)
}

async fn connect_lwd(
    lwd: &str,
    tls_domain: Option<&str>,
) -> anyhow::Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    let endpoint = lwd_endpoint(lwd)?;
    match open_and_handshake(&endpoint, tls_domain).await {
        Ok(client) => Ok(client),
        Err(e) if endpoint.starts_with("http://") && is_transport_error(e.root_cause()) => {
            let https = format!("https://{}", endpoint.trim_start_matches("http://"));
            match open_and_handshake(&https, tls_domain).await {
                Ok(client) => {
                    eprintln!("plaintext gRPC failed; using TLS at {https}");
                    Ok(client)
                }
                Err(_) => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

async fn fetch_chain_tip(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
) -> anyhow::Result<u32> {
    match client
        .get_latest_block(service::ChainSpec::default())
        .await
    {
        Ok(res) => res
            .into_inner()
            .height
            .try_into()
            .context("chain tip height does not fit in u32"),
        Err(e) => {
            let height = client
                .get_lightd_info(service::Empty::default())
                .await
                .with_context(|| format!("fetch chain tip: {e}"))?
                .into_inner()
                .block_height;
            height
                .try_into()
                .context("chain tip height does not fit in u32")
        }
    }
}

async fn wallet_birthday(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
    birthday_height: BlockHeight,
    recover_until: Option<BlockHeight>,
) -> anyhow::Result<AccountBirthday> {
    let params = Network::MainNetwork;
    let sapling_activation = params
        .activation_height(NetworkUpgrade::Sapling)
        .ok_or_else(|| anyhow!("Sapling activation height is not set"))?;
    let birthday_height = birthday_height.max(sapling_activation);

    if birthday_height == sapling_activation {
        let birthday_block = client
            .get_block(service::BlockId {
                height: u64::from(birthday_height),
                ..Default::default()
            })
            .await
            .context("fetch birthday block")?
            .into_inner();
        Ok(AccountBirthday::from_parts(
            ChainState::empty(birthday_height.saturating_sub(1), birthday_block.prev_hash()),
            recover_until,
        ))
    } else {
        let treestate = client
            .get_tree_state(service::BlockId {
                height: u64::from(birthday_height) - 1,
                ..Default::default()
            })
            .await
            .context("fetch birthday tree state")?
            .into_inner();
        AccountBirthday::from_treestate(treestate, recover_until)
            .map_err(|e| anyhow!("invalid birthday tree state: {e}"))
    }
}

async fn ensure_account(
    db: &mut WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>,
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
    ufvk: &UnifiedFullViewingKey,
    birthday_height: u32,
) -> anyhow::Result<()> {
    if db.get_account_for_ufvk(ufvk).context("lookup account")?.is_some() {
        return Ok(());
    }

    let chain_tip = fetch_chain_tip(client).await?;

    let birthday = wallet_birthday(
        client,
        BlockHeight::from_u32(birthday_height),
        Some(BlockHeight::from_u32(chain_tip)),
    )
    .await?;

    db.import_account_ufvk("sovbalance", ufvk, &birthday, AccountPurpose::ViewOnly, None)
        .context("import unified viewing key")?;
    eprintln!("imported viewing key at birthday {birthday_height}");
    Ok(())
}

fn sync_percent(height: u32, birthday: u32, tip: u32) -> f64 {
    if tip <= birthday {
        return if tip > 0 && height >= tip { 100.0 } else { 0.0 };
    }
    let pct = f64::from(height.saturating_sub(birthday)) * 100.0 / f64::from(tip - birthday);
    (pct * 10.0).round() / 10.0
}

fn summary_value(
    db: &WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>,
    tip: u32,
    birthday: u32,
    timed_out: bool,
) -> anyhow::Result<serde_json::Value> {
    let policy = ConfirmationsPolicy::new_symmetrical(NonZeroU32::new(1).expect("nonzero"), true);
    let (synced, height, sapling, orchard, transparent, total) =
        if let Some(summary) = db.get_wallet_summary(policy).context("wallet summary")? {
            let mut sapling = 0u64;
            let mut orchard = 0u64;
            let mut transparent = 0u64;
            let mut total = 0u64;
            for balance in summary.account_balances().values() {
                sapling = sapling.saturating_add(balance.sapling_balance().total().into_u64());
                orchard = orchard.saturating_add(balance.orchard_balance().total().into_u64());
                transparent = transparent.saturating_add(balance.unshielded_balance().total().into_u64());
                total = total.saturating_add(balance.total().into_u64());
            }
            (
                summary.is_synced() && !timed_out,
                u32::from(summary.fully_scanned_height()),
                sapling,
                orchard,
                transparent,
                total,
            )
        } else {
            (false, 0, 0, 0, 0, 0)
        };

    Ok(serde_json::json!({
        "synced": synced,
        "height": height,
        "tip": tip,
        "birthday": birthday,
        "percent": sync_percent(height, birthday, tip),
        "sapling": sapling,
        "orchard": orchard,
        "transparent": transparent,
        "total": total,
    }))
}

fn read_scanned_height(path: &Path) -> Option<u32> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(200));
    conn.query_row("SELECT MAX(height) FROM blocks", [], |row| {
        row.get::<_, Option<i64>>(0)
    })
    .ok()
    .flatten()
    .and_then(|height| u32::try_from(height).ok())
}

fn emit_height_progress(path: &Path, tip: u32, birthday: u32) {
    let height = read_scanned_height(path).unwrap_or(birthday);
    let value = serde_json::json!({
        "height": height,
        "tip": tip,
        "birthday": birthday,
        "percent": sync_percent(height, birthday, tip),
    });
    eprintln!("progress {value}");
}

async fn run_scan(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
    cache: &MemBlockCache,
    db: &mut WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>,
    max_seconds: u64,
    tip: u32,
    birthday: u32,
    db_path: &Path,
) -> anyhow::Result<bool> {
    let progress_path = db_path.to_path_buf();
    let progress = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            emit_height_progress(&progress_path, tip, birthday);
        }
    });

    let result = if max_seconds == 0 {
        zcash_client_backend::sync::run(client, &Network::MainNetwork, cache, db, BATCH_SIZE)
            .await
            .map_err(|e| anyhow!("wallet sync failed: {e}"))
            .map(|()| false)
    } else {
        match tokio::time::timeout(
            Duration::from_secs(max_seconds),
            zcash_client_backend::sync::run(client, &Network::MainNetwork, cache, db, BATCH_SIZE),
        )
        .await
        {
            Ok(Ok(())) => Ok(false),
            Ok(Err(e)) => Err(anyhow!("wallet sync failed: {e}")),
            Err(_) => {
                eprintln!("scan time limit reached; progress is saved");
                Ok(true)
            }
        }
    };

    progress.abort();
    result
}

async fn scan(args: ScanArgs) -> anyhow::Result<()> {
    let ufvk = decode_mainnet_ufvk(&args.ufvk)?;
    let cache = MemBlockCache::default();
    let mut db = open_wallet(&args.db)?;
    let mut client = connect_lwd(&args.lwd, args.tls_domain.as_deref()).await?;

    ensure_account(&mut db, &mut client, &ufvk, args.birthday).await?;

    let tip = fetch_chain_tip(&mut client).await.unwrap_or(0);
    eprintln!("scanning from birthday {}", args.birthday);
    emit_height_progress(&args.db, tip, args.birthday);
    let timed_out = run_scan(
        &mut client,
        &cache,
        &mut db,
        args.max_seconds,
        tip,
        args.birthday,
        &args.db,
    )
    .await?;

    drop(db);
    drop(cache);
    let db = open_wallet(&args.db)?;
    println!("{}", summary_value(&db, tip, args.birthday, timed_out)?);
    Ok(())
}

struct ScanArgs {
    lwd: String,
    tls_domain: Option<String>,
    db: PathBuf,
    ufvk: String,
    birthday: u32,
    max_seconds: u64,
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("{e:#}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Validate { ufvk } => {
            decode_mainnet_ufvk(&ufvk_arg(ufvk)?)?;
            println!("ok");
            Ok(())
        }
        Command::Scan {
            lwd,
            tls_domain,
            db,
            ufvk,
            birthday,
            max_seconds,
        } => {
            scan(ScanArgs {
                lwd,
                tls_domain,
                db,
                ufvk: ufvk_arg(ufvk)?,
                birthday,
                max_seconds,
            })
            .await
        }
    }
}
