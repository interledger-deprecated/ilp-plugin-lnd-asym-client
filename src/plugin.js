'use strict'

const grpc = require('grpc')
const debug = require('debug')('ilp-plugin-lightning')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const BigNumber = require('bignumber.js')
const decodePaymentRequest = require('./reqdecode').decodePaymentRequest
const shared = require('ilp-plugin-shared')
const { InvalidFieldsError, NotAcceptedError } = shared.Errors
const { makePaymentChannelPlugin } = require('ilp-plugin-payment-channel-framework')

const lnrpcDescriptor = grpc.load(path.join(__dirname, 'rpc.proto'))
const lnrpc = lnrpcDescriptor.lnrpc

const GET_INVOICE_RPC_METHOD = '_get_lightning_invoice'

module.exports = makePaymentChannelPlugin({
  pluginName: 'lightning',

  constructor: function (ctx, opts) {
    if (!opts.lndTlsCertPath) {
      throw new InvalidFieldsError('missing opts.lndTlsCertPath;' +
          ' try /home/YOURNAME/.lnd/tls.cert (Linux) or' +
          ' /Users/YOURNAME/Library/Application Support/Lnd/tls.cert (Mac)')
    } else if (!opts.peerPublicKey) {
      throw new InvalidFieldsError('missing opts.peerPublicKey')
    } else if (!opts.maxInFlight && !opts.maxUnsecured) {
      throw new InvalidFieldsError('missing opts.maxInFlight')
    } else if (!opts.lndUri) {
      throw new InvalidFieldsError('missing opts.lndUri')
    }
    ctx.state.incomingSettlements = ctx.backend.getTransferLog('incoming_settlements')
    ctx.state.amountSettled = ctx.backend.getMaxValueTracker('amount_settled')
    ctx.state.maxUnsecured = opts.maxUnsecured || opts.maxInFlight
    ctx.state.authToken = opts.authToken
    ctx.state.peerPublicKey = opts.peerPublicKey
    ctx.state.lndUri = opts.lndUri
    ctx.state.network = opts.network

    this.lndTlsCertPath = opts.lndTlsCertPath
    ctx.rpc.addMethod(GET_INVOICE_RPC_METHOD, async function (amount) {
      debug('creating lightning invoice for amount', amount)
      const invoice = await createLightningInvoice(ctx.state.lightning, amount)
      await ctx.state.incomingSettlements.prepare({
        id: hashToUuid(invoice.r_hash),
        amount,
        executionCondition: invoice.r_hash
      })
      debug('created lightning invoice:', invoice.payment_request, 'for amount:', amount)
      return {
        paymentRequest: invoice.payment_request
      }
    })
  },

  getAuthToken: (ctx) => (ctx.state.authToken),

  connect: async function (ctx, opts) {
    const lndTlsCertPath = this.lndTlsCertPath
    try {
      const lndCert = await new Promise((resolve, reject) => {
        fs.readFile(lndTlsCertPath, (err, cert) => {
          if (err) throw err
          resolve(cert)
        })
      })
      ctx.state.lightning = new lnrpc.Lightning(ctx.state.lndUri, grpc.credentials.createSsl(lndCert))
      debug('connecting to lnd:', ctx.state.lndUri)
      const lightningInfo = await new Promise((resolve, reject) => {
        ctx.state.lightning.getInfo({}, (err, info) => {
          if (err) return reject(err)
          resolve(info)
        })
      })
      debug('got lnd info:', lightningInfo)
      ctx.state.publicKey = lightningInfo.identity_pubkey
      ctx.state.network = ctx.state.network || lightningInfo.chains[0]
      const scheme = lightningInfo.testnet
        ? 'test.'
        : 'g.'
      const neighborhood = ctx.state.network + '.lightning.'
      ctx.state.prefix = scheme + neighborhood
      // TODO add public keys to prefix, because ctx.state is just a bilateral channel
      // right now we can't send to anyone on lightning, because we need a way to message
      // the other plugins aside from using HTTP RPC
      ctx.state.account = ctx.state.prefix + ctx.state.publicKey
      ctx.state.peerAccount = ctx.state.prefix + ctx.state.peerPublicKey
      debug(`my account is: ${ctx.state.account}, peer account is: ${ctx.state.peerAccount}`)
    } catch (err) {
      debug('error connecting to lnd', err)
      throw err
    }

    let currencyCode
    if (ctx.state.network === 'bitcoin') {
      currencyCode = 'BTC'
    } else if (ctx.state.network === 'litecoin') {
      currencyCode = 'LTC'
    } else {
      currencyCode = '???'
    }
    ctx.state.info = {
      prefix: ctx.state.prefix,
      // TODO set currency code based on network
      currencyCode,
      currencyScale: 8,
      connectors: [ ctx.state.prefix + ctx.state.peerPublicKey ]
    }

    debug('connected to lnd:', ctx.state.lndUri)
    ctx.state.connected = true
  },

  disconnect: async function (ctx) {
    debug('disconnect')
    // TODO do we need to disconnect ctx.state.lightning?
  },

  getAccount: (ctx) => ctx.state.account,
  getPeerAccount: (ctx) => ctx.state.peerAccount,
  getInfo: (ctx) => Object.assign({}, ctx.state.info),

  handleIncomingPrepare: async function (ctx, transfer) {
    const incoming = await ctx.transferLog.getIncomingFulfilledAndPrepared()
    const amountReceived = await ctx.state.incomingSettlements.getIncomingFulfilled()

    debug(`handleIncomingPrepare: total incoming so far: ${incoming}, amount received: ${amountReceived}, transfer amount: ${transfer.amount}`)

    const exceeds = new BigNumber(incoming)
      .minus(amountReceived)
      .greaterThan(ctx.state.maxUnsecured)

    if (exceeds) {
      throw new NotAcceptedError(transfer.id + ' exceeds max unsecured balance')
    }
  },

  createOutgoingClaim: async function (ctx, outgoingBalance) {
    const lastPaid = (await ctx.state.amountSettled.setIfMax({ value: outgoingBalance, data: null })).value
    const amountToPay = new BigNumber(outgoingBalance)
      .minus(lastPaid)

    debug(`createOutgoingClaim: last paid: ${lastPaid} amountToPay: ${amountToPay}`)

    if (amountToPay.lessThanOrEqualTo('0')) {
      return
    }

    let paymentRequest
    try {
      const rpcResponse = await ctx.rpc.call(GET_INVOICE_RPC_METHOD, ctx.state.prefix, amountToPay.toString())
      paymentRequest = rpcResponse.paymentRequest
      debug('got lightning payment request from peer:', paymentRequest)
    } catch (err) {
      debug('error getting lightning invoice from peer', err)
      throw err
    }

    const paymentPreimage = await payLightningInvoice(ctx.state.lightning, paymentRequest, amountToPay)

    return {
      amount: amountToPay,
      paymentPreimage
    }
  },

  handleIncomingClaim: async function (ctx, { amount, paymentPreimage }) {
    debug(`handleIncomingClaim for amount: ${amount}, paymentPreimage: ${paymentPreimage}`)
    // If the payment preimage doesn't match a settlement
    // we were waiting for we'll get a transfer not found error
    await ctx.state.incomingSettlements.fulfill(
      hashToUuid(hash(paymentPreimage)),
      paymentPreimage)
    debug(`received lightning payment for ${amount}`)
  }
})

