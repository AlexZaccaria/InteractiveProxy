'use strict'

/**
 * Edit-rule store: owns the live rules and presets, their persistence, the
 * global enabled flag, the compiled caches used on hot paths and the per-rule
 * usage counters that the UI joins with the rule list.
 *
 * Nothing here is module-level state: `createRuleStore` returns one
 * self-contained instance and the rewriters (`./text-rules`, `./jsonpath`)
 * close over it.
 */

const fs = require('fs')
const fsPromises = fs.promises
const { safeString } = require('../util/strings')
const { logWarn } = require('../util/logger')
const { buildUrlMatchContext, textRuleMatchesUrl } = require('./url-match')
const {
  deserializeEditRuleFromDisk,
  normalizeEditRule,
  normalizeEditRulePreset,
  serializeEditRuleForDisk,
  parseJsonPath,
  compileEditRule
} = require('./schema')

/** @typedef {import('./schema').EditRule} EditRule */
/** @typedef {import('./schema').EditRulePreset} EditRulePreset */
/** @typedef {import('./schema').CompiledTextRule} CompiledTextRule */
/** @typedef {import('./schema').CompiledJsonPathRule} CompiledJsonPathRule */
/** @typedef {import('./schema').JsonPathValueType} JsonPathValueType */
/** @typedef {import('./schema').RuleTarget} RuleTarget */
/** @typedef {import('./url-match').UrlMatchContext} UrlMatchContext */

/**
 * @typedef {object} RuleStoreLogger
 * @property {(scope: string, message: string) => void} warn
 * @property {(...args: any[]) => void} error
 */

/**
 * @typedef {object} RuleStoreOptions
 * @property {string} rulesFile Path of edit-rules.json.
 * @property {string} presetsFile Path of edit-rule-presets.json.
 * @property {string} storageDir Directory that file-backed rule values are resolved against.
 * @property {RuleStoreLogger} [logger]
 */

/**
 * @typedef {object} RuleStore
 * @property {string} storageDir
 * @property {() => void} load Load rules from disk (does not rebuild the caches).
 * @property {() => Promise<void>} save
 * @property {() => void} loadPresets
 * @property {() => Promise<void>} savePresets
 * @property {() => EditRule[]} getRules The live array.
 * @property {(rules: Record<string, any>[]) => EditRule[]} replaceRules Normalise, replace and rebuild.
 * @property {(id: string) => EditRule | undefined} findRule
 * @property {(raw: Record<string, any>) => EditRule} addRule Normalise (new id), append, rebuild.
 * @property {(id: string, patch: Record<string, any>) => EditRule | null} updateRule
 * @property {(id: string) => boolean} removeRule Also drops the rule's usage counter.
 * @property {() => EditRulePreset[]} getPresets
 * @property {(raw: Record<string, any>) => EditRulePreset} addPreset
 * @property {(id: string) => boolean} removePreset
 * @property {() => void} rebuildCache
 * @property {() => boolean} isEnabled
 * @property {(value: boolean) => void} setEnabled
 * @property {() => CompiledTextRule[]} getCompiledRules Empty when the engine is disabled.
 * @property {(context: UrlMatchContext | null | undefined) => CompiledTextRule[]} getCompiledRulesForContext
 * @property {() => CompiledJsonPathRule[]} getCompiledJsonPathRules Empty when the engine is disabled.
 * @property {() => boolean} hasCompiledTextRules
 * @property {() => boolean} hasCompiledJsonPathRules
 * @property {() => boolean} hasAnyEditOrJsonPathRules
 * @property {(id: string) => void} recordUsage One more log entry where the rule applied.
 * @property {(ids: Iterable<unknown>) => void} releaseUsage Log entries evicted: decrement, drop at zero.
 * @property {() => { usage: Record<string, number>, totalRulesWithUsage: number }} getUsageSnapshot
 * @property {() => void} clearUsage
 */

/**
 * Create an edit-rule store.
 *
 * @param {RuleStoreOptions} options
 * @returns {RuleStore}
 */
