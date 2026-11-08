'use strict'

/**
 * Text edit rules applied to strings, header maps and UTF-8 buffers.
 *
 * `createTextRewriter(store)` returns functions closing over a rule store;
 * the compiled rules come from the store, which also honours the global
 * enabled flag. Without a URL/phase context every compiled rule applies;
 * with one, rules are filtered by target (request/response/both) and URL
 * scope first.
 */

const { logDebug } = require('../util/logger')
const { isEmptyBuffer } = require('../codecs/compression')
const { printableRatio } = require('../codecs/protobuf')
const { buildUrlMatchContext, textRuleMatchesUrl } = require('./url-match')
const { replaceTextLiteral } = require('./schema')

/** @typedef {import('./store').RuleStore} RuleStore */
/** @typedef {import('./schema').CompiledTextRule} CompiledTextRule */
/** @typedef {import('./url-match').UrlMatchContext} UrlMatchContext */

/**
 * @typedef {object} TextRewriteResult
 * @property {string} text
 * @property {string[]} appliedRuleIds
 * @property {boolean} changed
 */

/**
 * @typedef {object} BufferRewriteResult
 * @property {Buffer} buffer
 * @property {string[]} appliedRuleIds
 * @property {boolean} changed
 * @property {string} [beforeText] Decoded text before the rewrite (only when changed).
 * @property {string} [afterText] Text after the rewrite (only when changed).
 */

/**
 * Apply a single compiled text edit rule to the provided string.
 *
 * Honours per-rule target (request/response/both) e l'eventuale URL scoping
 * prima di tentare la sostituzione. In caso di match aggiunge l'id della
 * regola a `appliedSet` e restituisce il testo aggiornato.
 *
 * @param {CompiledTextRule} compiled
 * @param {string} text
 * @param {Set<string>} appliedSet
 * @param {UrlMatchContext|null} [context]
 * @returns {{ text: string, changed: boolean }}
 */
function applyCompiledRuleToText(compiled, text, appliedSet, context) {
  const { rule, mode, useRegex, caseSensitive } = compiled

  // When a context is provided, honour per-rule target (request/response/both)
  // and optional URL scoping before attempting any text replacement.
  if (context && typeof context === 'object' && rule && typeof rule === 'object') {
    const phase = context.phase === 'response' ? 'response' : 'request'

    let target = 'both'
    if (rule.target === 'request' || rule.target === 'response' || rule.target === 'both') {
      target = rule.target
    }

    if (target === 'request' && phase === 'response') {
      return { text, changed: false }
    }
    if (target === 'response' && phase === 'request') {
      return { text, changed: false }
    }

    if (!textRuleMatchesUrl(rule, context)) {
      return { text, changed: false }
    }
  }

  if (useRegex) {
    if (!compiled.regex) {
      return { text, changed: false }
    }

    compiled.regex.lastIndex = 0
    let changed = false
    const next = text.replace(compiled.regex, () => {
      appliedSet.add(rule.id)
      changed = true
      return rule.replacement
    })

    return {
      text: next,
      changed
    }
  }

  let result
  if (mode === 'between') {
    result = replaceTextLiteral(text, compiled.start, compiled.end, rule.replacement, caseSensitive)
  } else if (mode === 'prefix') {
    result = replaceTextLiteral(text, compiled.start, null, rule.replacement, caseSensitive)
  } else {
    result = replaceTextLiteral(text, compiled.end, null, rule.replacement, caseSensitive)
  }

  if (result.count > 0) {
    appliedSet.add(rule.id)
    return {
      text: result.text,
      changed: true
    }
  }

  return {
    text,
    changed: false
  }
}

/**
 * Create the text rewriter bound to a rule store.
 *
 * @param {RuleStore} store
 */
