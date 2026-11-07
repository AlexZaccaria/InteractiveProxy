'use strict'

/**
 * Streaming of upstream responses: the decision (does anything need the
 * whole body before it can be forwarded?) and the mechanics (pipe the
 * upstream body to the client while counting the bytes).
 *
 * A response is streamed when no edit/JSONPath rule can apply to it and the
 * body does not need to be inspected for logging: interactive logging is off,
 * or the content is clearly binary, an event stream, or larger than
 * `PROXY_STREAM_THRESHOLD_BYTES`. Everything else keeps the buffered path,
 * where bodies are decoded, rewritten and previewed.
 */

const { pipeline, Transform } = require('stream')
const { STREAM_UNINSPECTED_RESPONSES, STREAM_THRESHOLD_BYTES } = require('../../config')
const { isClearlyBinaryContentType } = require('../codecs/compression')
const { buildUrlMatchContext, jsonPathRuleMatchesUrl } = require('../rules/url-match')

/** @typedef {import('../rules/store').RuleStore} RuleStore */

/** Marker stored as the logged body of a streamed response. */
const STREAMED_BODY_MARKER = '[streamed response]'

/**
 * Whether any text or JSONPath rule can apply to the body of this URL in
 * this phase. Rules without a URL pattern count as applicable.
 *
 * @param {RuleStore} ruleStore
 * @param {{ requestUrl?: string, fullUrl?: string, phase: 'request' | 'response' }} context
 * @returns {boolean}
 */
function hasApplicableRules(ruleStore, context) {
  const matchContext = buildUrlMatchContext(context)
  if (ruleStore.getCompiledRulesForContext(matchContext).length > 0) return true

  for (const rule of ruleStore.getCompiledJsonPathRules()) {
    const target = rule.target === 'response' || rule.target === 'both' ? rule.target : 'request'
    if (target === 'request' && context.phase !== 'request') continue
    if (target === 'response' && context.phase !== 'response') continue
    if (jsonPathRuleMatchesUrl(rule, matchContext)) return true
  }

  return false
}

/**
 * @typedef {object} StreamDecisionInput
 * @property {string} [method] Request method; HEAD responses are never streamed.
 * @property {string} [contentType] Upstream `content-type`.
 * @property {string | number | undefined} [contentLength] Upstream `content-length`.
 * @property {boolean} hasRules Whether a rule can apply to the body (see hasApplicableRules).
 * @property {boolean} interactive Whether interactive logging is on.
 */

/**
 * Decide whether an upstream response can be piped to the client as it
 * arrives.
 *
 * @param {StreamDecisionInput} input
 * @returns {boolean}
 */
function shouldStreamResponse({ method, contentType, contentLength, hasRules, interactive }) {
  if (!STREAM_UNINSPECTED_RESPONSES) return false
  if (method === 'HEAD') return false
  if (hasRules) return false
  if (!interactive) return true

  const lowerType = String(contentType || '').toLowerCase()
  if (lowerType.includes('text/event-stream')) return true
  if (isClearlyBinaryContentType(lowerType)) return true

  const length = Number(contentLength)
  return STREAM_THRESHOLD_BYTES > 0 && Number.isFinite(length) && length > STREAM_THRESHOLD_BYTES
}

/**
 * Pipe an upstream body to the client response, counting the bytes. The
 * headers must already have been written (or set) by the caller. Resolves
 * when the pipe is over, with the byte count and the error, if any: a client
 * that goes away or an upstream failure mid-stream destroys the client
 * response (the headers are out, a status can no longer be sent).
 *
 * @param {import('stream').Readable} body
 * @param {import('http').ServerResponse} res
 * @returns {Promise<{ bytes: number, error: Error | null }>}
 */
function pipeUpstreamBody(body, res) {
  let bytes = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      callback(null, chunk)
    }
  })

  return new Promise(resolve => {
    pipeline(body, counter, res, error => {
      if (error && !res.writableEnded) {
        res.destroy()
      }
      resolve({ bytes, error: error || null })
    })
  })
}

module.exports = {
  STREAMED_BODY_MARKER,
  hasApplicableRules,
  shouldStreamResponse,
  pipeUpstreamBody
}
