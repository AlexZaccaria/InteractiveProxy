'use strict'

/**
 * Management API: filter (bypass) rules, suggestions and metrics
 * (`/api/filters*`).
 *
 * @module api/filters
 */

const express = require('express')
const { safeTrim, isValidId } = require('../util/strings')
const { normalizeBypassRule } = require('../proxy/router')

/**
 * @typedef {object} FiltersRoutesDeps
 * @property {import('../proxy/router').Router} router
 * @property {import('../logs/suggestions').SuggestionTracker} suggestions
 * @property {import('./index').BypassCounter} bypassCounter
 */

/**
 * @param {FiltersRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createFiltersRoutes({ router: proxyRouter, suggestions, bypassCounter }) {
  const router = express.Router()

  // Get all filter rules
  router.get('/filters', (req, res) => {
    try {
      const queryModeRaw = typeof req.query.mode === 'string' ? req.query.mode.toLowerCase() : null
      const effectiveMode =
        queryModeRaw === 'focus' || queryModeRaw === 'ignore'
          ? queryModeRaw
          : proxyRouter.getBypassMode()

      const rulesForMode = proxyRouter
        .getBypassRules()
        .filter(rule => rule && rule.mode === effectiveMode)

      res.json(rulesForMode)
    } catch (error) {
      res.status(500).json({ error: 'Failed to load filter rules' })
    }
  })

  // Add/update/remove filter URL
  router.post('/filters', (req, res) => {
    const { id, url, action, enabled, name, mode } = req.body || {}
    const bypassRules = proxyRouter.getBypassRules()

    if (typeof action !== 'string') {
      return res
        .status(400)
        .json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
    }

    if (action === 'add') {
      const normalizedUrl = safeTrim(url)
      if (!normalizedUrl) {
        return res.status(400).json({ error: 'URL is required' })
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
      }

      const baseRule = {
        id,
        enabled,
        name,
        url: normalizedUrl,
        mode: typeof mode === 'string' ? mode : proxyRouter.getBypassMode()
      }
      const newRule = normalizeBypassRule(baseRule)
      bypassRules.push(newRule)
      proxyRouter.saveBypassUrls()
    } else if (action === 'update') {
      if (!isValidId(id)) {
        return res.status(400).json({ error: 'ID is required for update' })
      }
      const ruleIndex = bypassRules.findIndex(r => r.id === id)
      if (ruleIndex !== -1) {
        const existing = normalizeBypassRule(bypassRules[ruleIndex])
        const nextModeRaw = typeof mode === 'string' ? mode.toLowerCase() : existing.mode
        const nextMode =
          nextModeRaw === 'focus' || nextModeRaw === 'ignore' ? nextModeRaw : existing.mode

        let nextUrl = existing.url
        if (url !== undefined) {
          const normalizedUrl = safeTrim(url)
          if (!normalizedUrl) {
            return res.status(400).json({ error: 'URL is required' })
          }
          nextUrl = normalizedUrl
        }

        if (enabled !== undefined && typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
        }

        if (name !== undefined && typeof name !== 'string') {
          return res.status(400).json({ error: 'Invalid "name" field: expected a string.' })
        }

        const updated = normalizeBypassRule({
          ...existing,
          url: nextUrl,
          enabled: enabled !== undefined ? enabled : existing.enabled,
          name: name !== undefined ? name : existing.name,
          mode: nextMode
        })

        bypassRules[ruleIndex] = updated
        proxyRouter.saveBypassUrls()
      } else {
        return res.status(404).json({ error: 'Rule not found' })
      }
    } else if (action === 'remove') {
      if (!isValidId(id)) {
        return res.status(400).json({ error: 'ID is required for remove' })
      }
      proxyRouter.setBypassRules(bypassRules.filter(r => r.id !== id))
      proxyRouter.saveBypassUrls()
    } else {
      return res
        .status(400)
        .json({ error: 'Invalid action. Expected "add", "update" or "remove".' })
    }

    res.json({ success: true, bypassRules: proxyRouter.getBypassRules() })
  })

  router.get('/filters/suggestions', (req, res) => {
    try {
      const limit = Number.parseInt(String(req.query.limit), 10)

      // `windowSize` is accepted on the wire for backwards compatibility but
      // the tracker never used it (it was an ignored `_windowSize` parameter).
      const computed = suggestions.compute({
        limit: Number.isNaN(limit) ? undefined : limit
      })

      res.json({ suggestions: computed })
    } catch (error) {
      res.status(500).json({ error: 'Failed to compute filter suggestions' })
    }
  })

  router.get('/filters/metrics', (req, res) => {
    res.json({
      totalFiltered: bypassCounter.get(),
      activeRules: proxyRouter.getBypassUrls().length
    })
  })

  return router
}

module.exports = { createFiltersRoutes }
