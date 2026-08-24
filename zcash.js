const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")
const grpc = require("@grpc/grpc-js")
const protoLoader = require("@grpc/proto-loader")

const HOST = process.env.ZCASH_LWD_HOST || ""
const PORT = parseInt(process.env.ZCASH_LWD_PORT || "9067", 10)
const PROTO = path.join(__dirname, "vendor/lightwalletd/service.proto")
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const SAPLING_ACTIVATION = 419200
const NU5_ACTIVATION = 1687104
const SCAN_SECONDS = 25 * 60

const isDocker = fs.existsSync("/.dockerenv")
const SCAN_DIR = process.env.ZCASH_SCAN_DIR || (isDocker
  ? "/data/zcash"
  : path.join(__dirname, "data", "zcash"))

const packageDef = protoLoader.loadSync(PROTO, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})

const proto = grpc.loadPackageDefinition(packageDef).cash.z.wallet.sdk.rpc

let queue = Promise.resolve()


function isConfigured() {
  return Boolean(HOST)
}


function withLock(fn) {
  const run = queue.then(fn, fn)
  queue = run.then(() => undefined, () => undefined)
  return run
}


function zecScanBin() {
  const candidates = [
    process.env.ZEC_SCAN,
    "/usr/local/bin/zec-scan",
    path.join(__dirname, "zecscan/target/release/zec-scan")
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


function client() {

  if (!isConfigured()) {
    throw new Error("Zcash Node is not configured. Install the Zcash Node app on Umbrel.")
  }

  return new proto.CompactTxStreamer(`${HOST}:${PORT}`, grpc.credentials.createInsecure())

}


function rpc(method, request = {}, timeoutMs = 30000) {

  return new Promise((resolve, reject) => {

    const stub = client()
    const deadline = new Date(Date.now() + timeoutMs)

    stub[method](request, { deadline }, (err, res) => {
      stub.close()
      if (err) {
        if (err.code === grpc.status.DEADLINE_EXCEEDED) {
          reject(new Error("Zcash lightwalletd timeout"))
          return
        }
        if (err.code === grpc.status.UNAVAILABLE) {
          reject(new Error("Zcash lightwalletd is not reachable"))
          return
        }
        reject(new Error(err.details || err.message || "lightwalletd error"))
        return
      }
      resolve(res)
    })

  })

}


function parseBirthday(raw) {
  const birthday = raw === undefined || raw === ""
    ? NU5_ACTIVATION
    : parseInt(raw, 10)

  if (!Number.isInteger(birthday) || birthday < SAPLING_ACTIVATION) {
    throw new Error("Birthday height must be at or after Sapling activation (419200)")
  }

  return birthday
}


function lastNonEmptyLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .pop() || ""
}


function runZecScan(args, options = {}) {
  const bin = zecScanBin()

  if (!bin) {
    throw new Error("Shielded Zcash scanning is not available. Rebuild the app with the zec-scan helper.")
  }

  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 15000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) }
  })

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error("Zcash shielded scan timed out")
    }
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(lastNonEmptyLine(result.stderr || result.stdout) || "zec-scan failed")
  }

  return result
}


function walletFilename(wallet) {
  const hash = crypto
    .createHash("sha256")
    .update(`${wallet.ufvk}:${wallet.birthday || 0}`)
    .digest("hex")
    .slice(0, 16)

  return `zec-${hash}.sqlite`
}


function validateZcashWallet(input) {

  const ufvkRaw = (input.ufvk || "").trim()
  const address = (input.address || "").trim()
  const key = ufvkRaw || address

  if (key.toLowerCase().startsWith("uivk")) {
    throw new Error("incoming viewing keys cannot track spends — export the full viewing key")
  }

  if (ufvkRaw || key.startsWith("uview1")) {
    const ufvk = key

    if (!/^uview1[0-9a-z]+$/.test(ufvk) || ufvk.length < 80) {
      throw new Error("Enter a mainnet unified viewing key (starts with uview1)")
    }

    const birthday = parseBirthday(input.birthday)
    runZecScan(["validate", "--ufvk", ufvk])
    return { ufvk, birthday }
  }

  if (!/^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    throw new Error("Enter a mainnet transparent address (t1 or t3) or unified viewing key (uview1)")
  }

  for (const ch of address) {
    if (!BASE58.includes(ch)) {
      throw new Error("Invalid Zcash address")
    }
  }

  return { address }

}


async function ping() {

  if (!isConfigured()) {
    return false
  }

  try {
    await rpc("GetLightdInfo", {}, 5000)
    return true
  } catch {
    return false
  }

}


async function getTransparentBalance(wallet) {
  await rpc("GetLightdInfo", {}, 5000)

  const result = await rpc("GetTaddressBalance", {
    addresses: [wallet.address]
  })

  return Number(result.valueZat || 0) / 1e8
}


function getShieldedBalance(wallet) {
  if (!isConfigured()) {
    throw new Error("Zcash Node is not configured. Install the Zcash Node app on Umbrel.")
  }

  fs.mkdirSync(SCAN_DIR, { recursive: true })

  const dbPath = path.join(SCAN_DIR, walletFilename(wallet))
  const result = runZecScan([
    "scan",
    "--lwd", `http://${HOST}:${PORT}`,
    "--db", dbPath,
    "--birthday", String(wallet.birthday || NU5_ACTIVATION),
    "--max-seconds", String(SCAN_SECONDS)
  ], {
    timeoutMs: (SCAN_SECONDS + 60) * 1000,
    env: { ZEC_SCAN_UFVK: wallet.ufvk }
  })

  const parsed = JSON.parse(lastNonEmptyLine(result.stdout) || "{}")
  const total = Number(parsed.total || 0) / 1e8

  if (!parsed.synced) {
    const err = new Error("Zcash shielded sync is still in progress")
    err.partialBalance = total
    err.syncHeight = Number(parsed.height || 0)
    throw err
  }

  return total
}


async function getWalletBalance(wallet) {
  if (wallet.ufvk) {
    return withLock(async () => getShieldedBalance(wallet))
  }

  return getTransparentBalance(wallet)
}


module.exports = {
  isConfigured,
  ping,
  validateZcashWallet,
  getWalletBalance
}
