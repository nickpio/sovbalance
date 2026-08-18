const crypto = require("crypto")

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


module.exports = {
  isConfigured,
  ping,
  validateMoneroWallet,
  getWalletBalance
}
