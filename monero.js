const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const HOST = process.env.WALLET_RPC_HOST || ""
const PORT = parseInt(process.env.WALLET_RPC_PORT || "18083", 10)
const URL = `http://${HOST}:${PORT}/json_rpc`

// monerod of the Monero Node app. Used to read the rings of transactions that
// pay a view-only wallet so its own spends can be detected without key images.
const DAEMON_HOST = process.env.MONERO_DAEMON_HOST || ""
const DAEMON_PORT = parseInt(process.env.MONERO_DAEMON_PORT || "18081", 10)
const DAEMON_USER = process.env.MONERO_DAEMON_USER || ""
const DAEMON_PASS = process.env.MONERO_DAEMON_PASS || ""
const DAEMON_BATCH = 100

const isDocker = fs.existsSync("/.dockerenv")
const SPEND_DIR = process.env.MONERO_SPEND_DIR || (isDocker
  ? "/data/monero"
  : path.join(__dirname, "data", "monero"))

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

let queue = Promise.resolve()


function isConfigured() {
  return Boolean(HOST)
}


function daemonConfigured() {
  return Boolean(DAEMON_HOST)
}


function withLock(fn) {
  const run = queue.then(fn, fn)
  queue = run.then(() => undefined, () => undefined)
  return run
}


function walletFilename(wallet) {
  const hash = crypto
    .createHash("sha256")
    .update(`${wallet.address}:${wallet.viewKey}:${wallet.restoreHeight || 0}`)
    .digest("hex")
    .slice(0, 16)

  return `xmr-${hash}`
}


async function rpc(method, params = {}, timeoutMs = 30000) {

  if (!isConfigured()) {
    throw new Error("Monero Node is not configured. Install the Monero Node app on Umbrel.")
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {

    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "0",
        method,
        params
      }),
      signal: controller.signal
    })

    const data = await res.json()

    if (data.error) {
      throw new Error(data.error.message || "wallet-rpc error")
    }

    return data.result

  } catch (e) {

    if (e.name === "AbortError") {
      throw new Error("Monero wallet RPC timeout")
    }

    if (e.message === "fetch failed" || e.code === "ECONNREFUSED") {
      throw new Error("Monero wallet RPC is not reachable")
    }

    throw e

  } finally {
    clearTimeout(timer)
  }

}


function daemonUrl(endpoint) {
  const host = DAEMON_HOST.includes(":") && !DAEMON_HOST.startsWith("[") ? `[${DAEMON_HOST}]` : DAEMON_HOST
  return `http://${host}:${DAEMON_PORT}/${endpoint}`
}


function md5(...parts) {
  return crypto.createHash("md5").update(parts.join(":")).digest("hex")
}


// monerod answers 401 with one "Digest" challenge per algorithm (MD5, MD5-sess)
// sharing the same realm and nonce. Keep the first value of each parameter.
function parseDigestChallenge(header) {

  const text = String(header || "")
  const start = text.search(/digest\s/i)

  if (start < 0) {
    return null
  }

  const params = {}
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g
  let m

  while ((m = re.exec(text.slice(start + 7))) !== null) {
    const key = m[1].toLowerCase()
    if (params[key] === undefined) {
      params[key] = m[2] !== undefined ? m[2] : m[3]
    }
  }

  return params.nonce ? params : null

}


