const bs58checkModule = require('bs58check')
const bs58check = bs58checkModule.default || bs58checkModule

function convertToXpub(key, label) {
  try {
    const data = Buffer.from(bs58check.decode(key))
    data.writeUInt32BE(0x0488b21e, 0)
    return bs58check.encode(data)
  } catch (e) {
    console.error(`Invalid ${label}:`, key)
    return null
  }
}

const zpubToXpub = zpub => convertToXpub(zpub, 'zpub')
const ypubToXpub = ypub => convertToXpub(ypub, 'ypub')

module.exports = { zpubToXpub, ypubToXpub }