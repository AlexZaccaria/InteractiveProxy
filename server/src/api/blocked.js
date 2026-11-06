'use strict'

/**
 * Management API: blocked URL rules (`/api/blocked`).
 *
 * @module api/blocked
 */

const express = require('express')
const { safeTrim, isValidId } = require('../util/strings')
const { normalizeBlockedRule } = require('../proxy/router')

/**
 * @typedef {object} BlockedRoutesDeps
 * @property {import('../proxy/router').Router} router
 */

/**
 * @param {BlockedRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createBlockedRoutes ({ router: proxyRouter }) {
  const router = express.Router()

  // Get all blocked rules
  router.get('/blocked', (req, res) => {
    res.json(proxyRouter.getBlockedRules())
  })

  // Add/update/remove blocked URL
  router.post('/blocked', async (req, res) => {
    const { id, url, action, enabled, name } = req.body || {}
    const blockedRules = proxyRouter.getBlockedRules()

    if (typeof action !== 'string') {
      return res.status(400).json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
    }

    if (action === 'add') {
      const normalizedUrl = safeTrim(url)
      if (!normalizedUrl) {
        return res.status(400).json({ error: 'URL is required' })
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
      }

      const newRule = normalizeBlockedRule({ id, enabled, name, url: normalizedUrl })
      blockedRules.push(newRule)
      await proxyRouter.saveBlockedUrls()
    } else if (action === 'update') {
      if (!isValidId(id)) {
        return res.status(400).json({ error: 'ID is required for update' })
      }
      const idx = blockedRules.findIndex(r => r.id === id)
      if (idx !== -1) {
        const existing = blockedRules[idx]
        const next = { ...existing }

        if (url !== undefined) {
          const normalizedUrl = safeTrim(url)
          if (!normalizedUrl) {
            return res.status(400).json({ error: 'URL is required' })
          }
          next.url = normalizedUrl
        }

        if (enabled !== undefined) {
          if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
          }
          next.enabled = enabled
        }

        if (name !== undefined) {
          if (typeof name !== 'string') {
            return res.status(400).json({ error: 'Invalid "name" field: expected a string.' })
          }
          next.name = name
        }

        blockedRules[idx] = normalizeBlockedRule(next)
        await proxyRouter.saveBlockedUrls()
      } else {
        return res.status(404).json({ error: 'Rule not found' })
      }
    } else if (action === 'remove') {
      if (!isValidId(id)) {
        return res.status(400).json({ error: 'ID is required for remove' })
      }
      proxyRouter.setBlockedRules(blockedRules.filter(r => r.id !== id))
      await proxyRouter.saveBlockedUrls()
    } else {
      return res.status(400).json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
    }

    res.json({ success: true, blockedRules: proxyRouter.getBlockedRules() })
  })

  return router
}

module.exports = { createBlockedRoutes }