// RFC 2617 response. monerod's parser wants algorithm/qop/nc as bare tokens
// (nc exactly 8 hex digits) and every other value quoted.
function digestAuthorization(challenge, method, uri, creds) {

  const realm = challenge.realm || ""
  const nonce = challenge.nonce || ""
  const algorithm = challenge.algorithm || "MD5"
  const qop = String(challenge.qop || "").split(",").map(s => s.trim()).includes("auth") ? "auth" : ""
  const nc = creds.nc || "00000001"
  const cnonce = creds.cnonce || crypto.randomBytes(8).toString("hex")

  let ha1 = md5(creds.user, realm, creds.pass)

  if (/-sess$/i.test(algorithm)) {
    ha1 = md5(ha1, nonce, cnonce)
  }

  const ha2 = md5(method, uri)
  const response = qop ? md5(ha1, nonce, nc, cnonce, qop, ha2) : md5(ha1, nonce, ha2)

  const fields = [
    `username="${creds.user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithm}`,
    `response="${response}"`
  ]

  if (qop) {
    fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  }

  if (challenge.opaque) {
    fields.push(`opaque="${challenge.opaque}"`)
  }

  return "Digest " + fields.join(", ")

}


function daemonFetch(url, body, authorization, signal) {

  const headers = { "Content-Type": "application/json" }

  if (authorization) {
    headers.Authorization = authorization
  }

  return fetch(url, { method: "POST", headers, body, signal })

}


async function daemonPost(endpoint, params = {}, timeoutMs = 30000) {

  if (!daemonConfigured()) {
    throw new Error("Monero Node RPC is not configured")
  }

  const url = daemonUrl(endpoint)
  const body = JSON.stringify(params)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {

    let res = await daemonFetch(url, body, null, controller.signal)

    // monerod keeps one nonce and resets it whenever an unauthenticated request
    // arrives (wallet-rpc shares the same daemon), so answer each challenge
    // fresh instead of reusing a nonce with an incrementing counter.
    for (let attempt = 0; res.status === 401 && attempt < 3; attempt++) {

      const challenge = parseDigestChallenge(res.headers.get("www-authenticate"))
      await res.text().catch(() => "")

      if (!challenge) {
        break
      }

      if (!DAEMON_USER) {
        throw new Error("Monero Node RPC requires a login (MONERO_DAEMON_USER / MONERO_DAEMON_PASS)")
      }

      const authorization = digestAuthorization(challenge, "POST", `/${endpoint}`, {
        user: DAEMON_USER,
        pass: DAEMON_PASS
      })

      res = await daemonFetch(url, body, authorization, controller.signal)

    }

    if (res.status === 401) {
      throw new Error("Monero Node RPC login was rejected")
    }

    if (!res.ok) {
      throw new Error(`Monero Node RPC failed (HTTP ${res.status})`)
    }

    return await res.json()

  } catch (e) {

    if (e.name === "AbortError") {
      throw new Error("Monero Node RPC timeout")
    }

    if (e.message === "fetch failed" || e.code === "ECONNREFUSED") {
      throw new Error("Monero Node RPC is not reachable")
    }

    throw e

  } finally {
    clearTimeout(timer)
  }

}


async function daemonPing() {

  if (!daemonConfigured()) {
    return false
  }

  try {
    const info = await daemonPost("get_info", {}, 5000)
    return info.status === "OK"
  } catch {
    return false
  }

}


// Decoded transaction from monerod get_transactions (decode_as_json).
// Ring members arrive as relative offsets; the absolute global output index of
// member i is the sum of offsets 0..i.
function parseTxJson(text) {

  let json

  try {
    json = JSON.parse(text)
  } catch {
    return null
  }

  const vins = []

  for (const vin of json.vin || []) {

    if (!vin.key) {
      return { vins: [], fee: 0 }
    }

    let absolute = 0
    const ring = (vin.key.key_offsets || []).map(offset => (absolute += Number(offset)))

    vins.push({ amount: Number(vin.key.amount || 0), ring })

  }

  const fee = Number((json.rct_signatures && json.rct_signatures.txnFee) || 0)

  return { vins, fee }

}


async function fetchTxs(txids) {

  const out = new Map()

  for (let i = 0; i < txids.length; i += DAEMON_BATCH) {

    const batch = txids.slice(i, i + DAEMON_BATCH)

    const res = await daemonPost("get_transactions", {
      txs_hashes: batch,
      decode_as_json: true,
      prune: true
    })

    if (res.status !== "OK") {
      throw new Error(`Monero Node get_transactions: ${res.status || "failed"}`)
    }

    for (const tx of res.txs || []) {
      const parsed = parseTxJson(tx.as_json)
      if (parsed) {
        out.set(tx.tx_hash, { ...parsed, inPool: Boolean(tx.in_pool) })
      }
    }

  }

  return out

}


