const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ElectrumClient = require('electrum-client');

const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const bip32 = BIP32Factory(ecc);

const { zpubToXpub, ypubToXpub } = require('./derive');
const monero = require('./monero');
const zcash = require('./zcash');


const isDocker = fs.existsSync("/.dockerenv");

const appVersion = require('./package.json').version || "1.0.0";

const HOST = process.env.ELECTRUM_HOST || "";
const PORT = parseInt(process.env.ELECTRUM_PORT || "50001", 10);

const appPort = process.env.PORT || 3710;

const DATA_DIR = isDocker ? "/data" : __dirname + "/data";
const DATA_FILE = DATA_DIR + "/wallets.json";


const app = express();

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('web'));

let wallets = [];
let electrum = null;
let electrumConnecting = false;
let electrumReconnectTimer = null;
let electrumError = null

// Problems the UI should show that are not tied to a single wallet.
// Each is a message string or null.
const serverIssues = {
  storage: null,
  storageInit: null
}

console.log("DATA_DIR:", DATA_DIR)
console.log("DATA_FILE:", DATA_FILE)
console.log("uid:", typeof process.getuid === "function" ? process.getuid() : "n/a")

function ensureDataWritable() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK)
  } catch {
    try {
      fs.chmodSync(DATA_DIR, 0o777)
    } catch (e) {
      console.error("DATA DIR NOT WRITABLE:", e)
    }
  }
  if (fs.existsSync(DATA_FILE)) {
    try {
      fs.accessSync(DATA_FILE, fs.constants.W_OK)
    } catch {
      try {
        fs.chmodSync(DATA_FILE, 0o666)
      } catch (e) {
        console.error("DATA FILE NOT WRITABLE:", e)
      }
    }
  }
}

try {
  ensureDataWritable()
  console.log("dir ensured")

  if (!fs.existsSync(DATA_FILE)) {
    console.log("creating wallets.json...")
    fs.writeFileSync(DATA_FILE, "[]")
  }

} catch (e) {
  console.error("INIT FS ERROR:", e)
  serverIssues.storageInit = "Could not prepare the data directory (" + (e.code || e.message) + "). Wallet changes may not be saved."
}

function normalizeStoredWallet(w) {
  if (!w.type) {
    w.type = w.address ? "xmr" : "btc"
  }
  return w
}

// On a read or parse failure the wallets already in memory are kept, so a
// damaged wallets.json never shows up as an empty list (which the next save
// would then write back over the file). A file that cannot be parsed is
// copied aside once so nothing is lost.
let corruptBackupFor = null
let corruptBackupName = null

function loadWallets() {
  let raw
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8')
  } catch (e) {
    if (e.code === "ENOENT") {
      wallets = []
      serverIssues.storage = null
      return
    }
    console.error("READ ERROR:", e)
    serverIssues.storage = "Could not read wallets.json (" + (e.code || e.message) + ")"
    return
  }

  try {
    const parsed = JSON.parse(raw || "[]")
    if (!Array.isArray(parsed)) {
      throw new Error("expected a list of wallets")
    }
    wallets = parsed.map(normalizeStoredWallet)
    serverIssues.storage = null
  } catch (e) {
    console.error("PARSE ERROR:", e)
    if (corruptBackupFor !== raw) {
      const backup = DATA_FILE + ".corrupt-" + Date.now()
      try {
        fs.writeFileSync(backup, raw)
        corruptBackupFor = raw
        corruptBackupName = backup.split("/").pop()
      } catch (be) {
        console.error("BACKUP ERROR:", be)
        corruptBackupName = null
      }
    }
    const note = corruptBackupName ? " A copy was saved as " + corruptBackupName + "." : ""
    serverIssues.storage = "wallets.json is damaged and could not be read (" + e.message + ")." + note
  }
}

loadWallets()


