const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const HOST = process.env.WALLET_RPC_HOST || ""
const PORT = parseInt(process.env.WALLET_RPC_PORT || "18083", 10)
const URL = `http://${HOST}:${PORT}/json_rpc`

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

let queue = Promise.resolve()


function isConfigured() {
  return Boolean(HOST)
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


async function openOrCreate(wallet) {

  const filename = walletFilename(wallet)

  try {
    await rpc("open_wallet", { filename, password: "" })
    return
  } catch {
    // create a view-only wallet when no local file exists yet
  }

  await rpc("generate_from_keys", {
    filename,
    address: wallet.address,
    viewkey: wallet.viewKey,
    password: "",
    restore_height: wallet.restoreHeight || 0,
    autosave_current: true,
    language: "English"
  }, 120000)

}


async function getWalletBalance(wallet) {

  return withLock(async () => {

    await rpc("get_version", {}, 5000)
    await openOrCreate(wallet)

    try {

      await rpc("refresh", {}, 30 * 60 * 1000)

      const result = await rpc("get_balance", { all_accounts: true })

      try {
        await rpc("store")
      } catch { }

      return Number(result.balance || 0) / 1e12

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

      const result = await rpc("get_balance", { all_accounts: true })

      return {
        balance: Number(result.balance || 0) / 1e12,
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

}
