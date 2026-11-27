<a id="top"></a>

<div align="center">

<img src="./web/logo.png" alt="sovBalance logo" width="112">

# sovBalance

**A self-hosted wallet balance dashboard for Umbrel.**<br>
Track Bitcoin, Monero, and Zcash using the node services you run. Your wallet keys stay on your server.

<br>

[![Bitcoin](https://img.shields.io/badge/Bitcoin-self--hosted-f7931a?style=for-the-badge&logo=bitcoin&logoColor=white)](#supported-wallets)
[![Monero](https://img.shields.io/badge/Monero-view--only-f26822?style=for-the-badge)](#supported-wallets)
[![Zcash](https://img.shields.io/badge/Zcash-shielded-f4b728?style=for-the-badge)](#supported-wallets)
[![Umbrel](https://img.shields.io/badge/Runs%20on-Umbrel-3b82f6?style=for-the-badge)](#installation)
[![License](https://img.shields.io/badge/license-MIT-0f766e?style=for-the-badge)](#license)

[**Features**](#features) &nbsp;·&nbsp; [**Install**](#installation) &nbsp;·&nbsp; [**Usage**](#usage) &nbsp;·&nbsp; [**Privacy**](#privacy) &nbsp;·&nbsp; [**Development**](#local-development) &nbsp;·&nbsp; [**License**](#license)

</div>

<br>

## Overview

sovBalance puts your Bitcoin, Monero, and Zcash wallets on one dashboard, with each asset and a combined USD total. At startup it finds the node apps you have installed, and only currencies backed by those services appear.

Bitcoin: XPUB / YPUB / ZPUB<br>
Monero: primary address + private view key<br>
Zcash: transparent t1 / t3 address or unified viewing key (`uview1…`)

↓
sovBalance
↓
Electrs, Fulcrum, or ElectrumX / local wallet-rpc / lightwalletd
↓
Bitcoin Core / Monero Node / Zcash Node

## Features

- Track Bitcoin, Monero, and Zcash wallets together, with per-asset and combined USD totals.
- Derive Bitcoin addresses locally and query your Electrum server.
- Scan Monero view-only wallets and detect most spends from transaction rings.
- Scan Zcash unified viewing keys locally through your Zcash Node's lightwalletd.
- Keep wallet data on your Umbrel. No third-party balance APIs or analytics.

<p align="right"><a href="#top">back to top</a></p>

---

## Supported wallets

### Bitcoin

| Type | Standard | Script |
|-----|------|------|
| XPUB | BIP44 | Legacy |
| YPUB | BIP49 | Nested SegWit |
| ZPUB | BIP84 | Native SegWit |

Addresses are derived locally and scanned against your Electrum server (Electrs, Fulcrum, or ElectrumX) with a gap limit of 20.

### Monero

| Type | What you enter |
|-----|------|
| View-only | Mainnet primary address (starts with `4`, 95 characters) + private view key |

View-only wallets see received outputs, including subaddresses. Set a restore height near when the wallet was created to skip a full-chain scan.

**Spend detection:** a view key can't compute key images, so the wallet never sees its own outgoing transactions. Instead, sovBalance checks each transaction that pays the wallet and asks your Monero Node for its input rings. A transaction counts as a spend when:

- Every input ring contains one of the wallet's own outputs.
- The change returned to the wallet plus the fee is covered by the matched outputs.

Matched outputs are then removed from the balance. Confirmed-transaction verdicts are cached under `data/monero`. Mempool transactions are checked too, so spends appear shortly after broadcast.

Monero wallets refresh on a timer (`XMR_REFRESH_SECONDS`, default 120, `0` disables), so balances update without a manual Sync.

**Limits:**

- A sweep, or an exact-amount spend with no change output, returns nothing to the wallet, so it isn't detected. Import key images after those.
- If one ring contains several of the wallet's outputs, all of them count as spent. The balance errs low, never high.
- A payment whose ring uses one of the wallet's outputs as a decoy can look like a spend. The amount check rejects it when that output is too small to have funded the payment and fee. Importing key images fixes the rest.
- Pre-RingCT inputs are ignored.

### Zcash

| Type | What you enter |
|-----|------|
| Transparent | Mainnet `t1` or `t3` address (35 characters) |
| Shielded | Mainnet unified viewing key (`uview1…`) + optional birthday height |

Transparent balances come from your Zcash Node's lightwalletd. Shielded wallets are scanned locally by a `zec-scan` helper. The viewing key trial-decrypts Sapling and Orchard outputs and tracks spends via nullifiers. Incoming-only keys (`uivk1…`) are rejected because they can't detect spends.

The birthday height defaults to NU5 activation (1,687,104, May 2022). Set it earlier only if the wallet received funds before then. It can't go below Sapling activation (419,200). The first shielded sync can take a long time, but progress is saved to disk, so the next rescan picks up where it left off.

---

## Key images

Key images are optional. Import them after a sweep with no change output, or whenever you want an exact balance.

1. Spend from your full / spend wallet as usual.
2. Export key images from that same wallet.
   Monero GUI: Settings → Wallet → Export key images
   Feather: File → Export → Key images
3. In sovBalance, open Edit Wallet on the matching Monero wallet.
4. Attach the export file, or paste `export_key_images` JSON, and save.

Incoming funds don't need this. Outputs covered by imported key images are settled by the wallet, and ring analysis applies only to outputs received after the export. The file is encrypted with the view key, so it must come from the spend wallet for the same address.

---

## Requirements

- Umbrel
- At least one of:
  - [Electrs](https://apps.umbrel.com/app/electrs), [Fulcrum](https://apps.umbrel.com/app/fulcrum), or [ElectrumX](https://apps.umbrel.com/app/electrumx) for Bitcoin wallets
  - [Monero Node](https://apps.umbrel.com/app/monero) for Monero wallets
  - [Zcash Node](https://github.com/nickpio/umbrel-zcash) for Zcash wallets

---

## Installation

sovBalance is distributed through [nickpio/umbrel-app-store](https://github.com/nickpio/umbrel-app-store).

1. In Umbrel, add `nickpio/umbrel-app-store` as a community app store.
2. Install sovBalance from that store.

On startup, sovBalance detects your Electrum server, Monero Node, and Zcash Node and lists the currencies they serve. After installing or removing a node app, restart sovBalance to update the list.

---

## Usage

1. Open sovBalance.
2. Click **Add Wallet**.
3. Choose Bitcoin, Monero, or Zcash.
4. Enter a wallet name.
5. Enter the wallet details:
   - **Bitcoin:** an XPUB / YPUB / ZPUB.
   - **Monero:** a primary address, private view key, and optional restore height.
   - **Zcash:** a transparent t1 / t3 address, or a `uview1…` viewing key with an optional birthday height.

Click **Refresh** to update prices, or **Sync** to update linked wallet balances from their nodes. Monero wallets also refresh in the background, and spends drop off on their own.

Sort the table by name, share of the total (%), or currency using the buttons above it. Click the active button again to reverse the order. Your choice is remembered in the browser.

---

## Privacy

No third-party balance APIs. No analytics. Bitcoin xpubs, Monero view keys, and Zcash addresses and viewing keys stay on your node.

A Zcash unified viewing key reveals the full account history to whoever holds it. It's stored in plaintext in `wallets.json`, the same as a Monero view key. Spend keys are never required.

USD prices may be fetched from public price APIs. Wallet keys and balances are not sent with those requests.

---

## Architecture

- **Bitcoin:** wallets are derived locally and queried through your Electrum server (Electrs, Fulcrum, or ElectrumX).
- **Monero:** wallets open as view-only wallets in a local `wallet-rpc` sidecar that talks to your Monero Node. sovBalance also reads the rings of incoming transactions from the same node to detect spends.
- **Zcash (transparent):** balances are queried from lightwalletd over gRPC.
- **Zcash (shielded):** a local `zec-scan` helper scans compact blocks from lightwalletd using your viewing key.

```
XPUB / YPUB / ZPUB
↓ (local derivation)
sovBalance
↓ (TCP)
Electrs / Fulcrum / ElectrumX
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
```

---

## Umbrel

- **Electrum server:** uses `$APP_ELECTRS_NODE_IP` and `$APP_ELECTRS_NODE_PORT` from whichever of Electrs, Fulcrum, or ElectrumX is installed. Fulcrum and ElectrumX export the same variables as Electrs, and the first one found wins.
- **Monero Node:** uses `$APP_MONERO_NODE_IP`, `$APP_MONERO_RPC_PORT`, `$APP_MONERO_RPC_USER`, and `$APP_MONERO_RPC_PASS`. The wallet-rpc sidecar syncs from it, and the app queries it (`MONERO_DAEMON_*`, HTTP digest auth) for spend detection.
- **Zcash Node:** uses `$APP_ZCASH_NODE_IP` and `$APP_ZCASH_WALLET_PORT`.
- **Local `simple-monero-wallet-rpc` sidecar** handles view-only scanning.
- **Networking:** no custom Docker networks. Umbrel handles service networking.
- **Storage:**
  - App state: `${APP_DATA_DIR}/data`
  - Monero wallet-rpc files: `${APP_DATA_DIR}/monero-wallets`
  - Monero spend-detection caches: `${APP_DATA_DIR}/data/monero`
  - Shielded Zcash scan databases: `${APP_DATA_DIR}/data/zcash`
- **Dependencies:** none are required. `exports.sh` loads the Electrum server, Monero Node, and Zcash Node variables when those apps are installed, and `GET /nodes` reports which ones were found.

---

## Local development

```
npm install
cargo build --release --manifest-path zecscan/Cargo.toml
node server.js
```

- **Bitcoin:** set `ELECTRUM_HOST` (and optionally `ELECTRUM_PORT`, default 50001) to point at an Electrum server.
- **Zcash:** `zcash.js` looks for `zec-scan` at `$ZEC_SCAN`, `/usr/local/bin/zec-scan`, or `zecscan/target/release/zec-scan`. Shielded wallets need `ZCASH_LWD_HOST` (and optionally `ZCASH_LWD_PORT`, default 9067) pointing at lightwalletd.
- **Monero:** set `WALLET_RPC_HOST` / `WALLET_RPC_PORT` for a `monero-wallet-rpc`. For spend detection, also set `MONERO_DAEMON_HOST` / `MONERO_DAEMON_PORT` / `MONERO_DAEMON_USER` / `MONERO_DAEMON_PASS` for the monerod it syncs from. Leave the daemon variables unset for a plain view-only balance. Setting `MONERO_DAEMON_HOST` to an empty string (as the Umbrel compose file does when Monero Node isn't installed) hides Monero entirely.
- Currencies whose variables are unset are hidden in the UI.
- `node monero.js --self-test` runs the key image parser and spend classifier tests.

---

## Developers

Fork of [bitBalance](https://github.com/egzola/bitbalance) by egzola.

Maintained by nickpio: https://github.com/nickpio/sovbalance

---

## License

MIT