function saveWallets() {
  const toSave = wallets.map(w => {
    const copy = { ...w }
    delete copy.error
    if (copy.sync && Number(copy.sync.percent) >= 100) {
      delete copy.sync
    }
    return copy
  })
  const payload = JSON.stringify(toSave, null, 2)
  try {
    writeFileAtomic(DATA_FILE, payload)
  } catch (e) {
    if (e.code !== "EACCES") {
      serverIssues.storage = "Could not save wallets (" + (e.code || e.message) + ")"
      throw e
    }
    ensureDataWritable()
    try {
      writeFileAtomic(DATA_FILE, payload)
    } catch (e2) {
      serverIssues.storage = "Could not save wallets (" + (e2.code === "EACCES" ? "permission denied" : (e2.code || e2.message)) + ")"
      throw e2
    }
  }
  serverIssues.storage = null
}

// Write to a temp file and rename so a crash mid-write cannot leave a
// truncated wallets.json behind.
function writeFileAtomic(file, data) {
  const tmp = file + ".tmp"
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { }
    // Some mounts refuse rename; fall back to a direct write.
    if (e.code === "EXDEV" || e.code === "EPERM" || e.code === "EBUSY") {
      fs.writeFileSync(file, data)
      return
    }
    throw e
  }
}

function saveWalletsToResponse(res) {
  try {
    saveWallets()
    return true
  } catch (e) {
    console.error("WRITE ERROR:", e)
    res.status(500).json({ error: e.code === "EACCES" ? "Could not save wallets (permission denied)" : "Could not save wallets" })
    return false
  }
}


function walletType(w) {
  return w.type || "btc"
}


function electrumConfigured() {
  return Boolean(HOST)
}


function closeElectrum() {
  if (!electrum) return
  try {
    electrum.onClose = () => {}
    electrum.close()
  } catch (e) {}
  electrum = null
}

function scheduleElectrumReconnect() {
  if (electrumReconnectTimer) return
  electrumReconnectTimer = setTimeout(() => {
    electrumReconnectTimer = null
    connectElectrum()
  }, 5000)
}

async function connectElectrum() {

  if (!electrumConfigured() || electrumConnecting) return
  electrumConnecting = true

  if (electrumReconnectTimer) {
    clearTimeout(electrumReconnectTimer)
    electrumReconnectTimer = null
  }

  closeElectrum()

  try {

    const client = new ElectrumClient(PORT, HOST, 'tcp')

    client.onClose = () => {
      console.log("Electrum disconnected")
      if (electrum === client) electrum = null
      electrumError = "Connection to the Electrum server was lost. Reconnecting…"
      scheduleElectrumReconnect()
    }

    electrum = client

    await client.connect()

    await client.server_version("bitBalance", "1.4")

    console.log("Electrum connected")
    electrumError = null

  } catch (e) {

    console.error("Electrum connect error:", e)
    electrumError = `Could not connect to the Electrum server at ${HOST}:${PORT} (${e.code || e.message || "unknown error"}). Retrying…`
    closeElectrum()
    scheduleElectrumReconnect()

  } finally {
    electrumConnecting = false
  }

}


function addressToScriptHash(address) {

  const script = bitcoin.address.toOutputScript(
    address,
    bitcoin.networks.bitcoin
  )

  const hash = crypto
    .createHash('sha256')
    .update(script)
    .digest()

  return Buffer.from(hash.reverse()).toString('hex')
}



async function getAddressBalance(address) {
  const client = electrum
  if (!client) {
    throw new Error("Electrum server is not connected")
  }
  const sh = addressToScriptHash(address)
  const utxos = await client.blockchainScripthash_listunspent(sh)
  return (utxos || []).reduce((total, u) => total + u.value, 0)
}

// One retry per address. A lookup that still fails aborts the scan: counting
// it as an empty address would report a balance that is silently too low.
async function getAddressBalanceRetry(address) {
  try {
    return await withTimeout(getAddressBalance(address))
  } catch (first) {
    await new Promise(r => setTimeout(r, 250))
    try {
      return await withTimeout(getAddressBalance(address))
    } catch (e) {
      const reason = e && e.message === "timeout" ? "timed out" : (e && e.message) || "failed"
      throw new Error("Electrum lookup " + reason)
    }
  }
}