function validateMoneroWallet(input) {

  const address = (input.address || "").trim()
  const viewKey = (input.viewKey || "").trim()
  const restoreHeightRaw = input.restoreHeight

  if (address.length !== 95 || !address.startsWith("4")) {
    throw new Error("Enter a mainnet primary address (starts with 4, 95 characters)")
  }

  for (const ch of address) {
    if (!BASE58.includes(ch)) {
      throw new Error("Invalid Monero address")
    }
  }

  if (!/^[0-9a-fA-F]{64}$/.test(viewKey)) {
    throw new Error("Invalid private view key")
  }

  const restoreHeight = restoreHeightRaw === undefined || restoreHeightRaw === ""
    ? 0
    : parseInt(restoreHeightRaw, 10)

  if (!Number.isInteger(restoreHeight) || restoreHeight < 0) {
    throw new Error("Invalid restore height")
  }

  return {
    address,
    viewKey: viewKey.toLowerCase(),
    restoreHeight
  }

}


async function ping() {

  if (!isConfigured()) {
    return false
  }

  try {
    await rpc("get_version", {}, 5000)
    return true
  } catch {
    return false
  }

}


async function closeWallet() {

  try {
    await rpc("close_wallet", { autosave_current: false })
  } catch { }

}


async function openOrCreate(wallet) {

  const filename = walletFilename(wallet)

  await closeWallet()

  try {
    await rpc("open_wallet", { filename, password: "" })
    return
  } catch (openErr) {
    const msg = String(openErr.message || "")
    if (/already (open|opened)/i.test(msg)) {
      return
    }
  }

  try {
    await rpc("generate_from_keys", {
      filename,
      address: wallet.address,
      viewkey: wallet.viewKey,
      password: "",
      restore_height: wallet.restoreHeight || 0,
      autosave_current: false,
      language: "English"
    }, 120000)
  } catch (createErr) {
    try {
      await rpc("open_wallet", { filename, password: "" })
      return
    } catch {
      const msg = String(createErr.message || "")
      if (/failed to save file/i.test(msg)) {
        throw new Error("Could not write Monero wallet files. The wallet-rpc data directory is not writable.")
      }
      throw createErr
    }
  }

}


// Every output the open wallet owns, keyed by global output index. A view-only
// wallet reports key_image "" for outputs whose key image was never imported.
async function listOwned() {

  const accounts = await rpc("get_accounts")
  const owned = new Map()

  for (const account of accounts.subaddress_accounts || []) {

    const res = await rpc("incoming_transfers", {
      transfer_type: "all",
      account_index: account.account_index
    })

    for (const t of res.transfers || []) {
      const gidx = Number(t.global_index)
      owned.set(gidx, {
        gidx,
        amount: Number(t.amount || 0),
        txHash: t.tx_hash,
        spent: Boolean(t.spent),
        kiKnown: Boolean(t.key_image)
      })
    }

  }

  return owned

}


// A spend from this wallet pays change back to it, so it shows up as an
// incoming transaction whose every input ring contains one of our outputs.
// Returns the global indices of the owned ring members with unknown key
// images when the transaction is ours, otherwise null.
function classifySpend(tx, owned, received) {

  if (!tx.vins.length) {
    return null
  }

  const matched = new Map()

  for (const vin of tx.vins) {

    if (vin.amount !== 0) {
      return null
    }

    let hit = false

    for (const gidx of vin.ring) {
      const o = owned.get(gidx)
      if (o && (!o.kiKnown || o.spent)) {
        matched.set(gidx, o)
        hit = true
      }
    }

    if (!hit) {
      return null
    }

  }

  let total = 0

  for (const o of matched.values()) {
    total += o.amount
  }

  // The real inputs are among the matched outputs and must cover what came
  // back to us plus the fee. Rejects most cases where a payment to us merely
  // picked one of our outputs as a decoy.
  if (total < received + tx.fee) {
    return null
  }

  return [...matched.values()].filter(o => !o.kiKnown).map(o => o.gidx)

}


