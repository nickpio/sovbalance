![Bitcoin](https://img.shields.io/badge/Bitcoin-self--hosted-orange)
![Monero](https://img.shields.io/badge/Monero-view--only-brightgreen)
![Umbrel](https://img.shields.io/badge/Runs%20on-Umbrel-blue)
![License](https://img.shields.io/badge/license-MIT-green)
 
# sovBalance
<img src="./web/logo.png">

Track your Bitcoin and Monero wallets privately from your own Umbrel.

A simple and private **wallet balance tracker** for Bitcoin XPUB / YPUB / ZPUB and Monero view-only wallets.

sovBalance allows you to monitor multiple wallets using **your own Electrs** and, for Monero, **your own Monero Node**, without relying on third-party balance APIs.

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
↓  
sovBalance  
↓  
Electrs / local wallet-rpc  
↓  
Bitcoin Core / Monero Node  

Your wallet data never leaves your infrastructure.

---

## Features

- Track multiple Bitcoin and Monero wallets
- Bitcoin: **XPUB, YPUB and ZPUB**
- Monero: **view-only** wallets (primary address + private view key)
- Import Monero **key images** after spending so spent outputs drop from the balance
- Connects to your **local Electrs** app, and to **Monero Node** when it is installed
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

---

## Installation

Install **sovBalance** directly from the Umbrel App Store.

After installation the app will automatically connect to your **Electrs** app. Install **Monero Node** and restart sovBalance if you want to track Monero wallets.

---

## Usage

1. Open sovBalance
2. Click **Add Wallet**
3. Choose **Bitcoin** or **Monero**
4. Enter a wallet name
5. Bitcoin: paste an **XPUB / YPUB / ZPUB**  
   Monero: paste a **primary address**, **private view key**, and optional **restore height**

The wallet balance will be tracked automatically.

After a Monero spend, import key images from **Edit Wallet** so spent outputs are no longer counted.

---

## Privacy

sovBalance is designed with privacy in mind.

- No third-party balance APIs
- No analytics
- No external wallet queries
- Bitcoin xpubs and Monero view keys stay on your node
- Spend keys are never required
- Everything runs locally on your node

USD display prices may be fetched from public price APIs. Wallet keys and balances are not sent with those requests.

---

## Architecture

Bitcoin wallets are derived locally and queried through Electrs. Monero wallets are opened as view-only wallets in a local `wallet-rpc` sidecar that talks to your Monero Node.

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

No external services are involved in balance scanning.

All balance calculations are deterministic and based solely on your node’s data.

---

## Umbrel Integration Details

This app is designed to run inside Umbrel’s managed environment.

- Uses the built-in Electrs service via `$APP_ELECTRS_NODE_IP`
- Uses the Monero Node app via `$APP_MONERO_NODE_IP`, `$APP_MONERO_RPC_PORT`, `$APP_MONERO_RPC_USER`, and `$APP_MONERO_RPC_PASS` when that app is installed
- Runs a local `simple-monero-wallet-rpc` sidecar for view-only scanning
- Does not define custom Docker networks (Umbrel handles service networking)
- Persists app state in `${APP_DATA_DIR}/data`
- Persists Monero wallet-rpc files in `${APP_DATA_DIR}/monero-wallets`
- Depends on the `electrs` Umbrel app. Monero Node is optional

These constraints ensure compatibility with Umbrel’s runtime and predictable behavior across installations.

---

## Design Principles

- Privacy by default (no external wallet queries)
- Deterministic behavior (no hidden state)
- Minimal dependencies
- Explicit over implicit

This project favors simplicity and control over abstraction.

---

## Developers

Fork of [bitBalance](https://github.com/egzola/bitbalance) by egzola.

Maintained by nickpio.

GitHub  
https://github.com/nickpio/sovbalance

---

## License

MIT
