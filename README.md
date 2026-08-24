![Bitcoin](https://img.shields.io/badge/Bitcoin-self--hosted-orange)
![Monero](https://img.shields.io/badge/Monero-view--only-brightgreen)
![Zcash](https://img.shields.io/badge/Zcash-shielded-yellow)
![Umbrel](https://img.shields.io/badge/Runs%20on-Umbrel-blue)
![License](https://img.shields.io/badge/license-MIT-green)
 
# sovBalance
<img src="./web/logo.png">

Track your Bitcoin, Monero, and Zcash wallets privately from your own Umbrel.

A simple and private **wallet balance tracker** for Bitcoin XPUB / YPUB / ZPUB, Monero view-only wallets, and Zcash transparent addresses or unified viewing keys.

sovBalance allows you to monitor multiple wallets using **your own Electrs**, and optionally **your own Monero Node** and **Zcash Node**, without relying on third-party balance APIs.

Runs locally on **Umbrel** and keeps all wallet data private.

---

## Why sovBalance?

Many wallet tracking services require sending your XPUB or Monero view key to external servers.

This exposes:

- all wallet addresses
- wallet balances
- transaction history

sovBalance avoids this by connecting **only to your own node**.

Bitcoin: XPUB / YPUB / ZPUB  
Monero: primary address + private view key  
Zcash: transparent t1 / t3 address or unified viewing key (`uview1…`)  
↓  
sovBalance  
↓  
Electrs / local wallet-rpc / lightwalletd  
↓  
Bitcoin Core / Monero Node / Zcash Node  

Your wallet data never leaves your infrastructure.

---

## Features

- Track multiple Bitcoin, Monero, and Zcash wallets
- Bitcoin: **XPUB, YPUB and ZPUB**
- Monero: **view-only** wallets (primary address + private view key)
- Zcash: **transparent** mainnet addresses (`t1` / `t3`) and **shielded** unified viewing keys (`uview1…`)
- Import Monero **key images** after spending so spent outputs drop from the balance
- Connects to your **local Electrs** app, and to **Monero Node** or **Zcash Node** when those apps are installed
- Combined USD total with per-asset amounts
- No third-party balance APIs
- Fully self-hosted
- Lightweight and simple interface
- Runs locally on **Umbrel**

---

## Supported Wallet Types

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

View-only wallets can see received outputs, including subaddresses. Spent funds still count toward the balance until key images are imported. Set a restore height from around when the wallet was created to avoid a full-chain scan.

### Zcash

| Type | What you enter |
|-----|------|
| Transparent | Mainnet `t1` or `t3` address (35 characters) |
| Shielded | Mainnet unified viewing key (`uview1…`) + optional birthday height |

Balances come from your Zcash Node's lightwalletd. Shielded wallets are scanned locally with a `zec-scan` helper: the viewing key trial-decrypts Sapling and Orchard outputs and tracks spends via nullifiers. Incoming-only keys (`uivk1…`) are rejected because they cannot detect spends.

Birthday height defaults to NU5 activation (1,687,104, May 2022). Set it earlier only if this wallet received funds before then; it cannot go below Sapling activation (419,200). The first shielded sync can take a long time and is saved to disk, so the next rescan continues where it left off.

---

## Key images

A view-only wallet cannot tell which outputs have been spent. After you spend from the wallet that has the spend key, export key images and import them in sovBalance so the balance can drop.

1. Spend from your full / spend wallet as usual
2. Export key images from that same spend wallet  
   Monero GUI: **Settings → Wallet → Export key images**  
   Feather: **File → Export → Key images**
3. In sovBalance, open **Edit Wallet** on the matching Monero wallet
4. Attach the export file, or paste `export_key_images` JSON, and save

Incoming funds do not need this. Re-export and import again after each spend. The file is encrypted with the view key, so it must come from the spend wallet for the same address.

---

## Requirements

- Umbrel
- Electrs installed
- [Monero Node](https://apps.umbrel.com/app/monero) installed only if you track Monero wallets
- [Zcash Node](https://github.com/nickpio/umbrel-zcash) installed only if you track Zcash wallets

---

## Installation

Install **sovBalance** directly from the Umbrel App Store.

After installation the app will automatically connect to your **Electrs** app. Install **Monero Node** and/or **Zcash Node** and restart sovBalance if you want to track those wallets.

---

## Usage

1. Open sovBalance
2. Click **Add Wallet**
3. Choose **Bitcoin**, **Monero**, or **Zcash**
4. Enter a wallet name
5. Bitcoin: paste an **XPUB / YPUB / ZPUB**  
   Monero: paste a **primary address**, **private view key**, and optional **restore height**  
   Zcash: paste a transparent **t1 / t3** address, or a **uview1…** viewing key and optional birthday height

The wallet balance will be tracked automatically.

After a Monero spend, import key images from **Edit Wallet** so spent outputs are no longer counted.

---

## Privacy

sovBalance is designed with privacy in mind.

- No third-party balance APIs
- No analytics
- No external wallet queries
- Bitcoin xpubs, Monero view keys, and Zcash addresses / viewing keys stay on your node
- A Zcash unified viewing key reveals the full account history to whoever holds it, and is stored in plaintext `wallets.json` like a Monero view key
- Spend keys are never required
- Everything runs locally on your node

USD display prices may be fetched from public price APIs. Wallet keys and balances are not sent with those requests.

---

## Architecture

Bitcoin wallets are derived locally and queried through Electrs. Monero wallets are opened as view-only wallets in a local `wallet-rpc` sidecar that talks to your Monero Node. Zcash transparent balances are queried from your Zcash Node's lightwalletd. Shielded Zcash viewing keys are scanned by a local `zec-scan` helper that talks to the same lightwalletd.

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

No external services are involved in balance scanning.

All balance calculations are deterministic and based solely on your node’s data.

---

## Umbrel Integration Details

This app is designed to run inside Umbrel’s managed environment.

- Uses the built-in Electrs service via `$APP_ELECTRS_NODE_IP`
- Uses the Monero Node app via `$APP_MONERO_NODE_IP`, `$APP_MONERO_RPC_PORT`, `$APP_MONERO_RPC_USER`, and `$APP_MONERO_RPC_PASS` when that app is installed
- Uses the Zcash Node app via `$APP_ZCASH_NODE_IP` and `$APP_ZCASH_WALLET_PORT` when that app is installed
- Runs a local `simple-monero-wallet-rpc` sidecar for view-only scanning
- Does not define custom Docker networks (Umbrel handles service networking)
- Persists app state in `${APP_DATA_DIR}/data`
- Persists Monero wallet-rpc files in `${APP_DATA_DIR}/monero-wallets`
- Persists shielded Zcash scan databases in `${APP_DATA_DIR}/data/zcash`
- Depends on the `electrs` Umbrel app. Monero Node and Zcash Node are optional

These constraints ensure compatibility with Umbrel’s runtime and predictable behavior across installations.

---

## Design Principles

- Privacy by default (no external wallet queries)
- Deterministic behavior (no hidden state)
- Minimal dependencies
- Explicit over implicit

This project favors simplicity and control over abstraction.

---

## Local development

```
npm install
cargo build --release --manifest-path zecscan/Cargo.toml
node server.js
```

`zcash.js` looks for `zec-scan` at `$ZEC_SCAN`, `/usr/local/bin/zec-scan`, or `zecscan/target/release/zec-scan`. Shielded wallets need `ZCASH_LWD_HOST` (and optional `ZCASH_LWD_PORT`, default 9067) pointing at lightwalletd.

## Developers

Fork of [bitBalance](https://github.com/egzola/bitbalance) by egzola.

Maintained by nickpio.

GitHub  
https://github.com/nickpio/sovbalance

---

## License

MIT