function spendCachePath(wallet) {
  return path.join(SPEND_DIR, `${walletFilename(wallet)}.json`)
}


function loadSpendCache(wallet) {

  try {
    const parsed = JSON.parse(fs.readFileSync(spendCachePath(wallet), "utf8"))
    if (parsed && parsed.version === 1 && parsed.txs && typeof parsed.txs === "object") {
      return parsed
    }
  } catch { }

  return { version: 1, txs: {} }

}


function saveSpendCache(wallet, cache) {
  fs.mkdirSync(SPEND_DIR, { recursive: true })
  fs.writeFileSync(spendCachePath(wallet), JSON.stringify(cache))
}


function clearSpendCache(wallet) {
  try {
    fs.unlinkSync(spendCachePath(wallet))
  } catch { }
}


async function detectSpends(wallet) {

  const owned = await listOwned()
  const received = new Map()

  for (const o of owned.values()) {
    if (o.txHash) {
      received.set(o.txHash, (received.get(o.txHash) || 0) + o.amount)
    }
  }

  const transfers = await rpc("get_transfers", { pool: true, all_accounts: true })

  for (const p of transfers.pool || []) {
    received.set(p.txid, (received.get(p.txid) || 0) + Number(p.amount || 0))
  }

  const cache = loadSpendCache(wallet)
  const pending = [...received.keys()].filter(txid => !cache.txs[txid])
  const txs = await fetchTxs(pending)
  const results = new Map()
  let dirty = false

  for (const txid of pending) {

    const tx = txs.get(txid)

    if (!tx) {
      continue
    }

    const spent = classifySpend(tx, owned, received.get(txid) || 0)
    const entry = spent ? { ours: true, spent } : { ours: false }

    results.set(txid, entry)

    // Rings only reference earlier outputs, so a confirmed verdict is final.
    if (!tx.inPool) {
      cache.txs[txid] = entry
      dirty = true
    }

  }

  if (dirty) {
    saveSpendCache(wallet, cache)
  }

  for (const [txid, entry] of Object.entries(cache.txs)) {
    if (received.has(txid) && !results.has(txid)) {
      results.set(txid, entry)
    }
  }

  const spentIdx = new Set()
  let count = 0

  for (const entry of results.values()) {

    if (!entry.ours) {
      continue
    }

    const active = entry.spent.filter(gidx => {
      const o = owned.get(gidx)
      return o && !o.kiKnown && !o.spent
    })

    if (active.length) {
      count++
      active.forEach(gidx => spentIdx.add(gidx))
    }

  }

  let amount = 0

  for (const gidx of spentIdx) {
    amount += owned.get(gidx).amount
  }

  return { count, amount }

}


// Balance of the open wallet with detected spends removed. Detection failures
// never fail the scan: the plain view-only balance is returned with the error.
async function computeBalance(wallet) {

  const result = await rpc("get_balance", { all_accounts: true })
  const balance = Number(result.balance || 0)

  if (!daemonConfigured()) {
    return {
      balance: balance / 1e12,
      autoSpends: { error: "Monero Node RPC is not configured" }
    }
  }

  try {

    const spends = await detectSpends(wallet)

    return {
      balance: Math.max(0, balance - spends.amount) / 1e12,
      autoSpends: { count: spends.count, xmr: spends.amount / 1e12 }
    }

  } catch (e) {

    console.error("Monero spend detection:", e.message)

    return {
      balance: balance / 1e12,
      autoSpends: { error: e.message }
    }

  }

}


