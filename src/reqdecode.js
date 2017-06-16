// Library for decoding lnd payment requests
'use strict'

const zbase32 = require('./zbase32')
const Uint64BE = require('int64-buffer').Uint64BE
const crc32c = require('fast-crc32c')

const destinationLen = 33 // Byte length of public key
const paymentHashLen = 32 // Byte length of R-Hash
const amountLen = 8 // Byte length of amount
const crcLen = 4 // Byte length of CRC
const invoiceLen = destinationLen + paymentHashLen + amountLen // Byte length og invoice part
const totalExpectedLen = invoiceLen + crcLen

function decodePaymentRequest (req) {
  if (!(typeof req === 'string' || req instanceof String)) {
    throw new Error('payment request should be a string')
  }
  if (!req) {
    throw new Error('payment request should not be empty')
  }
  if (req.length < totalExpectedLen) {
    throw new Error('payment request is too short, length=' + req.length + ', need at least ' + totalExpectedLen)
  }
  const decoded = zbase32.decodeString(req)
  const invoice = decoded.slice(0, invoiceLen)
  const crc = decoded.slice(invoiceLen, totalExpectedLen)

  // Validate checksum
  const expectedCRC32C = crc[0] * 256 * 256 * 256 + crc[1] * 256 * 256 + crc[2] * 256 + crc[3]
  const actualCRC32C = crc32c.calculate(invoice)
  if (expectedCRC32C !== actualCRC32C) {
    throw new Error('Checksum mismatch')
  }

  const destination = decoded.slice(0, destinationLen)
  const paymentHash = decoded.slice(destinationLen, destinationLen + paymentHashLen)
  // Big-indian uint64 amount in Satoshis
  const amountByteArray = decoded.slice(destinationLen + paymentHashLen, destinationLen + paymentHashLen + amountLen)
  const amount = (new Uint64BE(amountByteArray)).toNumber()
  return {
    destination: destination,
    paymentHash: paymentHash,
    amount: amount
  }
}

exports.decodePaymentRequest = decodePaymentRequest
