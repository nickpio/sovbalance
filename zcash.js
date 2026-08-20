const path = require("path")
const grpc = require("@grpc/grpc-js")
const protoLoader = require("@grpc/proto-loader")

const HOST = process.env.ZCASH_LWD_HOST || ""
const PORT = parseInt(process.env.ZCASH_LWD_PORT || "9067", 10)
const PROTO = path.join(__dirname, "vendor/lightwalletd/service.proto")
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

const packageDef = protoLoader.loadSync(PROTO, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})

const proto = grpc.loadPackageDefinition(packageDef).cash.z.wallet.sdk.rpc


function isConfigured() {
  return Boolean(HOST)
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


function validateZcashWallet(input) {

  const address = (input.address || "").trim()

  if (!/^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    throw new Error("Enter a mainnet transparent address (starts with t1 or t3)")
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


async function getWalletBalance(wallet) {

  await rpc("GetLightdInfo", {}, 5000)

  const result = await rpc("GetTaddressBalance", {
    addresses: [wallet.address]
  })

  return Number(result.valueZat || 0) / 1e8

}


module.exports = {
  isConfigured,
  ping,
  validateZcashWallet,
  getWalletBalance
}