async function getWalletBalance(wallet) {

  return withLock(async () => {

    await rpc("get_version", {}, 5000)
    await openOrCreate(wallet)

    try {

      await rpc("refresh", {}, 30 * 60 * 1000)

      const result = await computeBalance(wallet)

      try {
        await rpc("store")
      } catch { }

      return result

    } finally {

      try {
        await rpc("close_wallet")
      } catch { }

    }

  })

}


function toHex(buf) {
  return Buffer.from(buf).toString("hex")
}


function rotl32(v, n) {
  return ((v << n) | (v >>> (32 - n))) >>> 0
}


function chacha20Quarter(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0
  s[d] = rotl32(s[d] ^ s[a], 16)
  s[c] = (s[c] + s[d]) >>> 0
  s[b] = rotl32(s[b] ^ s[c], 12)
  s[a] = (s[a] + s[b]) >>> 0
  s[d] = rotl32(s[d] ^ s[a], 8)
  s[c] = (s[c] + s[d]) >>> 0
  s[b] = rotl32(s[b] ^ s[c], 7)
}


function chacha20Xor(data, key, iv) {

  const out = Buffer.alloc(data.length)
  const j = new Uint32Array(16)
  const sigma = Buffer.from("expand 32-byte k")

  j[0] = sigma.readUInt32LE(0)
  j[1] = sigma.readUInt32LE(4)
  j[2] = sigma.readUInt32LE(8)
  j[3] = sigma.readUInt32LE(12)

  for (let i = 0; i < 8; i++) {
    j[4 + i] = key.readUInt32LE(i * 4)
  }

  j[14] = iv.readUInt32LE(0)
  j[15] = iv.readUInt32LE(4)

  let offset = 0

  while (offset < data.length) {

    const x = new Uint32Array(j)

    for (let i = 0; i < 10; i++) {
      chacha20Quarter(x, 0, 4, 8, 12)
      chacha20Quarter(x, 1, 5, 9, 13)
      chacha20Quarter(x, 2, 6, 10, 14)
      chacha20Quarter(x, 3, 7, 11, 15)
      chacha20Quarter(x, 0, 5, 10, 15)
      chacha20Quarter(x, 1, 6, 11, 12)
      chacha20Quarter(x, 2, 7, 8, 13)
      chacha20Quarter(x, 3, 4, 9, 14)
    }

    const block = Buffer.alloc(64)

    for (let i = 0; i < 16; i++) {
      block.writeUInt32LE((x[i] + j[i]) >>> 0, i * 4)
    }

    const n = Math.min(64, data.length - offset)

    for (let i = 0; i < n; i++) {
      out[offset + i] = data[offset + i] ^ block[i]
    }

    j[12] = (j[12] + 1) >>> 0

    if (j[12] === 0) {
      j[13] = (j[13] + 1) >>> 0
    }

    offset += 64

  }

  return out

}


function cnSlowHashBin() {

  const candidates = [
    process.env.CN_SLOW_HASH,
    "/usr/local/bin/cn-slow-hash",
    path.join(__dirname, "vendor/cryptonight/cn-slow-hash")
  ].filter(Boolean)

  return candidates.find(p => {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })

}


const chachaKeyCache = new Map()


