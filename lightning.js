// Lightning balances from an LND node over its REST API.
//
// A Lightning balance cannot be watched from a public key: it is channel
// state that only the node holds. sovBalance reads it with LND's
// readonly.macaroon, which can query balances but cannot move funds, and
// trusts only the node's own tls.cert.

const fs = require("fs")
const https = require("https")
const path = require("path")

const HOST = process.env.LND_REST_HOST || ""
const PORT = parseInt(process.env.LND_REST_PORT || "8080", 10)
const NETWORK = (process.env.LND_NETWORK || "mainnet").trim().toLowerCase()

const isDocker = fs.existsSync("/.dockerenv")
const LND_DIR = process.env.LND_DIR || (isDocker ? "/lnd" : path.join(__dirname, "data", "lnd"))
const TLS_CERT_PATH = process.env.LND_TLS_CERT_PATH || path.join(LND_DIR, "tls.cert")
const MACAROON_PATH = process.env.LND_MACAROON_PATH
  || path.join(LND_DIR, "data", "chain", "bitcoin", NETWORK, "readonly.macaroon")

const REQUEST_MS = 10000


function isConfigured() {
  return Boolean(HOST)
}


function readCredentials() {
  let cert
  try {
    cert = fs.readFileSync(TLS_CERT_PATH)
  } catch (e) {
    throw new Error(`Cannot read LND tls.cert at ${TLS_CERT_PATH}. Is the Lightning Node app running?`)
  }

  let macaroon = (process.env.LND_MACAROON_HEX || "").trim()
  if (!macaroon) {
    try {
      macaroon = fs.readFileSync(MACAROON_PATH).toString("hex")
    } catch (e) {
      throw new Error(`Cannot read LND readonly.macaroon at ${MACAROON_PATH}. Finish setting up the Lightning Node app first.`)
    }
  }

  return { cert, macaroon }
}


function lndGet(urlPath) {

  if (!isConfigured()) {
    return Promise.reject(new Error("Lightning Node is not configured. Install the Lightning Node app on Umbrel."))
  }

  let creds
  try {
    creds = readCredentials()
  } catch (e) {
    return Promise.reject(e)
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST,
      port: PORT,
      path: urlPath,
      method: "GET",
      headers: { "Grpc-Metadata-macaroon": creds.macaroon, Accept: "application/json" },
      // The certificate is pinned, so its hostname (the Umbrel's device
      // name) does not need to match the IP we connect to.
      ca: creds.cert,
      checkServerIdentity: () => undefined,
      timeout: REQUEST_MS
    }, res => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", chunk => { body += chunk })
      res.on("end", () => {
        let data = null
        try {
          data = body ? JSON.parse(body) : {}
        } catch (e) {
          return reject(new Error(`LND returned invalid JSON (HTTP ${res.statusCode})`))
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(lndErrorMessage(res.statusCode, data)))
        }
        resolve(data)
      })
    })

    req.on("timeout", () => req.destroy(new Error("LND request timed out")))
    req.on("error", e => reject(connectionError(e)))
    req.end()
  })

}


function lndErrorMessage(status, data) {
  const msg = String((data && (data.message || data.error)) || "").trim()
  if (/wallet locked|unlock/i.test(msg)) {
    return "LND wallet is locked. Unlock it in the Lightning Node app."
  }
  if (/starting up|not yet ready|in the process of starting/i.test(msg)) {
    return "LND is still starting up. Try again in a minute."
  }
  if (/permission denied|verification failed|cannot get macaroon/i.test(msg)) {
    return "LND rejected the macaroon: " + msg
  }
  return msg ? `LND error: ${msg}` : `LND request failed (HTTP ${status})`
}


function connectionError(e) {
  if (e.code === "ECONNREFUSED" || e.code === "EHOSTUNREACH" || e.code === "ENOTFOUND") {
    return new Error(`Cannot reach LND at ${HOST}:${PORT}. Is the Lightning Node app running?`)
  }
  if (/certificate|self.signed|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(e.code || e.message || "")) {
    return new Error("LND's TLS certificate does not match tls.cert. Restart sovBalance after the Lightning Node app regenerates it.")
  }
  return e
}


// LND encodes uint64 fields as strings; sat amounts fit a double exactly.
function sats(value) {
  if (value && typeof value === "object") value = value.sat
  const n = Number(value || 0)
  return Number.isFinite(n) ? n : 0
}


