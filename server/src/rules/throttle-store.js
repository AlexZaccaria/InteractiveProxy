'use strict'

/**
 * Network-condition rules (`storage/throttle-rules.json`): a URL substring,
 * a latency added before the request is forwarded and a bandwidth cap on the
 * response, with a name and an enabled flag. The store owns the list, its
 * persistence and the match used by the proxy flows.
 *
 * @module rules/throttle-store
 */

const fs = require('fs')
const { randomUUID } = require('crypto')
const { safeString, safeTrim } = require('../util/strings')
const { logError } = require('../util/logger')

const fsPromises = fs.promises

/** Longest latency a rule can add, in milliseconds (ten minutes). */
const MAX_DELAY_MS = 600_000

/**
 * @typedef {object} ThrottleRule
 * @property {string} id
 * @property {boolean} enabled
 * @property {string} name
 * @property {string} url Substring of the request URL.
 * @property {number} delayMs Latency added before the request is forwarded; 0 for none.
 * @property {number} throttleKbps Bandwidth cap on the response, in kilobits per second; 0 for none.
 */

/**
 * @typedef {object} ThrottleStore
 * @property {() => void} load
 * @property {() => Promise<void>} save Notify the listeners and write the rules.
 * @property {() => ThrottleRule[]} getRules The live array.
 * @property {(rules: ThrottleRule[]) => void} setRules
 * @property {(requestUrl: string, fullUrl: string) => ThrottleRule | null} match
 *   The first enabled rule whose URL substring is in the request URL.
 * @property {(listener: () => void) => () => void} onChange
 */

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {number}
 */
function nonNegative(value, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.min(max, Math.round(number))
}

/**
 * @param {Partial<ThrottleRule> & { url?: unknown, delayMs?: unknown, throttleKbps?: unknown }} rule
 * @returns {ThrottleRule}
 */
function normalizeThrottleRule(rule = {}) {
  const url = safeTrim(rule.url)
  const name = safeTrim(rule.name)
  return {
    id: typeof rule.id === 'string' && rule.id ? rule.id : `net-${randomUUID()}`,
    enabled: rule.enabled !== false,
    name: name || url,
    url,
    delayMs: nonNegative(rule.delayMs, MAX_DELAY_MS),
    throttleKbps: nonNegative(rule.throttleKbps, Number.MAX_SAFE_INTEGER)
  }
}

/**
 * @param {{ file: string }} options
 * @returns {ThrottleStore}
 */
function createThrottleStore({ file }) {
  /** @type {ThrottleRule[]} */
  let rules = []
  /** @type {Set<() => void>} */
  const listeners = new Set()

  function load() {
    try {
      if (!fs.existsSync(file)) return
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      rules = Array.isArray(parsed)
        ? parsed.map(normalizeThrottleRule).filter(rule => rule.url)
        : []
    } catch (error) {
      logError('throttle', 'Error loading the network-condition rules', error)
    }
  }

  async function save() {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        logError('throttle', 'Network-condition change listener failed', error)
      }
    }
    try {
      await fsPromises.writeFile(file, JSON.stringify(rules, null, 2))
    } catch (error) {
      logError('throttle', 'Error saving the network-condition rules', error)
    }
  }

  /**
   * @param {string} requestUrl
   * @param {string} fullUrl
   * @returns {ThrottleRule | null}
   */
  function match(requestUrl, fullUrl) {
    const request = safeString(requestUrl)
    const full = safeString(fullUrl)
    for (const rule of rules) {
      if (!rule.enabled || !rule.url) continue
      if (rule.delayMs <= 0 && rule.throttleKbps <= 0) continue
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

module.exports = { MAX_DELAY_MS, normalizeThrottleRule, createThrottleStore }
