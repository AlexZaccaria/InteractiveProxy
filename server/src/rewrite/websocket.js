'use strict'

/**
 * WebSocket message rewrites: text rules over text frames and JSONPath rules
 * over the JSON part of a frame (Socket.IO-style prefixes preserved), with
 * the textual description used for logging.
 *
 * `createWebSocketRewriter` returns functions bound to one rule store and its
 * text/JSONPath rewriters. Nothing here is module-level state.
 */

const { WS_MAX_TEXT_BYTES } = require('../../config')
const { logDebug } = require('../util/logger')
const { hasAppliedRules } = require('../rules/metadata')
const { printableRatio } = require('../codecs/protobuf')
const { normalizeWebSocketPayload, normalizeNestedJsonStrings } = require('../logs/preview')

/** @typedef {import('../rules/store').RuleStore} RuleStore */
/** @typedef {ReturnType<typeof import('../rules/text-rules').createTextRewriter>} TextRewriter */
/** @typedef {ReturnType<typeof import('../rules/jsonpath').createJsonPathRewriter>} JsonPathRewriter */
/** @typedef {import('../rules/url-match').UrlMatchContext} UrlMatchContext */

/**
 * @typedef {object} WebSocketRewriteResult
 * @property {Buffer} buffer
 * @property {string[]} appliedRuleIds
 * @property {boolean} changed
 */

/**
 * @typedef {object} WebSocketDescribedPayload
 * @property {Buffer} buffer Final (possibly rewritten) payload.
 * @property {string[]|null} rewrites Ids of the rules that applied, or null.
 * @property {string} body Textual body for logging (placeholder for binary frames).
 * @property {string|null} originalBody Text before the rewrites, when decoded.
 * @property {any} jsonAfter Parsed JSON view of the final body, when available.
 */

/**
 * @typedef {object} WebSocketRewriterDeps
 * @property {RuleStore} ruleStore
 * @property {TextRewriter} textRules
 * @property {JsonPathRewriter} jsonPathRules
 */

/**
 * Create the WebSocket rewrite helpers bound to one rule store.
 *
 * @param {WebSocketRewriterDeps} deps
 */
