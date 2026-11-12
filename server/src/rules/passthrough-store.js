'use strict'

/**
 * TLS passthrough rules (`storage/passthrough.json`): host names whose
 * CONNECT tunnels are relayed as raw bytes instead of being terminated,
 * for clients that pin their certificates. A rule matches the host itself
 * and its subdomains.
 *
 * @module rules/passthrough-store
 */

const fs = require('fs')
const { randomUUID } = require('crypto')
const { safeString, safeTrim } = require('../util/strings')
const { logError } = require('../util/logger')

const fsPromises = fs.promises

/**
 * @typedef {object} PassthroughRule
 * @property {string} id
 * @property {boolean} enabled
 * @property {string} name
 * @property {string} host Lower-case host name (or IP) without port; subdomains match too.
 */

/**
 * @typedef {object} PassthroughStore
 * @property {() => void} load
 * @property {() => Promise<void>} save Notify the listeners and write the rules.
 * @property {() => PassthroughRule[]} getRules The live array.
 * @property {(rules: PassthroughRule[]) => void} setRules
 * @property {(hostname: string) => PassthroughRule | null} match The first enabled rule covering the host.
 * @property {(listener: () => void) => () => void} onChange
 */

/**
 * The host of a rule as stored: lower case, without a leading `*.` or `.`,
 * a scheme, a path or a port.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHost(value) {
  let host = safeTrim(value).toLowerCase()
  host = host.replace(/^[a-z]+:\/\//, '')
  host = host.split('/')[0]
  host = host.replace(/^\*\./, '').replace(/^\./, '')
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    return close === -1 ? host : host.slice(0, close + 1)
  }
  return host.split(':')[0]
}

/**
 * @param {Partial<PassthroughRule> & { host?: unknown }} rule
 * @returns {PassthroughRule}
 */
function normalizePassthroughRule(rule = {}) {
  const host = normalizeHost(rule.host)
  const name = safeTrim(rule.name)
  return {
    id: typeof rule.id === 'string' && rule.id ? rule.id : `pt-${randomUUID()}`,
    enabled: rule.enabled !== false,
    name: name || host,
    host
  }
}

/**
 * @param {{ file: string }} options
 * @returns {PassthroughStore}
 */
function createPassthroughStore({ file }) {
  /** @type {PassthroughRule[]} */
  let rules = []
  /** @type {Set<() => void>} */
  const listeners = new Set()

  function load() {
    try {
      if (!fs.existsSync(file)) return
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      rules = Array.isArray(parsed)
        ? parsed.map(normalizePassthroughRule).filter(rule => rule.host)
        : []
    } catch (error) {
      logError('passthrough', 'Error loading the passthrough rules', error)
    }
  }

  async function save() {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        logError('passthrough', 'Passthrough change listener failed', error)
      }
    }
    try {
      await fsPromises.writeFile(file, JSON.stringify(rules, null, 2))
    } catch (error) {
      logError('passthrough', 'Error saving the passthrough rules', error)
    }
  }

  /**
   * @param {string} hostname
   * @returns {PassthroughRule | null}
   */
  function match(hostname) {
    const host = safeString(hostname).toLowerCase()
    if (!host) return null
    for (const rule of rules) {
      if (!rule.enabled || !rule.host) continue
      if (host === rule.host || host.endsWith(`.${rule.host}`)) return rule
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

module.exports = { normalizeHost, normalizePassthroughRule, createPassthroughStore }