function validateKey(key) {
  if (key.length < 100) {
    throw new Error("Invalid XPUB/ZPUB length")
  }
}


const PAYMENT_BUILDERS = {
  p2wpkh: pubkey => bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.bitcoin }),
  p2sh: pubkey => bitcoin.payments.p2sh({
    redeem: bitcoin.payments.p2wpkh({ pubkey, network: bitcoin.networks.bitcoin })
  }),
  p2pkh: pubkey => bitcoin.payments.p2pkh({ pubkey, network: bitcoin.networks.bitcoin })
}


async function scanBranch(root, change, type) {

  if (type === "auto") {
    throw new Error("scanBranch must receive a single type")
  }

  const buildPayment = PAYMENT_BUILDERS[type]
  if (!buildPayment) {
    throw new Error("Invalid address type")
  }

  const branch = root.derive(change)

  let index = 0
  let gap = 0
  let total = 0

  const concurrency = 10; // número de endereços a serem processados em paralelo. Aumentar esse número pode acelerar a varredura, mas também pode causar mais carga no Electrum e aumentar o risco de timeouts. Ajuste conforme necessário para encontrar um equilíbrio entre velocidade e estabilidade.
  const gapLimit = 20;

  while (gap < gapLimit) {

    const batch = []

    for (let i = 0; i < concurrency; i++) {
      const child = branch.derive(index++)
      batch.push(buildPayment(child.publicKey).address)
    }

    const balances = await Promise.all(batch.map(getAddressBalanceRetry))

    for (const balance of balances) {
      gap = balance > 0 ? 0 : gap + 1
      total += balance
    }

    await new Promise(r => setTimeout(r, 10)); // pequena pausa para evitar sobrecarregar o Electrum com muitas requisições em sequência
  }

  return total / 100000000;
}




function normalizeXpub(key) {

  key = key.trim()

  if (key.startsWith("zpub")) {
    return {
      type: "p2wpkh",
      key: zpubToXpub(key)
    }
  }

  if (key.startsWith("ypub")) {
    return {
      type: "p2sh",
      key: ypubToXpub(key)
    }
  }

  if (key.startsWith("xpub")) {
    return {
      type: "auto",
      key: key
    }
  }

  throw new Error("Unsupported key prefix")
}


async function getWalletBalance(xpub) {
  let total = 0

  const info = normalizeXpub(xpub)

  let root
  try {
    root = bip32.fromBase58(info.key, bitcoin.networks.bitcoin)
  } catch (e) {
    throw new Error("Invalid extended public key: " + e.message)
  }

  const types = info.type === "auto"
    ? ["p2pkh", "p2wpkh", "p2sh"]
    : [info.type]

  for (const t of types) {
    total += await scanBranch(root, 0, t)
    total += await scanBranch(root, 1, t)
  }

  return total
}






function applyZecSync(w, parsed) {
  if (!parsed) return
  if (parsed.total !== undefined) {
    const total = Number(parsed.total) / 1e8
    if (Number.isFinite(total)) {
      w.balance = total
    }
  }
  w.sync = zcash.syncSnapshot(parsed, w)
  delete w.error
}


async function scanWallet(w) {

  if (walletType(w) === "xmr") {

    try {
      const result = await monero.getWalletBalance(w)
      w.balance = result.balance
      w.autoSpends = result.autoSpends
      delete w.error
    } catch (e) {
      console.error("Error scanning Monero wallet:", e)
      w.error = e.message
    }

    return
  }

  if (walletType(w) === "zec") {

    try {
      w.balance = await zcash.getWalletBalance(w, progress => applyZecSync(w, progress))
      delete w.error
      delete w.sync
    } catch (e) {
      if (e.partialBalance !== undefined || e.sync) {
        if (e.partialBalance !== undefined) {
          w.balance = e.partialBalance
        }
        applyZecSync(w, e.sync || { height: e.syncHeight })
      } else {
        console.error("Error scanning Zcash wallet:", e)
        w.error = e.message
      }
    }

    return
  }

  if (!electrumConfigured()) {
    w.error = "No Electrum server is installed. Install Electrs, Fulcrum, or ElectrumX on Umbrel."
    return
  }

  if (!electrum) {
    w.error = (electrumError || "Electrum server is not connected") + " Showing the last known balance."
    return
  }

  try {
    w.balance = await getWalletBalance(w.xpub)
    delete w.error
  } catch (e) {
    console.error("Error scanning Bitcoin wallet:", e)
    w.error = "Scan failed: " + (e.message || "unknown error") + ". Showing the last known balance."
  }

}