function createWebSocketRewriter ({ ruleStore, textRules, jsonPathRules }) {
  /**
   * Apply text edit rules to a WebSocket payload that has already been
   * normalised into a Buffer by higher-level helpers.
   *
   * Binary frames are passed through unchanged; for text frames this will
   * optionally rewrite the UTF-8 content according to the active text rules
   * while preserving the original byte-level framing.
   *
   * @param {Buffer|null|undefined} payloadBuffer - Normalised WebSocket payload buffer.
   * @param {boolean} isBinary - Whether the frame is binary.
   * @param {UrlMatchContext|null} [context]
   * @returns {WebSocketRewriteResult}
   */
  function rewriteWebSocketPayload (payloadBuffer, isBinary, context) {
    if (!payloadBuffer || !Buffer.isBuffer(payloadBuffer) || payloadBuffer.length === 0) {
      const emptyBuffer = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.alloc(0)
      return { buffer: emptyBuffer, appliedRuleIds: [], changed: false }
    }

    if (isBinary) {
      return { buffer: payloadBuffer, appliedRuleIds: [], changed: false }
    }

    // Avoid attempting text rewrites on obviously binary WebSocket frames, even
    // when they are reported as non-binary.
    const wsPrintableRatio = printableRatio(payloadBuffer)
    if (wsPrintableRatio < 0.3) {
      return { buffer: payloadBuffer, appliedRuleIds: [], changed: false }
    }

    let text
    try {
      text = payloadBuffer.toString('utf8')
    } catch (error) {
      logDebug('rewriteWebSocketPayload', 'Failed to decode WebSocket payload as UTF‑8', error)
      return { buffer: payloadBuffer, appliedRuleIds: [], changed: false }
    }

    const rewriteResult = textRules.applyEditRulesToText(text, context)
    if (!rewriteResult.changed) {
      return { buffer: payloadBuffer, appliedRuleIds: [], changed: false }
    }

    return {
      buffer: Buffer.from(rewriteResult.text, 'utf8'),
      appliedRuleIds: rewriteResult.appliedRuleIds || [],
      changed: true
    }
  }

  /**
   * Apply text edit rules to a WebSocket payload and build a human-readable body
   * description for logging. The payload is normalised to a Buffer, optionally
   * rewritten (for text frames) and then decoded once as UTF‑8 for logging.
   *
   * Binary frames are never rewritten and are represented by a size-only
   * placeholder string.
   *
   * @param {unknown} payload
   * @param {boolean} isBinary
   * @param {UrlMatchContext|null} [context]
   * @returns {WebSocketDescribedPayload}
   */
  function applyWebSocketRewritesAndDescribe (payload, isBinary, context) {
    let payloadBuffer = normalizeWebSocketPayload(payload)

    /** @type {string[]|null} */
    let rewrites = null
    /** @type {string|null} */
    let originalBody = null
    let payloadMutatedByTextRules = false
    /** @type {any} */
    let jsonAfter = null

    const tooLargeTextFrame =
      !isBinary &&
      WS_MAX_TEXT_BYTES > 0 &&
      payloadBuffer.length > WS_MAX_TEXT_BYTES

    // Only attempt rewrites on reasonably-sized text frames when we have
    // compiled rules. This avoids decoding and scanning frames when edit rules
    // or JSONPath rules are disabled.
    if (!isBinary && !tooLargeTextFrame) {
      const compiledTextRules = ruleStore.getCompiledRules()
      const compiledJsonPathRulesLocal = ruleStore.getCompiledJsonPathRules()

      const hasTextRules = Array.isArray(compiledTextRules) && compiledTextRules.length > 0
      const hasJsonPathRules = Array.isArray(compiledJsonPathRulesLocal) && compiledJsonPathRulesLocal.length > 0

      // Capture the original textual payload (before any rewrites) so that the
      // UI can render a true "before rewrite" preview for WebSocket messages.
      try {
        originalBody = payloadBuffer.toString('utf8')
      } catch (error) {
        logDebug('applyWebSocketRewritesAndDescribe', 'Failed to decode original WebSocket payload as UTF‑8', error)
        originalBody = null
      }

      // 1) Apply legacy text rules over the WebSocket frame payload.
      if (hasTextRules) {
        const rewriteResult = rewriteWebSocketPayload(payloadBuffer, false, context)
        if (rewriteResult && Buffer.isBuffer(rewriteResult.buffer)) {
          if (rewriteResult.changed) {
            payloadBuffer = rewriteResult.buffer
            payloadMutatedByTextRules = true
          }

          if (hasAppliedRules(rewriteResult.appliedRuleIds)) {
            rewrites = Array.isArray(rewrites) ? rewrites : []
            for (const id of rewriteResult.appliedRuleIds) {
              if (!id) continue
              if (!rewrites.includes(id)) rewrites.push(id)
            }
          }
        }
      }

      // 2) Apply JSONPath rules when the frame body contains JSON and rules are
      // configured for the current URL/phase context.
      if (hasJsonPathRules) {
        /** @type {string|null} */
        let textForJson = null

        if (payloadMutatedByTextRules || !originalBody) {
          try {
            textForJson = payloadBuffer.toString('utf8')
          } catch (error) {
            logDebug('applyWebSocketRewritesAndDescribe', 'Failed to decode WebSocket payload as UTF‑8 for JSONPath', error)
          }
        } else {
          textForJson = originalBody
        }

        if (typeof textForJson === 'string') {
          // WebSocket payloads (especially Socket.IO) often prefix JSON with an
          // envelope like "42/ws/character," or "0". To support JSONPath
          // rules on these frames, locate the first JSON structure character and
          // parse only that tail while preserving the original prefix.

          const firstBrace = textForJson.indexOf('{')
          const firstBracket = textForJson.indexOf('[')

          const jsonStartIndex =
            firstBrace === -1
              ? firstBracket
              : firstBracket === -1
                ? firstBrace
                : Math.min(firstBrace, firstBracket)

          if (jsonStartIndex !== -1) {
            const prefix = textForJson.slice(0, jsonStartIndex)
            const jsonText = textForJson.slice(jsonStartIndex)

            try {
              const parsed = JSON.parse(jsonText)
              const normalizedParsed = normalizeNestedJsonStrings(parsed)

              /** @type {UrlMatchContext} */
              const jsonPathContext = {
                ...(context && typeof context === 'object' ? context : {}),
                phase: context && typeof context.phase === 'string' ? context.phase : 'request'
              }

              const jsonResult = jsonPathRules.applyJsonPathRulesToObject(normalizedParsed, jsonPathContext)
              if (jsonResult && jsonResult.changed) {
                const updatedObject = jsonResult.object
                const updatedText = prefix + JSON.stringify(updatedObject)
                payloadBuffer = Buffer.from(updatedText, 'utf8')
                jsonAfter = updatedObject

                if (hasAppliedRules(jsonResult.appliedRuleIds)) {
                  rewrites = Array.isArray(rewrites) ? rewrites : []
                  for (const id of jsonResult.appliedRuleIds) {
                    if (!id) continue
                    if (!rewrites.includes(id)) rewrites.push(id)
                  }
                }
              } else {
                // Even when no rule changed the payload, keep a parsed JSON
                // snapshot so WebSocket logging can reuse it without reparsing.
                jsonAfter = normalizedParsed
              }
            } catch (error) {
              logDebug('applyWebSocketRewritesAndDescribe', 'Failed to parse WebSocket JSON payload for JSONPath', error)
            }
          }
        }
      }
    }

    let body
    if (isBinary) {
      body = `[Binary data: ${payloadBuffer.length} bytes]`
    } else if (tooLargeTextFrame) {
      body = `[WebSocket text frame too large for rewrite: ${payloadBuffer.length} bytes, limit=${WS_MAX_TEXT_BYTES}]`
    } else {
      // Single UTF‑8 decode shared between rewrites and logging.
      body = payloadBuffer.toString('utf8')
    }

    return { buffer: payloadBuffer, rewrites, body, originalBody, jsonAfter }
  }

  return { rewriteWebSocketPayload, applyWebSocketRewritesAndDescribe }
}

module.exports = { createWebSocketRewriter }