function cnSlowHash(buf) {

  const bin = cnSlowHashBin()

  if (!bin) {
    throw new Error("Cannot decrypt GUI/Feather key image files. Paste JSON from wallet-rpc export_key_images instead.")
  }

  const result = spawnSync(bin, [], {
    input: buf,
    encoding: null,
    maxBuffer: 1024
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0 || !result.stdout || result.stdout.length !== 32) {
    throw new Error("Failed to decrypt key image file")
  }

  return result.stdout

}


function chachaKeyFromViewKey(viewKeyHex) {

  const cached = chachaKeyCache.get(viewKeyHex)

  if (cached) {
    return cached
  }

  const key = cnSlowHash(Buffer.from(viewKeyHex, "hex"))
  chachaKeyCache.set(viewKeyHex, key)
  return key

}


function decryptWithViewSecretKey(ciphertext, viewKeyHex) {

  if (ciphertext.length < 8) {
    throw new Error("Key image file is truncated")
  }

  const key = chachaKeyFromViewKey(viewKeyHex)
  const iv = ciphertext.slice(0, 8)
  const plains = []

  if (ciphertext.length >= 72) {
    plains.push(chacha20Xor(ciphertext.slice(8, ciphertext.length - 64), key, iv))
  }

  plains.push(chacha20Xor(ciphertext.slice(8), key, iv))

  return plains

}


function normalizeSignedKeyImages(items, offset) {

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No key images found")
  }

  const signed_key_images = items.map(item => {

    const key_image = String(item.key_image || "").trim().toLowerCase()
    const signature = String(item.signature || "").trim().toLowerCase()

    if (!/^[0-9a-f]{64}$/.test(key_image)) {
      throw new Error("Invalid key image")
    }

    if (!/^[0-9a-f]{128}$/.test(signature)) {
      throw new Error("Invalid key image signature")
    }

    return { key_image, signature }

  })

  const off = offset === undefined || offset === "" ? 0 : parseInt(offset, 10)

  if (!Number.isInteger(off) || off < 0) {
    throw new Error("Invalid key image offset")
  }

  return { offset: off, signed_key_images }

}


function parseUnencryptedRecords(buf, withOffset) {

  const headerlen = (withOffset ? 4 : 0) + 64

  if (buf.length < headerlen) {
    throw new Error("Key image file is truncated")
  }

  const offset = withOffset
    ? buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24)
    : 0

  const body = buf.slice(headerlen)
  const recordSize = 32 + 64

  if (body.length % recordSize !== 0) {
    throw new Error("Unrecognized key image file")
  }

  const signed_key_images = []

  for (let i = 0; i < body.length; i += recordSize) {
    signed_key_images.push({
      key_image: toHex(body.slice(i, i + 32)),
      signature: toHex(body.slice(i + 32, i + recordSize))
    })
  }

  return normalizeSignedKeyImages(signed_key_images, offset)

}


function parseEncryptedKeyImages(payload, viewKey) {

  if (!viewKey) {
    throw new Error("View key required to decrypt this key image file")
  }

  const plains = decryptWithViewSecretKey(payload, viewKey)

  for (const plain of plains) {
    try {
      return parseUnencryptedRecords(plain, true)
    } catch { }
  }

  throw new Error("Failed to decrypt key image file. Export from the spend wallet for this view-only address.")

}


function parseKeyImageBuffer(buf, viewKey) {

  const prefix = buf.slice(0, 23).toString("ascii")

  if (prefix === "Monero key image export") {

    const version = buf[23]
    const payload = buf.slice(24)

    if (version === 1) {
      return parseUnencryptedRecords(payload, false)
    }

    return parseEncryptedKeyImages(payload, viewKey)

  }

  const text = buf.toString("utf8").trim()

  if (text.startsWith("{") || text.startsWith("[")) {
    return parseKeyImages(JSON.parse(text), viewKey)
  }

  throw new Error("Unrecognized key image file")

}


function parseKeyImages(payload, viewKey) {

  if (payload && payload.result && Array.isArray(payload.result.signed_key_images)) {
    return parseKeyImages(payload.result, viewKey)
  }

  if (payload && Array.isArray(payload.signed_key_images)) {
    return normalizeSignedKeyImages(payload.signed_key_images, payload.offset)
  }

  if (Array.isArray(payload)) {
    return normalizeSignedKeyImages(payload, 0)
  }

  if (typeof payload !== "string" && !Buffer.isBuffer(payload)) {
    throw new Error("Key images required")
  }

  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload).trim(), "utf8")
  const text = raw.toString("utf8").trim()

  if (text.startsWith("{") || text.startsWith("[")) {
    return parseKeyImages(JSON.parse(text), viewKey)
  }

  const hex = text.replace(/\s+/g, "")

  if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
    return parseKeyImageBuffer(Buffer.from(hex, "hex"), viewKey)
  }

  if (!Buffer.isBuffer(payload) && /^[A-Za-z0-9+/]+=*$/.test(text.replace(/\s+/g, ""))) {
    return parseKeyImageBuffer(Buffer.from(text, "base64"), viewKey)
  }

  return parseKeyImageBuffer(raw, viewKey)

}


