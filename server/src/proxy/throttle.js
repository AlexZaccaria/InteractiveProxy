'use strict'

/**
 * Network conditions applied by the proxy flows: the latency a rule adds
 * before the request is forwarded and the bandwidth cap on the response.
 *
 * The cap is a Transform that lets a fixed number of bytes through every
 * tick, so that a buffered body and a streamed one are paced the same way.
 */

const { Readable, Transform, pipeline } = require('stream')

/** Pacing interval of the bandwidth cap. */
const TICK_MS = 50

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * @param {number} kbps Kilobits per second.
 * @returns {number} Bytes per second (0 for no cap).
 */
function kbpsToBytesPerSecond(kbps) {
  return kbps > 0 ? Math.max(1, Math.floor((kbps * 1000) / 8)) : 0
}

/**
 * A Transform that lets about `bytesPerSecond` bytes through per second:
 * every chunk goes out in slices, one slice per tick.
 *
 * @param {number} bytesPerSecond
 * @returns {Transform}
 */
function createThrottleTransform(bytesPerSecond) {
  const perTick = Math.max(1, Math.floor((bytesPerSecond * TICK_MS) / 1000))
  return new Transform({
    transform(chunk, _encoding, callback) {
      let offset = 0
      const step = () => {
        if (offset >= chunk.length) {
          callback()
          return
        }
        const slice = chunk.subarray(offset, offset + perTick)
        offset += slice.length
        this.push(slice)
        if (offset >= chunk.length) {
          callback()
        } else {
          setTimeout(step, TICK_MS)
        }
      }
      step()
    }
  })
}

/**
 * Write a buffered body to the client through the bandwidth cap. The
 * status and the other headers must be set already; the content length is
 * set here when the headers are not out yet.
 *
 * @param {import('http').ServerResponse} res
 * @param {Buffer} buffer
 * @param {number} bytesPerSecond
 * @returns {Promise<Error | null>}
 */
function writeThrottled(res, buffer, bytesPerSecond) {
  if (!res.headersSent) res.setHeader('content-length', buffer.length)
  return new Promise(resolve => {
    pipeline(Readable.from([buffer]), createThrottleTransform(bytesPerSecond), res, error => {
      if (error && !res.writableEnded) res.destroy()
      resolve(error || null)
    })
  })
}

/**
 * @typedef {object} NetworkConditions
 * @property {number} delayMs
 * @property {number} throttleKbps
 * @property {number} bytesPerSecond 0 for no cap.
 * @property {{ ruleId: string, ruleName: string, delayMs: number, throttleKbps: number }} summary Recorded on the log entry.
 */

/**
 * @typedef {object} NetworkConditionsMatcher
 * @property {(context: { requestUrl: string, fullUrl: string }) => NetworkConditions | null} match
 */

/**
 * @param {{ store: import('../rules/throttle-store').ThrottleStore, isEnabled: () => boolean }} options
 * @returns {NetworkConditionsMatcher}
 */
function createNetworkConditions({ store, isEnabled }) {
  return {
    match({ requestUrl, fullUrl }) {
      if (!isEnabled()) return null
      const rule = store.match(requestUrl, fullUrl)
      if (!rule) return null
      return {
        delayMs: rule.delayMs,
        throttleKbps: rule.throttleKbps,
        bytesPerSecond: kbpsToBytesPerSecond(rule.throttleKbps),
        summary: {
          ruleId: rule.id,
          ruleName: rule.name,
          delayMs: rule.delayMs,
          throttleKbps: rule.throttleKbps
        }
      }
    }
  }
}

module.exports = {
  TICK_MS,
  sleep,
  kbpsToBytesPerSecond,
  createThrottleTransform,
  writeThrottled,
  createNetworkConditions
}
