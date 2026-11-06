'use strict'

/**
 * Hand-written WebSocket framing used on the client side of relayed
 * connections: the Sec-WebSocket-Accept handshake value, http(s) -> ws(s)
 * URL conversion, and encoding/decoding of single data frames.
 *
 * Known limits, asserted as current behaviour by the tests and scheduled to
 * disappear with the move to `ws` (IMPROVEMENT-PLAN.md B4/B19): one frame
 * per buffer, no fragment reassembly, control frames reported as data
 * frames, outgoing frames never masked.
 */

const crypto = require('crypto')

// Constant GUID used for WebSocket Sec-WebSocket-Accept computation
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * A decoded frame.
 *
 * @typedef {object} DecodedWebSocketFrame
 * @property {boolean} isFinal FIN bit.
 * @property {number} opcode Opcode (1 text, 2 binary, 8 close, 9 ping, 10 pong, 0 continuation).
 * @property {boolean} isBinary True for opcode 2.
 * @property {Buffer} payload Unmasked payload.
 */

/**
 * Compute the Sec-WebSocket-Accept value for a client key (RFC 6455 §4.2.2).
 *
 * @param {string} key Sec-WebSocket-Key header value.
 * @returns {string}
 */
function generateWebSocketAccept (key) {
  return crypto.createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64')
}

/**
 * Convert an HTTP(S) URL string to its WebSocket equivalent. Existing ws:/wss:
 * URLs are returned unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
function httpUrlToWebSocketUrl (url = '') {
  if (!url) return ''
  if (/^wss?:\/\//i.test(url)) return url
  // Only the scheme at the start is rewritten, never a URL inside the query.
  return url.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://')
}

/**
 * Encode a single final, unmasked data frame (server-to-client direction).
 *
 * @param {string | Uint8Array} data Payload.
 * @param {boolean} isBinary Binary (opcode 2) or text (opcode 1) frame.
 * @returns {Buffer}
 */
function createWebSocketFrame (data, isBinary) {
  const payload = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
  const payloadLength = payload.length
  let frame

  if (payloadLength < 126) {
    frame = Buffer.allocUnsafe(2 + payloadLength)
    frame[0] = isBinary ? 0x82 : 0x81 // FIN + opcode
    frame[1] = payloadLength
    payload.copy(frame, 2)
  } else if (payloadLength < 65536) {
    frame = Buffer.allocUnsafe(4 + payloadLength)
    frame[0] = isBinary ? 0x82 : 0x81
    frame[1] = 126
    frame.writeUInt16BE(payloadLength, 2)
    payload.copy(frame, 4)
  } else {
    frame = Buffer.allocUnsafe(10 + payloadLength)
    frame[0] = isBinary ? 0x82 : 0x81
    frame[1] = 127
    frame.writeUInt32BE(0, 2)
    frame.writeUInt32BE(payloadLength, 6)
    payload.copy(frame, 10)
  }

  return frame
}

/**
 * Decode the first frame found at the start of a buffer, unmasking it when
 * the mask bit is set. Returns null when the buffer does not hold a whole
 * frame.
 *
 * @param {Buffer} buffer
 * @returns {DecodedWebSocketFrame|null}
 */
function decodeWebSocketFrame (buffer) {
  if (buffer.length < 2) return null

  const firstByte = buffer[0]
  const secondByte = buffer[1]

  const isFinal = (firstByte & 0x80) !== 0
  const opcode = firstByte & 0x0F
  const isMasked = (secondByte & 0x80) !== 0
  let payloadLength = secondByte & 0x7F
  let offset = 2

  if (payloadLength === 126) {
    if (buffer.length < 4) return null
    payloadLength = buffer.readUInt16BE(2)
    offset = 4
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null
    payloadLength = buffer.readUInt32BE(6)
    offset = 10
  }

  /** @type {Buffer|undefined} */
  let maskingKey
  if (isMasked) {
    if (buffer.length < offset + 4) return null
    maskingKey = buffer.slice(offset, offset + 4)
    offset += 4
  }

  if (buffer.length < offset + payloadLength) return null

  let payload = buffer.slice(offset, offset + payloadLength)

  if (isMasked && maskingKey) {
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskingKey[i % 4]
    }
  }

  return {
    isFinal,
    opcode,
    isBinary: opcode === 2,
    payload
  }
}

module.exports = {
  WEBSOCKET_GUID,
  generateWebSocketAccept,
  httpUrlToWebSocketUrl,
  createWebSocketFrame,
  decodeWebSocketFrame
}
