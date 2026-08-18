![Bitcoin](https://img.shields.io/badge/Bitcoin-self--hosted-orange)
![Monero](https://img.shields.io/badge/Monero-view--only-brightgreen)
![Umbrel](https://img.shields.io/badge/Runs%20on-Umbrel-blue)
![License](https://img.shields.io/badge/license-MIT-green)
 
# sovBalance
<img src="./web/logo.png">

Track your Bitcoin and Monero wallets privately from your own Umbrel.

A simple and private **wallet balance tracker** for Bitcoin XPUB / YPUB / ZPUB and Monero view-only wallets.

sovBalance allows you to monitor multiple wallets using **your own Electrs and Monero Node**, without relying on third-party balance APIs.

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
- Connects to your **local Electrs** and **Monero Node** apps
- Combined USD total with per-asset amounts
- No third-party balance APIs
- Fully self-hosted
- Lightweight and simple interface
- Runs locally on **Umbrel**

---

## Screenshot

<img src="./web/screenshot.png" style="height:50%;width:50%;">

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

## Requirements

- Umbrel
- Electrs installed
- [Monero Node](https://apps.umbrel.com/app/monero) installed (for Monero wallets)

---

## Installation

Install **sovBalance** directly from the Umbrel App Store.

After installation the app will automatically connect to your **Electrs** and **Monero Node** apps.

---

## Usage

1. Open sovBalance
2. Click **Add Wallet**
3. Choose **Bitcoin** or **Monero**
4. Enter a wallet name
5. Bitcoin: paste an **XPUB / YPUB / ZPUB**  
   Monero: paste a **primary address**, **private view key**, and optional **restore height**

The wallet balance will be tracked automatically.

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
- Uses the Monero Node app via `$APP_MONERO_NODE_IP`, `$APP_MONERO_RPC_PORT`, `$APP_MONERO_RPC_USER`, and `$APP_MONERO_RPC_PASS`
- Runs a local `simple-monero-wallet-rpc` sidecar for view-only scanning
- Does not define custom Docker networks (Umbrel handles service networking)
- Persists app state in `${APP_DATA_DIR}/data`
- Persists Monero wallet-rpc files in `${APP_DATA_DIR}/monero-wallets`
- Depends on the `electrs` and `monero` Umbrel apps

These constraints ensure compatibility with Umbrel’s runtime and predictable behavior across installations.

---

## Design Principles

- Privacy by default (no external wallet queries)
- Deterministic behavior (no hidden state)
- Minimal dependencies
- Explicit over implicit

This project favors simplicity and control over abstraction.

---

## Developer

egzola

GitHub  
https://github.com/egzola

---

## License

MIT
