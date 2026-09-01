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

const HOST = process.env.ELECTRUM_HOST || "127.0.0.1";
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
}

try {
  const raw = fs.readFileSync(DATA_FILE, 'utf8')
  wallets = JSON.parse(raw || "[]")
  wallets = wallets.map(normalizeStoredWallet)
} catch (e) {
  console.error("READ ERROR:", e)
  wallets = []
}


function normalizeStoredWallet(w) {
  if (!w.type) {
    w.type = w.address ? "xmr" : "btc"
  }
  return w
}


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
    fs.writeFileSync(DATA_FILE, payload)
  } catch (e) {
    if (e.code !== "EACCES") throw e
    ensureDataWritable()
    fs.writeFileSync(DATA_FILE, payload)
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

  if (electrumConnecting) return
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
      scheduleElectrumReconnect()
    }

    electrum = client

    await client.connect()

    await client.server_version("bitBalance", "1.4")

    console.log("Electrum connected")

  } catch (e) {

    console.error("Electrum connect error:", e)
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

  const sh = addressToScriptHash(address)

  const utxos = await electrum.blockchainScripthash_listunspent(sh)

  //console.log("UTXOs for address:", address, utxos)

  if (!utxos || utxos.length === 0)
    return 0

  let total = 0

  for (const u of utxos) {
    total += u.value
  }

  return total
}


function validateKey(key) {

  if (key.length < 100) {
    throw new Error("Invalid XPUB/ZPUB length")
  }

}



