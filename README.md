![Bitcoin](https://img.shields.io/badge/Bitcoin-self--hosted-orange)
![Monero](https://img.shields.io/badge/Monero-view--only-brightgreen)
![Zcash](https://img.shields.io/badge/Zcash-shielded-yellow)
![Umbrel](https://img.shields.io/badge/Runs%20on-Umbrel-blue)
![License](https://img.shields.io/badge/license-MIT-green)

# sovBalance
<img src="./web/logo.png">

Track Bitcoin, Monero, and Zcash wallets on your Umbrel. Add as many as you want. The page shows each asset and a combined USD total.

Balances come from your Electrs, and from Monero Node or Zcash Node if those apps are installed. Nobody else's balance API is in the path.

Bitcoin: XPUB / YPUB / ZPUB
Monero: primary address + private view key
Zcash: transparent t1 / t3 address or unified viewing key (`uview1…`)
↓
sovBalance
↓
Electrs / local wallet-rpc / lightwalletd
↓
Bitcoin Core / Monero Node / Zcash Node

---

## Why

A lot of web trackers ask you to paste an XPUB or Monero view key into their site. That hands them every address, the balance, and the history.

sovBalance only talks to the node you run.

---

## Supported wallets

### Bitcoin

| Type | Standard | Script |
|-----|------|------|
| XPUB | BIP44 | Legacy |
| YPUB | BIP49 | Nested SegWit |
| ZPUB | BIP84 | Native SegWit |

Addresses are derived locally and scanned against Electrs with a gap limit of 20.

### Monero

| Type | What you enter |
|-----|------|
| View-only | Mainnet primary address (starts with `4`, 95 characters) + private view key |

View-only wallets can see received outputs, including subaddresses. Set a restore height from around when the wallet was created so you skip a full-chain scan.

Spends are detected automatically. A view key cannot compute key images, so the wallet itself never sees an outgoing transaction. sovBalance instead looks at every transaction that pays the wallet and asks your Monero Node for its input rings. A spend from the wallet returns change to it, and every one of its input rings must contain one of the wallet's own outputs. When that holds, and the matched outputs can cover the change plus the fee, the transaction is treated as a spend and the matched outputs are removed from the balance. Verdicts for confirmed transactions are cached under `data/monero`, and mempool transactions are checked too, so a spend shows up about as soon as it is broadcast.

Monero wallets are refreshed on a timer (`XMR_REFRESH_SECONDS`, default 120, `0` disables) and the page picks up new balances without a manual Refresh.

Limits of the ring analysis:

- A sweep or an exact-amount spend with no change output pays nothing back to the wallet, so it is not seen. Import key images after those.
- If one ring contains several of the wallet's outputs, all of them are treated as spent. The balance errs low, never high.
- A payment to the wallet whose ring happens to use one of the wallet's outputs as a decoy can look like a spend. The amount check rejects most of these. Importing key images corrects the rest.
- Pre-RingCT inputs are ignored.

### Zcash

| Type | What you enter |
|-----|------|
| Transparent | Mainnet `t1` or `t3` address (35 characters) |
| Shielded | Mainnet unified viewing key (`uview1…`) + optional birthday height |

Balances come from your Zcash Node's lightwalletd. Shielded wallets are scanned locally with a `zec-scan` helper. The viewing key trial-decrypts Sapling and Orchard outputs and tracks spends via nullifiers. Incoming-only keys (`uivk1…`) are rejected. They cannot detect spends.

Birthday height defaults to NU5 activation (1,687,104, May 2022). Set it earlier only if this wallet received funds before then. It cannot go below Sapling activation (419,200). The first shielded sync can take a long time and is saved to disk, so the next rescan continues where it left off.

---

## Key images

Key images are optional. Import them after a sweep with no change output, or whenever you want the balance reconciled exactly.

1. Spend from your full / spend wallet as usual
2. Export key images from that same spend wallet
   Monero GUI: Settings → Wallet → Export key images
   Feather: File → Export → Key images
3. In sovBalance, open Edit Wallet on the matching Monero wallet
4. Attach the export file, or paste `export_key_images` JSON, and save

Incoming funds do not need this. Outputs covered by imported key images are settled by the wallet; the ring analysis only applies to outputs received after the export. The file is encrypted with the view key, so it must come from the spend wallet for the same address.

---

## Requirements

- Umbrel
- Electrs installed
- [Monero Node](https://apps.umbrel.com/app/monero) only if you track Monero wallets
- [Zcash Node](https://github.com/nickpio/umbrel-zcash) only if you track Zcash wallets

---

## Installation

Install sovBalance from the Umbrel App Store. It connects to Electrs on its own. Install Monero Node and/or Zcash Node and restart sovBalance if you want those wallets.

---

## Usage

1. Open sovBalance
2. Click Add Wallet
3. Choose Bitcoin, Monero, or Zcash
4. Enter a wallet name
5. Bitcoin: paste an XPUB / YPUB / ZPUB
   Monero: paste a primary address, private view key, and optional restore height
   Zcash: paste a transparent t1 / t3 address, or a `uview1…` viewing key and optional birthday height

Balances refresh from your node. Monero wallets also refresh in the background, and spends drop off on their own.

---

## Privacy

No third-party balance APIs. No analytics. Bitcoin xpubs, Monero view keys, and Zcash addresses / viewing keys stay on your node.

A Zcash unified viewing key reveals the full account history to whoever holds it. It is stored in plaintext `wallets.json`, same as a Monero view key. Spend keys are never required.

USD display prices may be fetched from public price APIs. Wallet keys and balances are not sent with those requests.

---

## Architecture

Bitcoin wallets are derived locally and queried through Electrs. Monero wallets are opened as view-only wallets in a local `wallet-rpc` sidecar that talks to your Monero Node; sovBalance then reads the rings of the wallet's incoming transactions from the same Monero Node to detect spends. Zcash transparent balances are queried from your Zcash Node's lightwalletd. Shielded Zcash viewing keys are scanned by a local `zec-scan` helper that talks to the same lightwalletd.

XPUB / YPUB / ZPUB
↓ (local derivation)
sovBalance
↓ (TCP)
Electrs
↓
Bitcoin Core

Primary address + view key
↓ (view-only wallet)
wallet-rpc
↓
Monero Node
↑ (get_transactions: input rings of incoming txs)
sovBalance spend detection

Transparent t1 / t3 address
↓ (gRPC)
lightwalletd
↓
Zcash Node

Unified viewing key (`uview1…`)
↓
zec-scan
↓ (gRPC compact blocks)
lightwalletd
↓
Zcash Node

---

## Umbrel

- Electrs via `$APP_ELECTRS_NODE_IP`
- Monero Node via `$APP_MONERO_NODE_IP`, `$APP_MONERO_RPC_PORT`, `$APP_MONERO_RPC_USER`, and `$APP_MONERO_RPC_PASS` when that app is installed. The wallet-rpc sidecar syncs from it, and the app itself queries it (`MONERO_DAEMON_*`, HTTP digest auth) for spend detection
- Zcash Node via `$APP_ZCASH_NODE_IP` and `$APP_ZCASH_WALLET_PORT` when that app is installed
- Local `simple-monero-wallet-rpc` sidecar for view-only scanning
- No custom Docker networks. Umbrel handles service networking
- App state in `${APP_DATA_DIR}/data`
- Monero wallet-rpc files in `${APP_DATA_DIR}/monero-wallets`
- Monero spend-detection caches in `${APP_DATA_DIR}/data/monero`
- Shielded Zcash scan databases in `${APP_DATA_DIR}/data/zcash`
- Depends on the `electrs` Umbrel app. Monero Node and Zcash Node are optional

---

## Local development

```
npm install
cargo build --release --manifest-path zecscan/Cargo.toml
node server.js
```

`zcash.js` looks for `zec-scan` at `$ZEC_SCAN`, `/usr/local/bin/zec-scan`, or `zecscan/target/release/zec-scan`. Shielded wallets need `ZCASH_LWD_HOST` (and optional `ZCASH_LWD_PORT`, default 9067) pointing at lightwalletd.

Monero wallets need `WALLET_RPC_HOST` / `WALLET_RPC_PORT` for a `monero-wallet-rpc`, plus `MONERO_DAEMON_HOST` / `MONERO_DAEMON_PORT` / `MONERO_DAEMON_USER` / `MONERO_DAEMON_PASS` for the monerod it syncs from so spends can be detected. Without the daemon variables the plain view-only balance is shown. `node monero.js --self-test` exercises the key image parser and the spend classifier.

## Developers

Fork of [bitBalance](https://github.com/egzola/bitbalance) by egzola.

Maintained by nickpio.

https://github.com/nickpio/sovbalance

---

## License

MIT
