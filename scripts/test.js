const Plugin = require('..')
const crypto = require('crypto')
const IlDcp = require('ilp-protocol-ildcp')
const IlpPacket = require('ilp-packet')
function sha256(preimage) { return crypto.createHash('sha256').update(preimage).digest() }

const plugin = new Plugin({
  lndTlsCertPath: '/Users/michiel/Library/Application Support/Lnd/tls.cert',
  maxInFlight: 10000,
  lndUri: 'localhost:10009',

  // Interval on which to claim funds from channel. Defaults to 5 minutes.
  claimInterval: 5 * 60 * 1000,
  server: 'btp+wss://:token@amundsen.ilpdemo.org:1812'
})
console.log('connecting')
plugin.connect().then(async () => {
  console.log('connected')
  const request = IlDcp.serializeIldcpRequest()
  const response = await plugin.sendData(request)
  const info = IlDcp.deserializeIldcpResponse(response)
  const fulfillment = crypto.randomBytes(32)
  const condition = sha256(fulfillment)
  console.log(`Now go to https://interfaucet.ilpdemo.org/?address=${info.clientAddress}&condition=${condition.toString('hex')}`)
  plugin.registerDataHandler(packet => {
    const prepare = IlpPacket.deserializeIlpPrepare(packet)
    console.log(prepare)
    return IlpPacket.serializeIlpFulfill({ fulfillment: fulfillment, data: Buffer.from([]) })
  })
  plugin.registerMoneyHandler(packet => {
    console.log('got money!', packet)
    plugin.disconnect()
  })
})
