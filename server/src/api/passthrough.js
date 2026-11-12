'use strict'

/**
 * Management API: TLS passthrough rules (`/api/passthrough`): hosts whose
 * CONNECT tunnels are relayed without TLS termination.
 *
 * @module api/passthrough
 */

const express = require('express')
const { isValidId } = require('../util/strings')
const { normalizeHost, normalizePassthroughRule } = require('../rules/passthrough-store')

const HOST_PATTERN =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i

/**
 * @typedef {object} PassthroughRoutesDeps
 * @property {import('../rules/passthrough-store').PassthroughStore} passthroughStore
 */

/**
 * @param {PassthroughRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createPassthroughRoutes({ passthroughStore }) {
  const router = express.Router()

  router.get('/passthrough', (req, res) => {
    res.json(passthroughStore.getRules())
  })

  router.post('/passthrough', async (req, res) => {
    const { id, host, action, enabled, name } = req.body || {}
    const rules = passthroughStore.getRules()

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
    const normalizedHost = host === undefined ? undefined : normalizeHost(host)
    if (normalizedHost !== undefined && !HOST_PATTERN.test(normalizedHost)) {
      return res.status(400).json({ error: 'Invalid "host": expected a host name or an IP.' })
    }

    if (action === 'add') {
      if (!normalizedHost) {
        return res.status(400).json({ error: 'Host is required' })
      }
      rules.push(normalizePassthroughRule({ id, enabled, name, host: normalizedHost }))
    } else if (action === 'update') {
      if (!isValidId(id)) {
        return res.status(400).json({ error: 'ID is required for update' })
      }
      const index = rules.findIndex(rule => rule.id === id)
      if (index === -1) {
        return res.status(404).json({ error: 'Rule not found' })
      }
      const next = { ...rules[index] }
      if (normalizedHost !== undefined) {
        if (!normalizedHost) {
          return res.status(400).json({ error: 'Host is required' })
        }
        next.host = normalizedHost
      }
      if (enabled !== undefined) next.enabled = enabled
      if (name !== undefined) next.name = name
      rules[index] = normalizePassthroughRule(next)
    } else {
      if (!isValidId(id)) {
        return res.status(400).json({ error: 'ID is required for remove' })
      }
      passthroughStore.setRules(rules.filter(rule => rule.id !== id))
    }

    await passthroughStore.save()
    res.json({ success: true, passthroughRules: passthroughStore.getRules() })
  })

  return router
}

module.exports = { createPassthroughRoutes }