async function payLightningInvoice (lightning, paymentRequest, amountToPay) {
  // TODO can we check how much it's going to cost before sending? what if the fees are really high?
  debug('sending lightning payment for payment request: ' + paymentRequest)

  // Check that the invoice amount matches the transfer amount
  const decodedReq = decodePaymentRequest(paymentRequest)
  const amountDiff = new BigNumber(decodedReq.amount).sub(amountToPay).absoluteValue()
  if (amountDiff.greaterThan(new BigNumber(amountToPay).times(0.05))) {
    debug('amounts in payment request and in transfer are significantly different:', decodedReq, amountToPay)
    throw new Error(`amounts in payment request and in transfer are significantly different. transfer amount: ${amountToPay}, payment request amount: ${decodedReq.amount}`)
  }

  let result
  try {
    result = await new Promise((resolve, reject) => {
      lightning.sendPaymentSync({
        payment_request: paymentRequest
      }, (err, res) => {
        if (err) return reject(err)
        resolve(res)
      })
    })
  } catch (err) {
    debug('error sending lightning payment for payment request:', paymentRequest, err)
    throw err
  }

  if (result.payment_route && result.payment_preimage) {
    const preimage = result.payment_preimage.toString('hex')
    debug('sent lightning payment for payment request: ' + paymentRequest + ', got payment preimage:', preimage)
    return preimage
  } else {
    debug('error sending lightning payment:', result)
    throw new Error('error sending payment:' + result.payment_error)
  }
}

async function createLightningInvoice (lightning, amount) {
  // TODO when should the lightning invoice expire?
  const invoice = await new Promise((resolve, reject) => {
    lightning.addInvoice({
      value: amount
    }, (err, res) => {
      if (err) return reject(err)
      resolve(res)
    })
  })
  return invoice
}

function hash (preimage) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(preimage, 'hex'))
  return h.digest()
}

function hashToUuid (hash) {
  const hex = Buffer.from(hash, 'hex').toString('hex')
  let chars = hex.substring(0, 36).split('')
  chars[8] = '-'
  chars[13] = '-'
  chars[14] = '4'
  chars[18] = '-'
  chars[19] = '8'
  chars[23] = '-'
  return chars.join('')
}