app.get("/appversion", async (req, res) => {
  res.json({ appversion: appVersion })
});

app.get("/health", async (req, res) => {
  res.json({ ok: true })
});

// Server-wide problems for the UI's notice bar. Each entry is
// { key, level: "error" | "warning", message }.
app.get("/status", (req, res) => {
  const issues = []
  if (serverIssues.storageInit) {
    issues.push({ key: "storage-init", level: "error", message: serverIssues.storageInit })
  }
  if (serverIssues.storage) {
    issues.push({ key: "storage", level: "error", message: serverIssues.storage })
  }
  if (electrumConfigured() && !electrum && electrumError) {
    issues.push({ key: "electrum", level: "error", message: electrumError })
  }
  res.json({ ok: issues.length === 0, issues })
});

app.get("/nodes", (req, res) => {
  res.json({
    btc: electrumConfigured(),
    xmr: monero.isConfigured(),
    zec: zcash.isConfigured()
  })
});


const PRICE_UA = "sovBalance/" + appVersion
const emptyFiat = () => ({ USD: 0, CAD: 0 })
let priceCache = { at: 0, btc: emptyFiat(), xmr: emptyFiat(), zec: emptyFiat() }

async function fetchJsonUrl(url, timeoutMs) {
  const r = await fetch(url, {
    headers: { "User-Agent": PRICE_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!r.ok) {
    throw new Error("HTTP " + r.status)
  }
  return r.json()
}

function anyFiat(p) {
  return !!(p && (p.USD || p.CAD))
}

function mergeFiat(into, from) {
  if (!from) return into
  if (!into.USD && from.USD) into.USD = from.USD
  if (!into.CAD && from.CAD) into.CAD = from.CAD
  return into
}

function fillFiatGap(...coins) {
  const basis = coins.find(c => c.USD && c.CAD)
  if (!basis) return
  const rate = basis.CAD / basis.USD
  for (const c of coins) {
    if (c.USD && !c.CAD) c.CAD = c.USD * rate
    if (c.CAD && !c.USD) c.USD = c.CAD / rate
  }
}

function krakenQuotes(data) {
  const out = emptyFiat()
  const result = data && data.result
  if (!result) return out
  for (const [key, row] of Object.entries(result)) {
    const n = row && row.c && parseFloat(row.c[0])
    if (!(n > 0)) continue
    if (key.endsWith("USD")) out.USD = n
    if (key.endsWith("CAD")) out.CAD = n
  }
  return out
}

function pickFiat(obj) {
  const out = emptyFiat()
  if (!obj) return out
  const usd = Number(obj.USD ?? obj.usd)
  const cad = Number(obj.CAD ?? obj.cad)
  if (usd > 0) out.USD = usd
  if (cad > 0) out.CAD = cad
  return out
}

const PRICE_SOURCES = {
  btc: [
    ["mempool", "https://mempool.space/api/v1/prices", pickFiat],
    ["kraken", "https://api.kraken.com/0/public/Ticker?pair=XBTUSD,XBTCAD", krakenQuotes]
  ],
  xmr: [
    ["kraken", "https://api.kraken.com/0/public/Ticker?pair=XMRUSD", krakenQuotes],
    ["coingecko", "https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd,cad", d => pickFiat(d.monero)]
  ],
  zec: [
    ["kraken", "https://api.kraken.com/0/public/Ticker?pair=ZECUSD", krakenQuotes],
    ["coingecko", "https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd,cad", d => pickFiat(d.zcash)]
  ]
}

async function fetchCoinPrices(coin, failures) {
  const prices = emptyFiat()
  const errors = []
  for (const [source, url, parse] of PRICE_SOURCES[coin]) {
    try {
      mergeFiat(prices, parse(await fetchJsonUrl(url, 5000)))
      if (prices.USD && prices.CAD) return prices
    } catch (e) {
      const reason = e.name === "TimeoutError" ? "timed out" : e.message
      console.error(`${coin.toUpperCase()} price ${source}:`, reason)
      errors.push(`${source}: ${reason}`)
    }
  }
  if (!anyFiat(prices)) {
    failures[coin] = errors.length ? errors.join("; ") : "no price returned"
  }
  return prices
}

function cachedPrices(extra = {}) {
  return {
    btc: priceCache.btc,
    xmr: priceCache.xmr,
    zec: priceCache.zec,
    updatedAt: priceCache.at || null,
    ...extra
  }
}

app.get("/prices", async (req, res) => {
  const now = Date.now()

  if (req.query.refresh !== "true" && now - priceCache.at < 60000 && (anyFiat(priceCache.btc) || anyFiat(priceCache.xmr) || anyFiat(priceCache.zec))) {
    return res.json(cachedPrices(priceCache.failures ? { failures: priceCache.failures } : {}))
  }

  let error = "Price sources could not be reached"
  try {
    const failures = {}
    const [btc, xmr, zec] = await Promise.all([fetchCoinPrices("btc", failures), fetchCoinPrices("xmr", failures), fetchCoinPrices("zec", failures)])
    fillFiatGap(btc, xmr, zec)

    if (anyFiat(btc) || anyFiat(xmr) || anyFiat(zec)) {
      // Keep the last good price for a coin whose sources all failed this time
      const fresh = { btc, xmr, zec }
      for (const coin of Object.keys(failures)) {
        if (anyFiat(priceCache[coin])) fresh[coin] = priceCache[coin]
      }
      const hasFailures = Object.keys(failures).length > 0
      priceCache = { at: now, ...fresh, failures: hasFailures ? failures : null }
      return res.json(cachedPrices(hasFailures ? { failures } : {}))
    }
    error = "Price sources could not be reached (" + Object.values(failures)[0] + ")"
  } catch (e) {
    console.error("price error:", e.message)
    error = "Price lookup failed: " + e.message
  }

  res.json(cachedPrices({ stale: true, error }))
});


let walletsRescan = null
let xmrRefresh = null

const XMR_REFRESH_MS = Math.max(0, parseInt(process.env.XMR_REFRESH_SECONDS || "120", 10) || 0) * 1000


async function rescanWallets(filter) {

  loadWallets();

  for (const w of wallets) {
    if (!filter || filter(w)) {
      try {
        await scanWallet(w);
      } catch (e) {
        console.error("Error scanning wallet:", e)
        w.error = "Scan failed: " + (e.message || "unknown error")
      }
    }
  }

  try {
    saveWallets();
  } catch (e) {
    console.error("WRITE ERROR:", e)
  }

}


// Monero spends only become visible once the view-only wallet is refreshed
// again, so keep those wallets current without waiting for a manual Refresh.
async function refreshXmrWallets() {

  if (walletsRescan || xmrRefresh || !monero.isConfigured()) return
  if (!wallets.some(w => walletType(w) === "xmr")) return

  xmrRefresh = rescanWallets(w => walletType(w) === "xmr")
    .catch(e => console.error("Monero refresh error:", e))
    .finally(() => { xmrRefresh = null })

  await xmrRefresh

}


function scheduleXmrRefresh() {

  if (!XMR_REFRESH_MS) return

  setTimeout(async () => {
    try {
      await refreshXmrWallets()
    } finally {
      scheduleXmrRefresh()
    }
  }, XMR_REFRESH_MS)

}


app.get("/wallets", async (req, res) => {

  try {

    let rescan = req.query.rescan === "true";

    if (rescan) {
      if (!walletsRescan) {
        walletsRescan = (async () => {
          try {
            if (xmrRefresh) {
              await xmrRefresh
            }
            await rescanWallets()
          } finally {
            walletsRescan = null
          }
        })()
      }

      await walletsRescan
    } else if (!walletsRescan && !xmrRefresh) {
      loadWallets();
    }

    wallets.sort((a, b) => a.wallet.localeCompare(b.wallet));

    res.json(wallets)

  } catch (e) {
    console.error("WALLETS ERROR:", e)
    res.status(500).json({ error: e.message || "Could not load wallets" })
  }

})


app.get("/wallet", (req, res) => {
  res.json({ ok: true })
})


function validateWalletFields(type, body, { excludeId = null, missingXpubError }) {
  const others = excludeId === null ? wallets : wallets.filter(w => w.id !== excludeId)

  if (type === "xmr") {
    let info
    try {
      info = monero.validateMoneroWallet(body)
    } catch (e) {
      return { error: e.message }
    }
    if (others.some(w => w.address === info.address && walletType(w) === "xmr")) {
      return { error: "address already exists" }
    }
    return {
      fields: {
        type: "xmr",
        address: info.address,
        viewKey: info.viewKey,
        restoreHeight: info.restoreHeight
      }
    }
  }

  if (type === "zec") {
    let info
    try {
      info = zcash.validateZcashWallet(body)
    } catch (e) {
      return { error: e.message }
    }
    if (info.ufvk) {
      if (others.some(w => w.ufvk === info.ufvk && walletType(w) === "zec")) {
        return { error: "viewing key already exists" }
      }
      return { fields: { type: "zec", ufvk: info.ufvk, birthday: info.birthday } }
    }
    if (others.some(w => w.address === info.address && walletType(w) === "zec")) {
      return { error: "address already exists" }
    }
    return { fields: { type: "zec", address: info.address } }
  }

  const xpub = (body.xpub || "").trim()
  if (!xpub) {
    return { error: missingXpubError }
  }
  try {
    validateKey(xpub)
  } catch (e) {
    return { error: e.message }
  }
  if (others.some(w => w.xpub === xpub)) {
    return { error: "xpub already exists" }
  }
  return { fields: { type: "btc", xpub } }
}


app.post("/wallet", (req, res) => {

  try {

    const wallet = (req.body.wallet || "").trim()
    const type = (req.body.type || "btc").trim().toLowerCase()

    if (!wallet)
      return res.status(400).json({ error: "wallet required" })

    const validated = validateWalletFields(type, req.body, { missingXpubError: "wallet/xpub required" })
    if (validated.error)
      return res.status(400).json({ error: validated.error })

    const id = wallets.length > 0 ? Math.max(...wallets.map(w => w.id)) + 1 : 0
    wallets.push({ id, wallet, ...validated.fields, balance: 0 })

    if (!saveWalletsToResponse(res)) return

    res.json({ ok: true })

  } catch (e) {
    console.error("SAVE WALLET ERROR:", e)
    if (!res.headersSent) {
      res.status(500).json({ error: e.message || "Could not save wallet" })
    }
  }
})



app.post("/wallet/remove", (req, res) => {

  const id = req.body.id
  const xpub = (req.body.xpub || "").trim()
  const address = (req.body.address || "").trim()

  const before = wallets.length

  if (id !== undefined && id !== null && id !== "") {
    wallets = wallets.filter(w => w.id !== Number(id))
  } else if (xpub) {
    wallets = wallets.filter(w => w.xpub !== xpub)
  } else if (address) {
    wallets = wallets.filter(w => w.address !== address)
  } else {
    return res.status(400).json({ error: "id required" })
  }

  if (wallets.length === before) {
    return res.status(404).json({ error: "wallet not found" })
  }

  if (!saveWalletsToResponse(res)) return

  res.json({ ok: true })

})


app.post("/wallet/key-images", async (req, res) => {

  const id = Number(req.body.id)
  const index = wallets.findIndex(w => w.id === id)

  if (index === -1) {
    return res.status(404).json({ error: "wallet not found" })
  }

  const current = wallets[index]

  if (walletType(current) !== "xmr") {
    return res.status(400).json({ error: "Key images are only used for Monero wallets" })
  }

  let payload = req.body.payload

  if (req.body.fileBase64) {
    payload = Buffer.from(req.body.fileBase64, "base64")
  }

  try {
    const imported = await monero.importKeyImages(current, payload)
    current.balance = imported.balance
    current.autoSpends = imported.autoSpends
    delete current.error
    if (!saveWalletsToResponse(res)) return
    res.json({ ok: true, ...imported })
  } catch (e) {
    console.error("Error importing key images:", e.message)
    if (!res.headersSent) {
      res.status(400).json({ error: e.message || "Key image import failed" })
    }
  }

})


app.post("/wallet/update", (req, res) => {

  const wallet = (req.body.wallet || "").trim()
  let index = -1

  if (req.body.id !== undefined && req.body.id !== null && req.body.id !== "") {
    index = wallets.findIndex(w => w.id === Number(req.body.id))
  } else {
    const oldXpub = (req.body.oldXpub || "").trim()
    index = wallets.findIndex(w => w.xpub === oldXpub)
  }

  if (!wallet) {
    return res.status(400).json({ error: "invalid data" })
  }

  if (index === -1) {
    return res.status(404).json({ error: "wallet not found" })
  }

  const current = wallets[index]
  const validated = validateWalletFields(walletType(current), req.body, {
    excludeId: current.id,
    missingXpubError: "invalid data"
  })

  if (validated.error) {
    return res.status(400).json({ error: validated.error })
  }

  current.wallet = wallet
  Object.assign(current, validated.fields)
  if (validated.fields.type === "zec") {
    if (validated.fields.ufvk) {
      delete current.address
    } else {
      delete current.ufvk
      delete current.birthday
    }
  }

  if (!saveWalletsToResponse(res)) return

  res.json({ ok: true })

})


function withTimeout(p, ms = 5000) {
  let timer
  return Promise.race([
    p,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms)
    })
  ]).finally(() => clearTimeout(timer))
}


