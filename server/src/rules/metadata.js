'use strict'

/**
 * Rewrite metadata attached to log entries: which rules applied, in which
 * phase, plus the rule's name/kind/url/target for display. Attaching an entry
 * for a rule the first time also records one usage in the rule store.
 */

const { safeTrim } = require('../util/strings')

/** @typedef {import('./store').RuleStore} RuleStore */

/**
 * One rewrite record on a log entry.
 *
 * @typedef {object} RewriteMetadata
 * @property {string} id
 * @property {string} [name]
 * @property {string} [kind]
 * @property {string} [url]
 * @property {string} [target]
 * @property {string[]} [appliedPhases]
 * @property {string} [appliedScope]
 */

/**
 * True when a rewrite produced at least one applied rule id.
 *
 * @param {unknown} appliedRuleIds
 * @returns {boolean}
 */
function hasAppliedRules (appliedRuleIds) {
  return Array.isArray(appliedRuleIds) && appliedRuleIds.length > 0
}

/**
 * Attach per-rule rewrite metadata to a log entry and update the store's
 * edit-rule usage counters.
 *
 * For each rule id in appliedRuleIds this function ensures that at most
 * one metadata entry is stored on the log entry, and increments the
 * in-memory usage counter the first time the rule is seen for that log
 * entry. This keeps aggregation O(1) per rule id without rescanning
 * the logs when building reports.
 *
 * @param {{ rewrites?: RewriteMetadata[] } & Record<string, any> | null | undefined} logEntry - Mutable log entry to enrich.
 * @param {string[]} appliedRuleIds - Rule identifiers that matched for this operation.
 * @param {string|undefined} phase - Phase hint ('request' | 'response' | 'both').
 * @param {RuleStore} store
 * @returns {void}
 */
function attachRewriteMetadata (logEntry, appliedRuleIds, phase, store) {
  if (!logEntry || !Array.isArray(appliedRuleIds) || appliedRuleIds.length === 0) return
  if (!logEntry.rewrites) {
    logEntry.rewrites = []
  }
  const rewrites = logEntry.rewrites

  // Normalise the phase hint to one of 'request' | 'response' | 'both' | null.
  const normalizedPhase =
    phase === 'request' || phase === 'response'
      ? phase
      : phase === 'both'
        ? 'both'
        : null

  for (const id of appliedRuleIds) {
    if (!id) continue

    // Reuse or create a single metadata entry per rule id, and accumulate
    // the phases in which it actually applied for this log entry.
    let entry = rewrites.find(e => e && e.id === id)

    const isNewEntry = !entry
    if (!entry) {
      entry = { id }

      const rule = store.findRule(id)

      if (rule) {
        if (typeof rule.name === 'string' && rule.name.trim()) {
          entry.name = rule.name.trim()
        }

        if (typeof rule.kind === 'string' && rule.kind.trim()) {
          entry.kind = rule.kind.trim()
        }

        if (typeof rule.url === 'string' && rule.url.trim()) {
          entry.url = rule.url.trim()
        }

        // Normalise configured target so the frontend can still surface how
        // the rule is *defined* in the UI when no applied phase metadata is
        // available.
        const rawTarget = safeTrim(rule.target)
        if (rawTarget === 'request' || rawTarget === 'response' || rawTarget === 'both') {
          entry.target = rawTarget
        } else if (rule.kind === 'text') {
          // Text rules historically applied to both phases when target was omitted.
          entry.target = 'both'
        } else if (rule.kind === 'jsonPath') {
          // JSONPath rules default to request when not explicitly set.
          entry.target = 'request'
        }
      } else {
        // Rule has been deleted or is otherwise missing; keep a minimal stub
        // so the UI can still surface that a rewrite occurred.
        entry.kind = 'unknown'
      }
    }

    if (isNewEntry) {
      store.recordUsage(id)
    }

    // Track where the rule actually applied for this specific log entry.
    if (normalizedPhase) {
      if (normalizedPhase === 'both') {
        entry.appliedPhases = ['request', 'response']
        entry.appliedScope = 'both'
      } else {
        const phases = Array.isArray(entry.appliedPhases) ? entry.appliedPhases.slice() : []
        if (!phases.includes(normalizedPhase)) {
          phases.push(normalizedPhase)
        }
        entry.appliedPhases = phases

        if (phases.length === 2) {
          entry.appliedScope = 'both'
        } else if (phases.length === 1) {
          entry.appliedScope = phases[0]
        }
      }
    }

    if (isNewEntry) {
      rewrites.push(entry)
    }
  }
}

module.exports = { attachRewriteMetadata, hasAppliedRules }
