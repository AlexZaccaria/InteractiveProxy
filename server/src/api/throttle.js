'use strict'

/**
 * Management API: network-condition rules (`/api/throttle`): latency and
 * bandwidth cap per URL pattern.
 *
 * @module api/throttle
 */

const express = require('express')
const { safeTrim, isValidId } = require('../util/strings')
const { MAX_DELAY_MS, normalizeThrottleRule } = require('../rules/throttle-store')

/**
 * @typedef {object} ThrottleRoutesDeps
 * @property {import('../rules/throttle-store').ThrottleStore} throttleStore
 */

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @returns {string | null} The error, if any.
 */
function checkNumber(value, field, max) {
  if (value === undefined) return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > max) {
    return `Invalid "${field}": expected a number between 0 and ${max}.`
  }
  return null
}

/**
 * @param {ThrottleRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createThrottleRoutes({ throttleStore }) {
  const router = express.Router()

  router.get('/throttle', (req, res) => {
    res.json(throttleStore.getRules())
  })

  router.post('/throttle', async (req, res) => {
    const { id, url, action, enabled, name, delayMs, throttleKbps } = req.body || {}
    const rules = throttleStore.getRules()

    if (action !== 'add' && action !== 'update' && action !== 'remove') {
      return res
        .status(400)
        .json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
    }
    if (name !== undefined && typeof name !== 'string') {
      return res.status(400).json({ error: 'Invalid "name" field: expected a string.' })
    }
    const numberError =
      checkNumber(delayMs, 'delayMs', MAX_DELAY_MS) ||
      checkNumber(throttleKbps, 'throttleKbps', Number.MAX_SAFE_INTEGER)
    if (numberError) {
      return res.status(400).json({ error: numberError })
    }

    if (action === 'add') {
      const normalizedUrl = safeTrim(url)
      if (!normalizedUrl) {
        return res.status(400).json({ error: 'URL is required' })
      }
      const rule = normalizeThrottleRule({
        id,
        enabled,
        name,
        url: normalizedUrl,
        delayMs,
        throttleKbps
      })
      if (rule.delayMs <= 0 && rule.throttleKbps <= 0) {
        return res.status(400).json({ error: 'A latency or a bandwidth cap is required' })
      }
      rules.push(rule)
    } else if (action === 'update') {
      if (!isValidId(id)) {
        return res.status(400).json({ error: 'ID is required for update' })
      }
      const index = rules.findIndex(rule => rule.id === id)
      if (index === -1) {
        return res.status(404).json({ error: 'Rule not found' })
      }
      const next = { ...rules[index] }
      if (url !== undefined) {
        const normalizedUrl = safeTrim(url)
        if (!normalizedUrl) {
          return res.status(400).json({ error: 'URL is required' })
        }
        next.url = normalizedUrl
      }
      if (enabled !== undefined) next.enabled = enabled
      if (name !== undefined) next.name = name
      if (delayMs !== undefined) next.delayMs = Number(delayMs)
      if (throttleKbps !== undefined) next.throttleKbps = Number(throttleKbps)
      const rule = normalizeThrottleRule(next)
      if (rule.delayMs <= 0 && rule.throttleKbps <= 0) {
        return res.status(400).json({ error: 'A latency or a bandwidth cap is required' })
      }
      rules[index] = rule
    } else {
      if (!isValidId(id)) {
        return res.status(400).json({ error: 'ID is required for remove' })
      }
      throttleStore.setRules(rules.filter(rule => rule.id !== id))
    }

    await throttleStore.save()
    res.json({ success: true, throttleRules: throttleStore.getRules() })
  })

  return router
}

module.exports = { createThrottleRoutes }
