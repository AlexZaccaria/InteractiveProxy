'use strict'

/**
 * Breakpoint rules (`storage/breakpoints.json`): a URL substring, the phase
 * the rule pauses (`request`, `response` or `both`), a name and an enabled
 * flag. The store owns the list, its persistence and the match used by the
 * proxy flows.
 *
 * @module rules/breakpoint-store
 */

const fs = require('fs')
const { randomUUID } = require('crypto')
const { safeString, safeTrim } = require('../util/strings')
const { logError } = require('../util/logger')

const fsPromises = fs.promises

/** @typedef {'request' | 'response' | 'both'} BreakpointPhase */

/**
 * @typedef {object} BreakpointRule
 * @property {string} id
 * @property {boolean} enabled
 * @property {string} name
 * @property {string} url Substring of the request URL.
 * @property {BreakpointPhase} phase
 */

/**
 * @typedef {object} BreakpointStore
 * @property {() => void} load Read the rules synchronously (a missing or invalid file leaves the list empty).
 * @property {() => Promise<void>} save Notify the listeners and write the rules.
 * @property {() => BreakpointRule[]} getRules The live array.
 * @property {(rules: BreakpointRule[]) => void} setRules
 * @property {(requestUrl: string, fullUrl: string, phase: 'request' | 'response') => BreakpointRule | null} match
 *   The first enabled rule whose URL substring is in the request URL and whose phase covers `phase`.
 * @property {(listener: () => void) => () => void} onChange Subscribe to saves; returns the unsubscribe function.
 */

/**
 * @param {unknown} value
 * @returns {BreakpointPhase}
 */
function normalizePhase(value) {
  const phase = safeString(value).toLowerCase()
  return phase === 'request' || phase === 'response' ? phase : 'both'
}

/**
 * @param {Partial<BreakpointRule> & { url?: unknown, phase?: unknown }} rule
 * @returns {BreakpointRule}
 */
function normalizeBreakpointRule(rule = {}) {
  const url = safeTrim(rule.url)
  const name = safeTrim(rule.name)
  return {
    id: typeof rule.id === 'string' && rule.id ? rule.id : `bp-${randomUUID()}`,
    enabled: rule.enabled !== false,
    name: name || url,
    url,
    phase: normalizePhase(rule.phase)
  }
}

/**
 * @param {{ file: string }} options
 * @returns {BreakpointStore}
 */
function createBreakpointStore({ file }) {
  /** @type {BreakpointRule[]} */
  let rules = []
  /** @type {Set<() => void>} */
  const listeners = new Set()

  function load() {
    try {
      if (!fs.existsSync(file)) return
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      rules = Array.isArray(parsed)
        ? parsed.map(normalizeBreakpointRule).filter(rule => rule.url)
        : []
    } catch (error) {
      logError('breakpoints', 'Error loading the breakpoint rules', error)
    }
  }

  async function save() {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        logError('breakpoints', 'Breakpoint change listener failed', error)
      }
    }
    try {
      await fsPromises.writeFile(file, JSON.stringify(rules, null, 2))
    } catch (error) {
      logError('breakpoints', 'Error saving the breakpoint rules', error)
    }
  }

  /**
   * @param {string} requestUrl
   * @param {string} fullUrl
   * @param {'request' | 'response'} phase
   * @returns {BreakpointRule | null}
   */
  function match(requestUrl, fullUrl, phase) {
    const request = safeString(requestUrl)
    const full = safeString(fullUrl)
    for (const rule of rules) {
      if (!rule.enabled || !rule.url) continue
      if (rule.phase !== 'both' && rule.phase !== phase) continue
      if ((request && request.includes(rule.url)) || (full && full.includes(rule.url))) {
        return rule
      }
    }
    return null
  }

  return {
    load,
    save,
    getRules: () => rules,
    setRules: next => {
      rules = Array.isArray(next) ? next : []
    },
    match,
    onChange: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

module.exports = { normalizePhase, normalizeBreakpointRule, createBreakpointStore }