// Pure: turns the four LND responses into a breakdown, in sats.
//
// Channel funds: local balance of open channels plus funds committed to
// channels that are still opening. Closing funds: what force-closed channels
// still have locked in timelocked outputs. Cooperative and waiting closes are
// left out of `closing` because LND keeps counting them in the open-channel
// balance until the close confirms, and counting them twice would overstate
// the total. On-chain funds are the node's own wallet, confirmed and
// unconfirmed, and only count when the wallet entry asks for them.
function summarize({ info, channels, onchain, pending }, includeOnchain) {

  const forceClosing = (pending && pending.pending_force_closing_channels) || []

  const breakdown = {
    channels: sats(channels && channels.local_balance) || sats(channels && channels.balance),
    opening: sats(channels && channels.pending_open_local_balance) || sats(channels && channels.pending_open_balance),
    closing: forceClosing.reduce((sum, c) => sum + sats(c.limbo_balance), 0),
    onchain: sats(onchain && onchain.confirmed_balance),
    onchainUnconfirmed: sats(onchain && onchain.unconfirmed_balance)
  }

  const totalSats = breakdown.channels + breakdown.opening + breakdown.closing
    + (includeOnchain ? breakdown.onchain + breakdown.onchainUnconfirmed : 0)

  return {
    balance: totalSats / 1e8,
    lightning: {
      ...breakdown,
      includeOnchain: !!includeOnchain,
      alias: (info && info.alias) || "",
      synced: !!(info && info.synced_to_chain),
      activeChannels: Number((info && info.num_active_channels) || 0),
      pendingChannels: Number((info && info.num_pending_channels) || 0)
    }
  }

}


function infoNetwork(info) {
  const chain = info && Array.isArray(info.chains) && info.chains[0]
  return chain && chain.network ? String(chain.network).toLowerCase() : ""
}


async function getWalletBalance(w) {

  const [info, channels, onchain, pending] = await Promise.all([
    lndGet("/v1/getinfo"),
    lndGet("/v1/balance/channels"),
    lndGet("/v1/balance/blockchain"),
    lndGet("/v1/channels/pending")
  ])

  const network = infoNetwork(info)
  if (network && network !== NETWORK) {
    throw new Error(`LND is running on ${network}, but sovBalance expects ${NETWORK}.`)
  }

  return summarize({ info, channels, onchain, pending }, w.includeOnchain !== false)

}


async function ping() {
  try {
    const info = await lndGet("/v1/getinfo")
    return { ok: true, alias: info.alias || "", network: infoNetwork(info) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}


function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value === "boolean") return value
  return !/^(false|0|off|no)$/i.test(String(value).trim())
}


function validateLightningWallet(body) {
  return { includeOnchain: parseBool(body.includeOnchain, true) }
}


module.exports = {
  isConfigured,
  ping,
  summarize,
  validateLightningWallet,
  getWalletBalance
}


if (require.main === module && process.argv[2] === "--self-test") {

  const assert = require("assert")

  const sample = {
    info: { alias: "umbrel", synced_to_chain: true, num_active_channels: 2, num_pending_channels: 2, chains: [{ chain: "bitcoin", network: "mainnet" }] },
    channels: {
      balance: "150000",
      local_balance: { sat: "150000", msat: "150000000" },
      pending_open_balance: "20000",
      pending_open_local_balance: { sat: "20000", msat: "20000000" }
    },
    onchain: { total_balance: "51000", confirmed_balance: "50000", unconfirmed_balance: "1000" },
    pending: {
      total_limbo_balance: "35000",
      pending_force_closing_channels: [{ limbo_balance: "30000", recovered_balance: "0" }],
      waiting_close_channels: [{ limbo_balance: "5000" }]
    }
  }

  const withOnchain = summarize(sample, true)
  assert.strictEqual(withOnchain.lightning.channels, 150000)
  assert.strictEqual(withOnchain.lightning.opening, 20000)
  // waiting_close funds stay in the channel balance until the close confirms
  assert.strictEqual(withOnchain.lightning.closing, 30000)
  assert.strictEqual(withOnchain.balance, (150000 + 20000 + 30000 + 50000 + 1000) / 1e8)
  assert.strictEqual(withOnchain.lightning.alias, "umbrel")
  assert.strictEqual(withOnchain.lightning.synced, true)

  const withoutOnchain = summarize(sample, false)
  assert.strictEqual(withoutOnchain.balance, (150000 + 20000 + 30000) / 1e8)
  assert.strictEqual(withoutOnchain.lightning.onchain, 50000)

  // Older LND without the *_local_balance objects
  const legacy = summarize({ info: {}, channels: { balance: "7", pending_open_balance: "3" }, onchain: {}, pending: {} }, true)
  assert.strictEqual(legacy.balance, 10 / 1e8)

  const empty = summarize({ info: {}, channels: {}, onchain: {}, pending: {} }, true)
  assert.strictEqual(empty.balance, 0)

  assert.strictEqual(validateLightningWallet({}).includeOnchain, true)
  assert.strictEqual(validateLightningWallet({ includeOnchain: false }).includeOnchain, false)
  assert.strictEqual(validateLightningWallet({ includeOnchain: "false" }).includeOnchain, false)
  assert.strictEqual(validateLightningWallet({ includeOnchain: "true" }).includeOnchain, true)

  console.log("lightning self-test ok")

}
