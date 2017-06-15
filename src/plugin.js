'use strict'

const grpc = require('grpc')
const debug = require('debug')('ilp-plugin-lightning')
const EventEmitter = require('eventemitter2')
const shared = require('ilp-plugin-shared')
const crypto = require('crypto')
const InvalidFieldsError = shared.Errors.InvalidFieldsError
const NotAcceptedError = shared.Errors.NotAcceptedError

const lnrpcDescriptor = grpc.load(__dirname + '/rpc.proto')
const lnrpc = lnrpcDescriptor.lnrpc

module.exports = class PluginLightning extends EventEmitter {
  constructor ({
    outgoingAmount,
    rpcUri,
    timeout,
    peerPublicKey,
    lndUri,
    maxInFlight,
    network,
    _store,
  }) {
    super()

    if (!rpcUri) {
      throw new InvalidFieldsError('missing opts.rpcUri')
    } else if (!peerPublicKey) {
      throw new InvalidFieldsError('missing opts.peerPublicKey')
    } else if (!maxInFlight) {
      throw new InvalidFieldsError('missing opts.maxInFlight')
    } else if (!lndUri) {
      throw new InvalidFieldsError('missing opts.lndUri')
    } else if (!_store) {
      throw new InvalidFieldsError('missing opts._store')
    }

    this._peerPublicKey = peerPublicKey
    this._network = network

    // TODO: make the balance right, and have it be configurable
    this._inFlight = new shared.Balance({ store: _store, maximum: maxInFlight })
    this._transfers = new shared.TransferLog({ store: _store })
    this._validator = new shared.Validator({ plugin: this })
    this.isAuthorized = () => true
    this._rpc = new shared.HttpRpc({
      rpcUri: rpcUri,
      plugin: this,
      // TODO: shared secret or something
      authToken: 'placeholder'
    })

    // TODO add credentials
    this._lndUri = lndUri || 'localhost:10009'
    this._lightning = new lnrpc.Lightning(this._lndUri, grpc.credentials.createInsecure())

    this.receive = this._rpc.receive.bind(this._rpc)
    this._rpc.addMethod('send_message', this._handleSendMessage)
    this._rpc.addMethod('send_transfer', this._handleSendTransfer)
    this._rpc.addMethod('fulfill_condition', this._handleFulfillCondition)
    this._rpc.addMethod('reject_incoming_transfer', this._handleRejectIncomingTransfer)
  }

  async connect () {
    await this._inFlight.connect()

    try {
      debug('connecting to lnd:', this._lndUri)
      const lightningInfo = await new Promise((resolve, reject) => {
        this._lightning.getInfo({}, (err, info) => {
          if (err) return reject(err)
          resolve(info)
        })
      })
      debug('got lnd info:', lightningInfo)
      this._publicKey = lightningInfo.identity_pubkey
      this._network = this._network || lightningInfo.chains[0]
      //this._prefix = 'g.crypto.lightning.' + ((this._publicKey > this._peerPublicKey)
        //? this._publicKey + '~' + this._peerPublicKey
        //: this._peerPublicKey + '~' + this._publicKey) + '.'
      const scheme = lightningInfo.testnet
        ? 'test.'
        : 'g.'
      const neighborhood = this._network + '.lightning.'
      this._prefix = scheme + neighborhood
    } catch (err) {
      debug('error connecting to lnd', err)
      throw err
    }

    debug('connected to lnd:', this._lndUri)
    this._connected = true
    shared.Util.safeEmit(this, 'connect')
  }

  isConnected () {
    return !!this._connected
  }

  async disconnect () {
    shared.Util.safeEmit(this, 'disconnect')
  }

  getAccount () {
    return this._prefix + this._publicKey
  }

  async getBalance () {
    const balance = await new Promise((resolve, reject) => {
      this._lightning.channelBalance({}, (err, res) => {
        if (err) return reject(err)
        resolve(res.balance)
      })
    })
    debug('channel balance:', balance)
    return balance
  }

  getInfo () {
    let currencyCode
    if (this._network === 'bitcoin') {
      currencyCode = 'BTC'
    } else if (this._network === 'litecoin') {
      currencyCode = 'LTC'
    } else {
      currencyCode = '???'
    }
    return {
      prefix: this._prefix,
      // TODO set currency code based on network
      currencyCode,
      currencyScale: 8,
      connectors: [ this._prefix + this._peerPublicKey ]
    }
  }

  async sendMessage (_message) {
    const message = this._validator.normalizeOutgoingMessage(_message)
    await this._rpc.call('send_message', this._prefix, [ message ])
    shared.Util.safeEmit(this, 'outgoing_message', message)
  }

  async _handleSendMessage (_message) {
    const message = this._validator.normalizeIncomingMessage(_message)
    shared.Util.safeEmit(this, 'incoming_message', message)
    return true
  }

  async sendTransfer (_transfer) {
    const transfer = this._validator.normalizeOutgoingTransfer(_transfer)
    // TODO: wrap these into just one method
    const noRepeat = (this._transfers.cacheOutgoing(transfer) &&
      (await this._transfers.notInStore(transfer)))

    // TODO if this is a repeat transfer, is this going to cause us to send it twice?
    await this._rpc.call('send_transfer', this._prefix, [
      // TODO: util method for this?
      Object.assign({}, transfer, { noteToSelf: undefined })
    ])
    debug(transfer.id + ' acknowledged by peer')

    // TODO: is all this repeat stuff totally necessary?
    if (!noRepeat) return

    shared.Util.safeEmit(this, 'outgoing_prepare', transfer)
    this._setupTransferExpiry(transfer.id, transfer.expiresAt)
  }

  async _handleSendTransfer (_transfer) {
    const transfer = this._validator.normalizeIncomingTransfer(_transfer)
    // TODO: wrap these into just one method
    const noRepeat = (this._transfers.cacheIncoming(transfer) &&
      (await this._transfers.notInStore(transfer)))

    if (!noRepeat) return true

    await this._inFlight.add(transfer.amount)
      .catch((e) => {
        this._transfers.cancel(transfer.id)
        throw e
      })

    shared.Util.safeEmit(this, 'incoming_prepare', transfer)
    this._setupTransferExpiry(transfer.id, transfer.expiresAt)
    return true
  }

  async fulfillCondition (transferId, fulfillment) {
    // TODO: check out that method
    this._validator.validateFulfillment(fulfillment)

    // TODO: what even is this construct and why did I do it
    const error = this._transfers.assertAllowedChange(transferId, 'executed')
    if (error) {
      await error
      await this._rpc.call('fulfill_condition', this._prefix, [ transferId, fulfillment ])
      return
    }

    // TODO: what does this do and is it needed?
    this._transfers.assertIncoming(transferId)
    // TODO: make the error on this better when the transfer isn't found
    const transfer = this._transfers.get(transferId)
    shared.Util.safeEmit(this, 'incoming_fulfill', transfer, fulfillment)

    // Generate a lightning invoice and give it to the sender along with the fulfillment
    const lightningInvoice = await this._createLightningInvoice(transfer)
    let paymentPreimage
    try {
      paymentPreimage = await this._rpc.call('fulfill_condition', this._prefix, [transferId, fulfillment, lightningInvoice.payment_request])
      if (Buffer.compare(hash(paymentPreimage), lightningInvoice.r_hash) !== 0) {
        debug(`lightning payment preimage does not match invoice. preimage received: ${paymentPreimage}, invoice hash: ${lightningInvoice.r_hash.toString('hex')}`)
        throw new Error('lightning invoice was not paid, got paymentPreimage: ' + JSON.stringify(paymentPreimage))
      }
    } catch (err) {
      debug('failed to get claim from peer. keeping the in-flight balance up.', err)
      return
    }
    debug(`peer paid us ${transfer.amount} for transfer: ${transfer.id}, payment preimage: ${paymentPreimage}`)
    this._transfers.fulfill(transferId, fulfillment)
  }

  async _handleFulfillCondition (transferId, fulfillment, lightningInvoice) {
    this._validator.validateFulfillment(fulfillment)

    const error = this._transfers.assertAllowedChange(transferId, 'executed')
    if (error) {
      await error
      // TODO: return an error instead, so it gives better error?
      return true
    }

    this._transfers.assertOutgoing(transferId)
    const transfer = this._transfers.get(transferId)
    transfer.direction = 'outgoing' // the connector needs this for whatever reason
    debug('fetched transfer for fulfill:', transfer)

    this._validateFulfillment(fulfillment, transfer.executionCondition)
    this._transfers.fulfill(transferId, fulfillment)
    debug('fulfilled from store')
    shared.Util.safeEmit(this, 'outgoing_fulfill', transfer, fulfillment)

    // TODO validate that invoice matches transfer
    const paymentPreimage = await this._payLightningInvoice(lightningInvoice, transfer)
    return paymentPreimage
  }

  _validateFulfillment (fulfillment, condition) {
    const hash = shared.Util.base64url(crypto
      .createHash('sha256')
      .update(Buffer.from(fulfillment, 'base64'))
      .digest())

    // TODO: validate the condition to make sure it's base64url
    if (hash !== condition) {
      throw new NotAcceptedError('fulfillment ' + fulfillment +
        ' does not match condition ' + condition)
    }
  }

  async rejectIncomingTransfer (transferId, reason) {
    const error = this._transfers.assertAllowedChange(transferId, 'cancelled')
    if (error) {
      await error
      await this._rpc.call('reject_incoming_transfer', this._prefix, [transferId, reason])
      return
    }

    debug('rejecting', transferId)
    this._transfers.assertIncoming(transferId)
    const transfer = this._transfers.get(transferId)

    this._transfers.cancel(transferId)
    shared.Util.safeEmit(this, 'incoming_reject', transfer)
    await this._inFlight.sub(transfer.amount)
    await this._rpc.call('reject_incoming_transfer', this._prefix, [ transferId, reason ])
  }

  async _handleRejectIncomingTransfer (transferId, reason) {
    const error = this._transfers.assertAllowedChange(transferId, 'cancelled')
    if (error) {
      await error
      return true
    }

    this._transfers.assertOutgoing(transferId)
    const transfer = this._transfers.get(transferId)

    this._transfers.cancel(transferId)
    shared.Util.safeEmit(this, 'outgoing_reject', transfer)
    return true
  }

  _setupTransferExpiry (transferId, expiresAt) {
    debug(`set transfer ${transferId} to expire at ${expiresAt}`)
    const expiry = Date.parse(expiresAt)
    const now = Date.now()

    setTimeout(
      this._expireTransfer.bind(this, transferId),
      (expiry - now))
  }

  async _expireTransfer (transferId) {
    debug('checking expiry on ' + transferId)

    // TODO: use a less confusing construct
    try {
      const error = this._transfers.assertAllowedChange(transferId, 'cancelled')
      if (error) {
        await error
        return
      }
    } catch (e) {
      debug(e.message)
      return
    }

    const cached = this._transfers._getCachedTransferWithInfo(transferId)
    this._transfers.cancel(transferId)
    debug(`expired transfer ${transferId}`)

    if (cached.isIncoming) {
      this._inFlight.sub(cached.transfer.amount)
    }

    shared.Util.safeEmit(this, (cached.isIncoming ? 'incoming' : 'outgoing') + '_cancel',
      cached.transfer)
  }

  async _createLightningInvoice (transfer) {
    // TODO when should the lightning invoice expire?
    const invoice = await new Promise((resolve, reject) => {
      this._lightning.addInvoice({
        value: transfer.amount,
        payment_request: transfer.id
      }, (err, res) => {
        if (err) return reject(err)
        resolve(res)
      })
    })
    debug('created lightning invoice:', invoice, 'for transfer:', transfer)
    return invoice
  }

  async _payLightningInvoice (paymentRequest, transfer) {
    // TODO check to make sure invoice isn't more than transfer amount
    // TODO can we check how much it's going to cost before sending? what if the fees are really high?
    debug('sending lightning payment for payment request: ' + paymentRequest)
    let result
    try {
      result = await new Promise((resolve, reject) => {
        this._lightning.sendPaymentSync({
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
      debug('sent lightning payment for payment request: ' + paymentRequest + ', got payment preimage:', result.payment_preimage.toString('hex'))
      return result.payment_preimage.toString('hex')
    } else {
      debug('error sending lightning payment:', result)
      throw new Error('error sending payment:' + result.payment_error)
    }
  }
}

function hash (preimage) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(preimage, 'base64'))
  return h.digest()
}