async function scanBranch(root, change, type, isBranch = false) {


  if (type === "auto") {
    throw new Error("scanBranch must receive a single type")
  }

  const branch = isBranch ? root : root.derive(change)

  //const types = type === "auto" ? ["p2pkh", "p2wpkh", "p2sh"] : [type];

  //const types = [type];

  let index = 0
  let gap = 0
  let total = 0

  const concurrency = 10; // número de endereços a serem processados em paralelo. Aumentar esse número pode acelerar a varredura, mas também pode causar mais carga no Electrum e aumentar o risco de timeouts. Ajuste conforme necessário para encontrar um equilíbrio entre velocidade e estabilidade.
  const gapLimit = 20;

  while (gap < gapLimit) {

    const batch = []

    for (let i = 0; i < concurrency; i++) {

      const child = branch.derive(index)

      let payment;

      if (type === "p2wpkh") {
        payment = bitcoin.payments.p2wpkh({
          pubkey: child.publicKey,
          network: bitcoin.networks.bitcoin
        })
      }

      if (type === "p2sh") {
        payment = bitcoin.payments.p2sh({
          redeem: bitcoin.payments.p2wpkh({
            pubkey: child.publicKey,
            network: bitcoin.networks.bitcoin
          })
        })
      }

      if (type === "p2pkh") {
        payment = bitcoin.payments.p2pkh({
          pubkey: child.publicKey,
          network: bitcoin.networks.bitcoin
        })
      }

      if (!payment) {
        throw new Error("Invalid address type")
      }

      batch.push(payment.address)

      index++
    }

    //    const balances = await Promise.all(batch.map(a => getAddressBalance(a)))
    const balances = await Promise.all(
      batch.map(a =>
        withTimeout(getAddressBalance(a)).catch(() => 0)
      )
    )

    for (let i = 0; i < concurrency; i++) {

      const balance = balances[i]

      if (balance > 0) {
        gap = 0
      } else {
        gap++
      }

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

  try {
    const info = normalizeXpub(xpub)

    const root = bip32.fromBase58(info.key, bitcoin.networks.bitcoin)

    const types = info.type === "auto"
      ? ["p2pkh", "p2wpkh", "p2sh"]
      : [info.type]

    for (const t of types) {
      total += await scanBranch(root, 0, t)
      total += await scanBranch(root, 1, t)
    }

  } catch (e) {
    console.error("Error scanning wallet:", e)
    total = 0
  }

  return total
}


async function __getWalletBalance(xpub) {

  const info = normalizeXpub(xpub)

  if (!info || !info.key) {
    return 0
  }

  const root = bip32.fromBase58(info.key, bitcoin.networks.bitcoin)

  let total = 0

  try {

    // padrão normal
    total += await scanBranch(root, 0, info.type)
    total += await scanBranch(root, 1, info.type)

  } catch { }

  try {

    // fallback para xpub já no branch
    total += await scanBranch(root, null, info.type, true)

  } catch { }

  return total
}





async function loadWallets() {

  try {
    wallets = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")).map(normalizeStoredWallet)
  } catch {
    wallets = []
  }

}


function applyZecSync(w, parsed) {
  if (!parsed) return
  if (parsed.total !== undefined) {
    const total = Number(parsed.total) / 1e8
    if (Number.isFinite(total)) {
      w.balance = total
    }
  }
  const height = Number(parsed.height || 0)
  const tip = Number(parsed.tip || 0)
  const birthday = Number(parsed.birthday || w.birthday || 0)
  let percent = Number(parsed.percent)
  if (!Number.isFinite(percent)) {
    percent = tip > birthday
      ? ((height - birthday) * 100) / (tip - birthday)
      : 0
  }
  w.sync = {
    height,
    tip,
    birthday,
    percent: Math.round(percent * 10) / 10
  }
  delete w.error
}


async function scanWallet(w) {

  if (walletType(w) === "xmr") {

    try {
      w.balance = await monero.getWalletBalance(w)
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

  w.balance = await getWalletBalance(w.xpub)
  delete w.error

}

app.get("/appversion", async (req, res) => {
  res.json({ appversion: appVersion })
});

app.get("/health", async (req, res) => {
  res.json({ ok: true })
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

function geckoQuotes(coin) {
  const out = emptyFiat()
  if (!coin) return out
  const usd = Number(coin.usd)
  const cad = Number(coin.cad)
  if (usd > 0) out.USD = usd
  if (cad > 0) out.CAD = cad
  return out
}

async function fetchBtcPrices() {
  const prices = emptyFiat()
  try {
    const data = await fetchJsonUrl("https://mempool.space/api/v1/prices", 5000)
    const usd = Number(data.USD)
    const cad = Number(data.CAD)
    if (usd > 0) prices.USD = usd
    if (cad > 0) prices.CAD = cad
    if (prices.USD && prices.CAD) return prices
  } catch (e) {
    console.error("BTC price mempool:", e.message)
  }
  try {
    const data = await fetchJsonUrl("https://api.kraken.com/0/public/Ticker?pair=XBTUSD,XBTCAD", 5000)
    mergeFiat(prices, krakenQuotes(data))
  } catch (e) {
    console.error("BTC price kraken:", e.message)
  }
  return prices
}

async function fetchXmrPrices() {
  const prices = emptyFiat()
  try {
    const data = await fetchJsonUrl("https://api.kraken.com/0/public/Ticker?pair=XMRUSD", 5000)
    mergeFiat(prices, krakenQuotes(data))
  } catch (e) {
    console.error("XMR price kraken:", e.message)
  }
  try {
    const data = await fetchJsonUrl("https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd,cad", 5000)
    mergeFiat(prices, geckoQuotes(data.monero))
  } catch (e) {
    console.error("XMR price coingecko:", e.message)
  }
  return prices
}

async function fetchZecPrices() {
  const prices = emptyFiat()
  try {
    const data = await fetchJsonUrl("https://api.kraken.com/0/public/Ticker?pair=ZECUSD", 5000)
    mergeFiat(prices, krakenQuotes(data))
    if (prices.USD && prices.CAD) return prices
  } catch (e) {
    console.error("ZEC price kraken:", e.message)
  }
  try {
    const data = await fetchJsonUrl("https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd,cad", 5000)
    mergeFiat(prices, geckoQuotes(data.zcash))
  } catch (e) {
    console.error("ZEC price coingecko:", e.message)
  }
  return prices
}

app.get("/prices", async (req, res) => {
  const now = Date.now()

  if (now - priceCache.at < 60000 && (anyFiat(priceCache.btc) || anyFiat(priceCache.xmr) || anyFiat(priceCache.zec))) {
    return res.json({ btc: priceCache.btc, xmr: priceCache.xmr, zec: priceCache.zec })
  }

  try {
    const [btc, xmr, zec] = await Promise.all([fetchBtcPrices(), fetchXmrPrices(), fetchZecPrices()])
    fillFiatGap(btc, xmr, zec)

    if (anyFiat(btc) || anyFiat(xmr) || anyFiat(zec)) {
      priceCache = { at: now, btc, xmr, zec }
      return res.json({ btc, xmr, zec })
    }
  } catch (e) {
    console.error("price error:", e.message)
  }

  res.json({ btc: priceCache.btc, xmr: priceCache.xmr, zec: priceCache.zec })
});


let walletsRescan = null

app.get("/wallets", async (req, res) => {

  try {

    let rescan = req.query.rescan === "true";

    if (rescan) {
      if (!walletsRescan) {
        walletsRescan = (async () => {
          try {
            await loadWallets();
            for (const w of wallets) {
              await scanWallet(w);
            }

            try {
              saveWallets();
            } catch (e) {
              console.error("WRITE ERROR:", e)
            }
          } finally {
            walletsRescan = null
          }
        })()
      }

      await walletsRescan
    } else if (!walletsRescan) {
      await loadWallets();
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


app.post("/wallet", (req, res) => {

  try {

  const wallet = (req.body.wallet || "").trim()
  const type = (req.body.type || "btc").trim().toLowerCase()

  if (!wallet)
    return res.status(400).json({ error: "wallet required" })

  const id = wallets.length > 0 ? Math.max(...wallets.map(w => w.id)) + 1 : 0;
  const order = wallets.length;

  if (type === "xmr") {

    let info

    try {
      info = monero.validateMoneroWallet(req.body)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    if (wallets.some(w => w.address === info.address && w.type === "xmr")) {
      return res.status(400).json({ error: "address already exists" })
    }

    wallets.push({
      id,
      order,
      wallet,
      type: "xmr",
      address: info.address,
      viewKey: info.viewKey,
      restoreHeight: info.restoreHeight,
      balance: 0
    })

  } else if (type === "zec") {

    let info

    try {
      info = zcash.validateZcashWallet(req.body)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    if (info.ufvk) {
      if (wallets.some(w => w.ufvk === info.ufvk && w.type === "zec")) {
        return res.status(400).json({ error: "viewing key already exists" })
      }

      wallets.push({
        id,
        order,
        wallet,
        type: "zec",
        ufvk: info.ufvk,
        birthday: info.birthday,
        balance: 0
      })
    } else {
      if (wallets.some(w => w.address === info.address && w.type === "zec")) {
        return res.status(400).json({ error: "address already exists" })
      }

      wallets.push({
        id,
        order,
        wallet,
        type: "zec",
        address: info.address,
        balance: 0
      })
    }

  } else {

    const xpub = (req.body.xpub || "").trim()

    if (!xpub)
      return res.status(400).json({ error: "wallet/xpub required" })

    try {
      validateKey(xpub)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    if (wallets.some(w => w.xpub === xpub)) {
      return res.status(400).json({ error: "xpub already exists" })
    }

    wallets.push({ id, order, wallet, type: "btc", xpub, balance: 0 })

  }

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

  if (id !== undefined && id !== null && id !== "") {
    wallets = wallets.filter(w => w.id !== Number(id))
  } else if (xpub) {
    wallets = wallets.filter(w => w.xpub !== xpub)
  } else if (address) {
    wallets = wallets.filter(w => w.address !== address)
  } else {
    return res.status(400).json({ error: "id required" })
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
    delete current.error
    saveWallets()
    res.json({ ok: true, ...imported })
  } catch (e) {
    console.error("Error importing key images:", e.message)
    res.status(400).json({ error: e.message })
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

  if (walletType(current) === "xmr") {

    let info

    try {
      info = monero.validateMoneroWallet(req.body)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    if (wallets.some(w => w.address === info.address && w.id !== current.id)) {
      return res.status(400).json({ error: "address already exists" })
    }

    current.wallet = wallet
    current.address = info.address
    current.viewKey = info.viewKey
    current.restoreHeight = info.restoreHeight

  } else if (walletType(current) === "zec") {

    let info

    try {
      info = zcash.validateZcashWallet(req.body)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    if (info.ufvk) {
      if (wallets.some(w => w.ufvk === info.ufvk && w.type === "zec" && w.id !== current.id)) {
        return res.status(400).json({ error: "viewing key already exists" })
      }

      current.wallet = wallet
      current.ufvk = info.ufvk
      current.birthday = info.birthday
      delete current.address
    } else {
      if (wallets.some(w => w.address === info.address && w.type === "zec" && w.id !== current.id)) {
        return res.status(400).json({ error: "address already exists" })
      }

      current.wallet = wallet
      current.address = info.address
      delete current.ufvk
      delete current.birthday
    }

  } else {

    const xpub = (req.body.xpub || "").trim()

    if (!xpub) {
      return res.status(400).json({ error: "invalid data" })
    }

    try {
      validateKey(xpub)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    if (wallets.some(w => w.xpub === xpub && w.id !== current.id)) {
      return res.status(400).json({ error: "xpub already exists" })
    }

    current.wallet = wallet
    current.xpub = xpub

  }

  if (!saveWalletsToResponse(res)) return

  res.json({ ok: true })

})


function withTimeout(p, ms = 5000) {
  return Promise.race([
    p,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    )
  ])
}


async function start() {

  await connectElectrum()

  if (monero.isConfigured()) {
    const ok = await monero.ping()
    console.log(ok ? "Monero wallet-rpc connected" : "Monero wallet-rpc not reachable")
  } else {
    console.log("Monero wallet-rpc not configured")
  }

  if (zcash.isConfigured()) {
    const ok = await zcash.ping()
    console.log(ok ? "Zcash lightwalletd connected" : "Zcash lightwalletd not reachable")
  } else {
    console.log("Zcash lightwalletd not configured")
  }

  app.listen(appPort, () => {
    console.log(`bitBalance running on port ${appPort}`)
    console.log(`app Version: ${appVersion}`)
  })

}

start()