function createRuleStore ({ rulesFile, presetsFile, storageDir, logger }) {
  /** @type {RuleStoreLogger} */
  const log = logger || {
    warn: (scope, message) => logWarn(scope, message),
    error: (...args) => console.error(...args)
  }

  /** @type {EditRule[]} */
  let rules = []
  /** @type {EditRulePreset[]} */
  let presets = []
  /** @type {CompiledTextRule[]} */
  let compiledTextRules = []
  /** @type {CompiledJsonPathRule[]} */
  let compiledJsonPathRules = []
  // Global live edit rules flag (persisted by the caller in config.json).
  let enabled = true

  /**
   * Key: rule id, value: number of distinct log entries where the rule was
   * applied at least once within the current in-memory log window. Updated
   * incrementally (recordUsage when a rewrite is attached to a log entry,
   * releaseUsage when entries are evicted, clearUsage with the logs) so that
   * the usage report is O(1) per rule without rescanning the logs.
   *
   * @type {Map<string, number>}
   */
  const usageCounters = new Map()

  /**
   * Load edit rules from disk into memory, normalising their structure.
   *
   * This transparently converts any on-disk multi-segment representation of
   * long string fields back into single strings before normalisation, so that
   * the rest of the code always works with flat string values.
   */
  function load () {
    try {
      if (fs.existsSync(rulesFile)) {
        const data = JSON.parse(fs.readFileSync(rulesFile, 'utf8'))
        if (Array.isArray(data)) {
          rules = data
            .map(deserializeEditRuleFromDisk)
            .map(normalizeEditRule)
        }
      }
    } catch (error) {
      log.error('[proxy] Error loading edit rules:', error)
      rules = []
    }
  }

  /**
   * Persist the current in-memory edit rules to disk.
   *
   * Uses serializeEditRuleForDisk so that very long JSONPath rule values are
   * written in a multi-segment form that is easier to inspect and edit by
   * hand.
   */
  async function save () {
    try {
      const diskRules = rules.map(serializeEditRuleForDisk)
      const payload = JSON.stringify(diskRules, null, 2)
      await fsPromises.writeFile(rulesFile, payload)
    } catch (error) {
      log.error('[proxy] Error saving edit rules:', error)
    }
  }

  /** Load edit-rule presets from disk into memory. */
  function loadPresets () {
    try {
      if (fs.existsSync(presetsFile)) {
        const data = JSON.parse(fs.readFileSync(presetsFile, 'utf8'))
        if (Array.isArray(data)) {
          presets = data.map(normalizeEditRulePreset)
        }
      }
    } catch (error) {
      log.error('[proxy] Error loading edit rule presets:', error)
      presets = []
    }
  }

  /** Persist edit-rule presets to disk. */
  async function savePresets () {
    try {
      const payload = JSON.stringify(presets, null, 2)
      await fsPromises.writeFile(presetsFile, payload)
    } catch (error) {
      log.error('[proxy] Error saving edit rule presets:', error)
    }
  }

  /**
   * Rebuild the in-memory caches for edit rules (text + JSONPath).
   *
   * Behaviour:
   * - JSONPath rules are validated and parsed into segments, and only rules
   *   with a non-empty URL pattern are included.
   * - Text rules support optional OR-variants via `startVariants` and
   *   `endVariants`. All possible marker combinations are expanded into
   *   individual compiled rules which share the same logical rule id.
   *
   * This keeps the on-disk/editable representation compact while allowing the
   * runtime matcher to operate on simple start/end pairs.
   */
  function rebuildCache () {
    compiledTextRules = []
    compiledJsonPathRules = []

    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue

      if (rule.kind === 'jsonPath') {
        // Pre-parse the path into structured segments for fast traversal at runtime.
        // Le regole jsonPath richiedono anche un URL non vuoto per essere attive.
        const urlPatternRaw = safeString(rule.url)
        const urlPattern = urlPatternRaw.trim()
        if (!urlPattern) continue

        const segments = parseJsonPath(rule.path)
        if (!segments || !segments.length) continue

        /** @type {JsonPathValueType} */
        let valueType = 'string'
        if (
          rule.valueType === 'number' ||
          rule.valueType === 'boolean' ||
          rule.valueType === 'null' ||
          rule.valueType === 'json'
        ) {
          valueType = rule.valueType
        }

        /** @type {RuleTarget} */
        const normalizedTarget =
          rule.target === 'response' || rule.target === 'both'
            ? rule.target
            : 'request'

        compiledJsonPathRules.push({
          id: rule.id,
          kind: 'jsonPath',
          name: rule.name || '',
          path: rule.path,
          segments,
          value: rule.value,
          valueType,
          valueSource: rule.valueSource || null,
          url: urlPattern,
          target: normalizedTarget
        })
        continue
      }

      // Text rules: expand the OR-variant marker lists into a set of simple
      // start/end combinations. All variant combinations share the same logical
      // rule id so that logging and usage reporting remain grouped. The
      // canonical configuration surface for text rules is
      // startVariants/endVariants only.
      const variantStarts = Array.isArray(rule.startVariants)
        ? rule.startVariants.map(entry => safeString(entry)).filter(s => s.length > 0)
        : []
      const variantEnds = Array.isArray(rule.endVariants)
        ? rule.endVariants.map(entry => safeString(entry)).filter(s => s.length > 0)
        : []

      /** @type {string[]} */
      const allStarts = []
      /** @type {string[]} */
      const allEnds = []

      for (const s of variantStarts) {
        if (!allStarts.includes(s)) allStarts.push(s)
      }

      for (const e of variantEnds) {
        if (!allEnds.includes(e)) allEnds.push(e)
      }

      // If there are no usable markers at all, skip this text rule.
      if (!allStarts.length && !allEnds.length) {
        continue
      }

      /** @type {{ start: string, end: string }[]} */
      const combinations = []

      if (allStarts.length && allEnds.length) {
        // Full cartesian product of start/end markers.
        for (const start of allStarts) {
          for (const end of allEnds) {
            combinations.push({ start, end })
          }
        }
      } else if (allStarts.length) {
        // Only prefix markers: each start becomes an independent prefix rule.
        for (const start of allStarts) {
          combinations.push({ start, end: '' })
        }
      } else {
        // Only suffix markers: each end becomes an independent suffix rule.
        for (const end of allEnds) {
          combinations.push({ start: '', end })
        }
      }

      for (const combo of combinations) {
        const variantRule = {
          ...rule,
          start: combo.start,
          end: combo.end
        }
        let compiled = null
        try {
          compiled = compileEditRule(variantRule)
        } catch (error) {
          // An invalid regular expression in one rule must not take the whole
          // rule set down with it: skip that combination and keep going.
          const message = error instanceof Error ? error.message : String(error)
          log.warn('edit-rules', `Skipping rule ${rule.id || '(no id)'} "${rule.name || ''}": ${message}`)
          continue
        }
        if (compiled) {
          compiledTextRules.push(compiled)
        }
      }
    }
  }

  /** @returns {CompiledTextRule[]} */
  function getCompiledRules () {
    if (!enabled) return []
    return compiledTextRules
  }

  /** @returns {CompiledJsonPathRule[]} */
  function getCompiledJsonPathRules () {
    if (!enabled) return []
    return compiledJsonPathRules
  }

  /**
   * Return the subset of compiled edit rules that are applicable to the given
   * URL/phase context. This performs per-rule phase/URL checks once per
   * call-site so that hot paths (headers/body rewrites) can iterate a smaller
   * ruleset.
   *
   * The function is intentionally conservative: in the absence of a valid
   * context object it returns the full compiled rules array to preserve legacy
   * behaviour.
   *
   * @param {UrlMatchContext|null|undefined} context
   * @returns {CompiledTextRule[]} Filtered compiled rules.
   */
  function getCompiledRulesForContext (context) {
    const all = getCompiledRules()
    if (!all.length || !context || typeof context !== 'object') return all

    const matchContext = context.candidates ? context : buildUrlMatchContext(context)
    const phase = matchContext.phase === 'response' ? 'response' : 'request'

    return all.filter(compiled => {
      const rule = compiled && compiled.rule
      if (!rule || typeof rule !== 'object') return false

      let target = 'both'
      if (rule.target === 'request' || rule.target === 'response' || rule.target === 'both') {
        target = rule.target
      }

      if (target === 'request' && phase === 'response') return false
      if (target === 'response' && phase === 'request') return false

      return textRuleMatchesUrl(rule, matchContext)
    })
  }

  /** @returns {boolean} */
  function hasCompiledTextRules () {
    const compiled = getCompiledRules()
    return Array.isArray(compiled) && compiled.length > 0
  }

  /** @returns {boolean} */
  function hasCompiledJsonPathRules () {
    const compiled = getCompiledJsonPathRules()
    return Array.isArray(compiled) && compiled.length > 0
  }

  /**
   * Lightweight check used by hot paths to decide whether it is worth
   * invoking Connect/protobuf or HTTP body rewriting when interactive logging
   * is disabled.
   *
   * @returns {boolean}
   */
  function hasAnyEditOrJsonPathRules () {
    return hasCompiledTextRules() || hasCompiledJsonPathRules()
  }

  /** @returns {EditRule[]} */
  function getRules () {
    return rules
  }

  /**
   * @param {Record<string, any>[]} next
   * @returns {EditRule[]}
   */
  function replaceRules (next) {
    rules = (Array.isArray(next) ? next : []).map(normalizeEditRule)
    rebuildCache()
    return rules
  }

  /**
   * @param {string} id
   * @returns {EditRule | undefined}
   */
  function findRule (id) {
    return rules.find(rule => rule && rule.id === id)
  }

  /**
   * @param {Record<string, any>} raw
   * @returns {EditRule}
   */
  function addRule (raw) {
    // normalizeEditRule generates the id; a client-supplied one is ignored.
    const rule = normalizeEditRule({ ...raw, id: undefined })
    rules.push(rule)
    rebuildCache()
    return rule
  }

  /**
   * @param {string} id
   * @param {Record<string, any>} patch
   * @returns {EditRule | null}
   */
  function updateRule (id, patch) {
    const idx = rules.findIndex(rule => rule.id === id)
    if (idx === -1) return null

    const existing = rules[idx]
    const updated = normalizeEditRule({
      ...existing,
      ...patch,
      id: existing.id
    })

    rules[idx] = updated
    rebuildCache()
    return updated
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  function removeRule (id) {
    const before = rules.length
    rules = rules.filter(rule => rule.id !== id)
    if (rules.length === before) return false

    usageCounters.delete(id)
    rebuildCache()
    return true
  }

  /** @returns {EditRulePreset[]} */
  function getPresets () {
    return presets
  }

  /**
   * @param {Record<string, any>} raw
   * @returns {EditRulePreset}
   */
  function addPreset (raw) {
    const preset = normalizeEditRulePreset(raw)
    presets.push(preset)
    return preset
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  function removePreset (id) {
    const before = presets.length
    presets = presets.filter(preset => preset && preset.id !== id)
    return presets.length !== before
  }

  /** @param {string} id */
  function recordUsage (id) {
    const prev = usageCounters.get(id) || 0
    usageCounters.set(id, prev + 1)
  }

  /** @param {Iterable<unknown>} ids */
  function releaseUsage (ids) {
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue
      const current = usageCounters.get(id)
      if (typeof current === 'number' && current > 0) {
        const next = current - 1
        if (next > 0) {
          usageCounters.set(id, next)
        } else {
          usageCounters.delete(id)
        }
      }
    }
  }

  /** @returns {{ usage: Record<string, number>, totalRulesWithUsage: number }} */
  function getUsageSnapshot () {
    /** @type {Record<string, number>} */
    const usage = Object.create(null)
    for (const [id, count] of usageCounters.entries()) {
      usage[id] = count
    }
    return { usage, totalRulesWithUsage: usageCounters.size }
  }

  function clearUsage () {
    usageCounters.clear()
  }

  return {
    storageDir,
    load,
    save,
    loadPresets,
    savePresets,
    getRules,
    replaceRules,
    findRule,
    addRule,
    updateRule,
    removeRule,
    getPresets,
    addPreset,
    removePreset,
    rebuildCache,
    isEnabled: () => enabled,
    setEnabled: (value) => { enabled = value === true },
    getCompiledRules,
    getCompiledRulesForContext,
    getCompiledJsonPathRules,
    hasCompiledTextRules,
    hasCompiledJsonPathRules,
    hasAnyEditOrJsonPathRules,
    recordUsage,
    releaseUsage,
    getUsageSnapshot,
    clearUsage
  }
}

module.exports = { createRuleStore }