async function importKeyImages(wallet, payload) {

  const parsed = parseKeyImages(payload, wallet.viewKey)

  return withLock(async () => {

    await openOrCreate(wallet)

    try {

      await rpc("refresh", {}, 30 * 60 * 1000)

      const imported = await rpc("import_key_images", {
        offset: parsed.offset,
        signed_key_images: parsed.signed_key_images
      }, 120000)

      try {
        await rpc("store")
      } catch { }

      // Key images settle which outputs are spent, so redo the ring analysis
      // with the outputs that are still view-only.
      clearSpendCache(wallet)

      const { balance, autoSpends } = await computeBalance(wallet)

      return {
        balance,
        autoSpends,
        spent: Number(imported.spent || 0) / 1e12,
        unspent: Number(imported.unspent || 0) / 1e12,
        height: imported.height
      }

    } finally {

      try {
        await rpc("close_wallet")
      } catch { }

    }

  })

}


module.exports = {
  isConfigured,
  ping,
  daemonConfigured,
  daemonPing,
  validateMoneroWallet,
  getWalletBalance,
  parseKeyImages,
  importKeyImages
}

if (require.main === module && process.argv[2] === "--self-test") {

  const parsedJson = parseKeyImages({
    offset: 2,
    signed_key_images: [{
      key_image: "aa".repeat(32),
      signature: "bb".repeat(64)
    }]
  })

  if (parsedJson.offset !== 2 || parsedJson.signed_key_images.length !== 1) {
    throw new Error("JSON parse failed")
  }

  const v1 = Buffer.concat([
    Buffer.from("Monero key image export\x01"),
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 2),
    Buffer.alloc(32, 3),
    Buffer.alloc(64, 4)
  ])

  const parsedV1 = parseKeyImages(v1)

  if (parsedV1.offset !== 0 || parsedV1.signed_key_images[0].key_image !== "03".repeat(32)) {
    throw new Error("v1 parse failed")
  }

  const viewKey = "11".repeat(32)
  const plain = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.alloc(32, 5),
    Buffer.alloc(32, 6),
    Buffer.alloc(32, 7),
    Buffer.alloc(64, 8)
  ])
  const key = cnSlowHash(Buffer.from(viewKey, "hex"))
  const iv = Buffer.alloc(8, 9)
  const cipher = Buffer.concat([
    Buffer.from("Monero key image export\x03"),
    iv,
    chacha20Xor(plain, key, iv),
    Buffer.alloc(64, 10)
  ])

  const parsedV3 = parseKeyImages(cipher, viewKey)

  if (parsedV3.offset !== 0 || parsedV3.signed_key_images[0].key_image !== "07".repeat(32)) {
    throw new Error("encrypted parse failed")
  }

  console.log("key image self-test ok")

  // RFC 2617 section 3.5 example
  const rfcChallenge = parseDigestChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"'
  )
  const rfcAuth = digestAuthorization(rfcChallenge, "GET", "/dir/index.html", {
    user: "Mufasa",
    pass: "Circle Of Life",
    nc: "00000001",
    cnonce: "0a4f113b"
  })

  if (!rfcAuth.includes('response="6629fae49393a05397450978507c4ef1"') || !rfcAuth.includes("qop=auth, nc=00000001") || !rfcAuth.includes('opaque="5ccc069c403ebaf9f0171e9517f40e41"')) {
    throw new Error("digest response failed: " + rfcAuth)
  }

  const monerodChallenge = parseDigestChallenge(
    'Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="n0nce",stale=false, Digest qop="auth",algorithm=MD5-sess,realm="monero-rpc",nonce="n0nce",stale=false'
  )

  if (monerodChallenge.algorithm !== "MD5" || monerodChallenge.realm !== "monero-rpc" || monerodChallenge.nonce !== "n0nce") {
    throw new Error("monerod challenge parse failed")
  }

  const XMR = 1e12
  const txJson = JSON.stringify({
    vin: [{ key: { amount: 0, key_offsets: [100, 5, 3], k_image: "00" } }],
    vout: [],
    rct_signatures: { txnFee: 0.01 * XMR }
  })
  const decoded = parseTxJson(txJson)

  if (decoded.vins.length !== 1 || decoded.vins[0].ring.join(",") !== "100,105,108" || decoded.fee !== 0.01 * XMR) {
    throw new Error("tx offsets parse failed")
  }

  if (parseTxJson(JSON.stringify({ vin: [{ gen: { height: 1 } }] })).vins.length !== 0) {
    throw new Error("coinbase parse failed")
  }

  const owned = new Map([
    [100, { gidx: 100, amount: 5 * XMR, txHash: "a", spent: false, kiKnown: false }],
    [200, { gidx: 200, amount: 2 * XMR, txHash: "b", spent: false, kiKnown: false }],
    [300, { gidx: 300, amount: 1 * XMR, txHash: "c", spent: false, kiKnown: false }],
    [400, { gidx: 400, amount: 3 * XMR, txHash: "d", spent: false, kiKnown: true }],
    [500, { gidx: 500, amount: 4 * XMR, txHash: "e", spent: true, kiKnown: true }]
  ])
  const fee = 0.01 * XMR
  const ringWith = gidx => [gidx - 7, gidx, gidx + 9]

  const spend = classifySpend({ vins: [{ amount: 0, ring: ringWith(100) }], fee }, owned, 3 * XMR)
  if (!spend || spend.join(",") !== "100") {
    throw new Error("single-input spend not detected")
  }

  const multi = classifySpend({ vins: [{ amount: 0, ring: ringWith(100) }, { amount: 0, ring: ringWith(200) }], fee }, owned, 6 * XMR)
  if (!multi || multi.join(",") !== "100,200") {
    throw new Error("multi-input spend not detected")
  }

  if (classifySpend({ vins: [{ amount: 0, ring: ringWith(100) }, { amount: 0, ring: [1, 2, 3] }], fee }, owned, 1 * XMR) !== null) {
    throw new Error("tx with a foreign input must not be ours")
  }

  // A payment to us that used our 1 XMR output as a decoy cannot be a spend of 4 XMR
  if (classifySpend({ vins: [{ amount: 0, ring: ringWith(300) }], fee }, owned, 4 * XMR) !== null) {
    throw new Error("decoy false positive not rejected")
  }

  if (classifySpend({ vins: [{ amount: 0, ring: ringWith(400) }], fee }, owned, 1 * XMR) !== null) {
    throw new Error("known-unspent output must not match")
  }

  const withKnown = classifySpend({ vins: [{ amount: 0, ring: ringWith(500) }, { amount: 0, ring: ringWith(300) }], fee }, owned, 1 * XMR)
  if (!withKnown || withKnown.join(",") !== "300") {
    throw new Error("known-spent output must match without being re-counted")
  }

  if (classifySpend({ vins: [{ amount: 10 * XMR, ring: ringWith(100) }], fee }, owned, 1 * XMR) !== null) {
    throw new Error("pre-RingCT input must not match")
  }

  if (classifySpend({ vins: [], fee: 0 }, owned, 1 * XMR) !== null) {
    throw new Error("coinbase must not be ours")
  }

  console.log("spend detection self-test ok")

}
