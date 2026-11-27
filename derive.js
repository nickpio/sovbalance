const bs58checkModule = require('bs58check')
const bs58check = bs58checkModule.default || bs58checkModule



function zpubToXpub(zpub){

  try {

    const decoded = bs58check.decode(zpub)

    const data = Buffer.from(decoded)

    data.writeUInt32BE(0x0488b21e,0)

    return bs58check.encode(data)

  } catch(e) {

    console.error("Invalid zpub:", zpub)

    return null
  }
}


function ypubToXpub(ypub){

  try {

    const decoded = bs58check.decode(ypub)

    const data = Buffer.from(decoded)

    data.writeUInt32BE(0x0488b21e,0)

    return bs58check.encode(data)

  } catch(e) {

    console.error("Invalid ypub:", ypub)

    return null
  }
}



module.exports = {zpubToXpub, ypubToXpub}