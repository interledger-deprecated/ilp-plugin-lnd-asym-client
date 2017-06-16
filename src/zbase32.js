// Implementation of zbase32 decoding
// It is port (slightly modified) copy-paste github.com/tv42/zbase32
// It was created because it seems like https://www.npmjs.com/package/zbase32 give wrong results

'use strict'

function decodedLen (n) {
  return Math.floor((n * 1 + 7) / 8) * 5
}

const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769'

function createDecodeMap () {
  let decodeMap = {}
  for (let i = 0; i < 256; i++) {
    decodeMap[String.fromCharCode(i)] = 0xFF
  }
  for (let i = 0; i < alphabet.length; i++) {
    decodeMap[alphabet[i]] = i
  }
  return decodeMap
}

const decodeMap = createDecodeMap()

function decodeString (src) {
  let dst = new Uint8Array(decodedLen(src.length))
  let olen = src.length
  let off = 0
  let bits = -1
  for (; src.length > 0;) {
    // Decode quantum using the z-base-32 alphabet
    let dbuf = new Uint8Array(8)

    let j = 0
    for (; j < 8; j++) {
      if (src.length === 0) {
        break
      }
      let in1 = src[0]
      src = src.substring(1)
      dbuf[j] = decodeMap[in1]
      if (dbuf[j] === 0xFF) {
        throw Error('String is corrupted at ' + (olen - src.length - 1))
      }
    }

    // 8x 5-bit source blocks, 5 byte destination quantum
    dst[off + 0] = dbuf[0] << 3 | dbuf[1] >> 2
    dst[off + 1] = dbuf[1] << 6 | dbuf[2] << 1 | dbuf[3] >> 4
    dst[off + 2] = dbuf[3] << 4 | dbuf[4] >> 1
    dst[off + 3] = dbuf[4] << 7 | dbuf[5] << 2 | dbuf[6] >> 3
    dst[off + 4] = dbuf[6] << 5 | dbuf[7]

    // bits < 0 means as many bits as there are in src
    if (bits < 0) {
      let lookup = [0, 1, 1, 2, 2, 3, 4, 4, 5]
      off += lookup[j]
      continue
    }
    let bitsInBlock = bits
    if (bitsInBlock > 39) {
      bitsInBlock = 40
    }
    off += Math.floor((bitsInBlock + 7) / 8)
    bits -= 40
  }
  return dst.subarray(0, off)
}

exports.decodedLen = decodedLen
exports.decodeString = decodeString