function createTextRewriter(store) {
  /**
   * Apply every applicable compiled text rule, in order, to a string.
   *
   * @param {string} text
   * @param {UrlMatchContext|null} [context] Optional URL/phase context used for scoping.
   * @returns {TextRewriteResult}
   */
  function applyEditRulesToText(text, context) {
    if (typeof text !== 'string' || text.length === 0) {
      return { text, appliedRuleIds: [], changed: false }
    }

    // Optional URL/phase context is forwarded to individual rules so they can
    // implement scoping similar to JSONPath-based rules. When a context is
    // present, we pre-filter the compiled rules once per call to avoid
    // repeating phase/URL checks for every header/body value.
    const rawContext = context && typeof context === 'object' ? context : null
    const matchContext = rawContext ? buildUrlMatchContext(rawContext) : null

    const compiledRules = matchContext
      ? store.getCompiledRulesForContext(matchContext)
      : store.getCompiledRules()
    if (!compiledRules.length) {
      return { text, appliedRuleIds: [], changed: false }
    }

    /** @type {Set<string>} */
    const appliedSet = new Set()
    let current = text
    let changed = false

    for (const compiled of compiledRules) {
      const result = applyCompiledRuleToText(
        compiled,
        current,
        appliedSet,
        matchContext || rawContext
      )
      if (result.changed) {
        current = result.text
        changed = true
      }
    }

    return {
      text: current,
      appliedRuleIds: Array.from(appliedSet),
      changed
    }
  }

  /**
   * Apply edit rules to HTTP headers.
   *
   * Contract:
   * - Call this before sending any upstream request to allow header rewrites.
   * - Call this before sending upstream response headers back to the client.
   *
   * This keeps header rewrite behaviour consistent across proxy/MITM/bypass
   * flows without duplicating inline header-munging logic.
   *
   * @param {Record<string, any>} [headers]
   * @param {UrlMatchContext|null} [context]
   * @returns {{ headers: Record<string, any>, appliedRuleIds: string[], changed: boolean }}
   */
  function applyEditRulesToHeaders(headers = {}, context) {
    const rawContext = context && typeof context === 'object' ? context : null
    const matchContext = rawContext
      ? Array.isArray(rawContext.candidates)
        ? rawContext
        : buildUrlMatchContext(rawContext)
      : null

    const compiledRules = matchContext
      ? store.getCompiledRulesForContext(matchContext)
      : store.getCompiledRules()
    if (!compiledRules.length) {
      return { headers, appliedRuleIds: [], changed: false }
    }

    /** @type {Set<string>} */
    const appliedSet = new Set()
    /** @type {Record<string, any>} */
    const resultHeaders = {}
    let changed = false

    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        const updatedValues = value.map(entry => {
          if (typeof entry !== 'string') return entry
          let current = entry
          let entryChanged = false
          for (const compiled of compiledRules) {
            const result = applyCompiledRuleToText(
              compiled,
              current,
              appliedSet,
              matchContext || rawContext
            )
            if (result.changed) {
              current = result.text
              entryChanged = true
            }
          }
          if (entryChanged) changed = true
          return current
        })
        resultHeaders[key] = updatedValues
      } else if (typeof value === 'string') {
        let current = value
        let entryChanged = false
        for (const compiled of compiledRules) {
          const result = applyCompiledRuleToText(
            compiled,
            current,
            appliedSet,
            matchContext || rawContext
          )
          if (result.changed) {
            current = result.text
            entryChanged = true
          }
        }
        if (entryChanged) changed = true
        resultHeaders[key] = current
      } else {
        resultHeaders[key] = value
      }
    }

    return {
      headers: resultHeaders,
      appliedRuleIds: Array.from(appliedSet),
      changed
    }
  }

  /**
   * Apply text rules to a UTF-8 buffer. Clearly binary buffers are left
   * untouched; when the text changes, the decoded before/after snapshots are
   * returned for logging.
   *
   * @param {Buffer|null|undefined} buffer
   * @param {UrlMatchContext|null} [context]
   * @returns {BufferRewriteResult}
   */
  function applyEditRulesToBuffer(buffer, context) {
    if (isEmptyBuffer(buffer)) {
      return { buffer: /** @type {Buffer} */ (buffer), appliedRuleIds: [], changed: false }
    }
    const source = /** @type {Buffer} */ (buffer)

    // Skip clearly binary payloads to avoid wasted UTF-8 decoding and regex work.
    // This reuses the same printable heuristics used in protobuf paths.
    const ratio = printableRatio(source)
    if (ratio < 0.3) {
      return { buffer: source, appliedRuleIds: [], changed: false }
    }

    let text
    try {
      text = source.toString('utf8')
    } catch (error) {
      logDebug('applyEditRulesToBuffer', 'Failed to decode buffer as UTF‑8', error)
      return { buffer: source, appliedRuleIds: [], changed: false }
    }

    const { text: nextText, appliedRuleIds, changed } = applyEditRulesToText(text, context)
    if (!changed) {
      return { buffer: source, appliedRuleIds, changed: false }
    }

    return {
      buffer: Buffer.from(nextText, 'utf8'),
      appliedRuleIds,
      changed: true,
      // Structured text snapshots for before/after views when pure text rules
      // are applied outside of JSONPath contexts.
      beforeText: text,
      afterText: nextText
    }
  }

  return {
    applyCompiledRuleToText,
    applyEditRulesToText,
    applyEditRulesToHeaders,
    applyEditRulesToBuffer
  }
}

module.exports = { createTextRewriter, applyCompiledRuleToText }