// Malformed request bodies and anything thrown inside a route come back as
// JSON, so the UI can show the message instead of an HTML error page.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  const status = err.status || err.statusCode || 500
  const message = err.type === "entity.parse.failed"
    ? "Request body is not valid JSON"
    : err.type === "entity.too.large"
      ? "Request is too large"
      : status >= 500 ? "Internal server error: " + (err.message || "unknown") : (err.message || "Bad request")
  if (status >= 500) console.error("REQUEST ERROR:", req.method, req.url, err)
  res.status(status).json({ error: message })
})

process.on("unhandledRejection", e => {
  console.error("UNHANDLED REJECTION:", e)
})


async function start() {

  if (electrumConfigured()) {
    await connectElectrum()
  } else {
    console.log("Electrum server not configured")
  }

  if (monero.isConfigured()) {
    const ok = await monero.ping()
    console.log(ok ? "Monero wallet-rpc connected" : "Monero wallet-rpc not reachable")

    if (monero.daemonConfigured()) {
      const daemonOk = await monero.daemonPing()
      console.log(daemonOk ? "Monero Node RPC connected" : "Monero Node RPC not reachable")
    } else {
      console.log("Monero Node RPC not configured (spend detection off)")
    }
  } else {
    console.log("Monero wallet-rpc not configured")
  }

  if (zcash.isConfigured()) {
    const ok = await zcash.ping()
    console.log(ok ? "Zcash lightwalletd connected" : "Zcash lightwalletd not reachable")
  } else {
    console.log("Zcash lightwalletd not configured")
  }

  const server = app.listen(appPort, () => {
    console.log(`bitBalance running on port ${appPort}`)
    console.log(`app Version: ${appVersion}`)
  })

  server.on("error", e => {
    console.error(`Could not listen on port ${appPort}:`, e.message)
    process.exit(1)
  })

  scheduleXmrRefresh()

}

start().catch(e => {
  console.error("STARTUP ERROR:", e)
  process.exit(1)
})
