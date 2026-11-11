'use strict'

/**
 * Management API: global configuration (`/api/config`, the boolean toggles
 * and the filter mode).
 *
 * @module api/config
 */

const express = require('express')
const { safeString } = require('../util/strings')
const { handleBooleanToggleEndpoint } = require('./toggles')

/**
 * @typedef {object} ConfigRoutesDeps
 * @property {import('../state/config-store').ConfigStore} configStore
 * @property {import('../rules/store').RuleStore} ruleStore
 * @property {import('../proxy/router').Router} router
 * @property {import('./index').BypassCounter} bypassCounter
 */

/**
 * @param {ConfigRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createConfigRoutes({ configStore, ruleStore, router: proxyRouter, bypassCounter }) {
  const router = express.Router()

  // Get config
  router.get('/config', (req, res) => {
    res.json({
      ...configStore.snapshot(),
      filteredRequestCount: bypassCounter.get()
    })
  })

  // Toggle endpoints for boolean config flags
  /** @type {Array<{ path: string, field: string, set: (value: boolean) => void }>} */
  const toggles = [
    {
      path: '/interactive-mode',
      field: 'interactiveModeEnabled',
      set: v => {
        configStore.interactiveModeEnabled = v
      }
    },
    {
      path: '/edit-rules-mode',
      field: 'editRulesEnabled',
      set: v => {
        ruleStore.setEnabled(v)
      }
    },
    {
      path: '/local-resources-mode',
      field: 'localResourcesEnabled',
      set: v => {
        configStore.localResourcesEnabled = v
      }
    },
    {
      path: '/filter-rules-mode',
      field: 'filterRulesEnabled',
      set: v => {
        configStore.filterRulesEnabled = v
      }
    },
    {
      path: '/blocked-rules-mode',
      field: 'blockedRulesEnabled',
      set: v => {
        configStore.blockedRulesEnabled = v
      }
    },
    {
      path: '/breakpoints-mode',
      field: 'breakpointsEnabled',
      set: v => {
        configStore.breakpointsEnabled = v
      }
    },
    {
      path: '/throttling-mode',
      field: 'throttlingEnabled',
      set: v => {
        configStore.throttlingEnabled = v
      }
    }
  ]
  toggles.forEach(({ path, field, set }) => {
    router.post(path, (req, res) =>
      handleBooleanToggleEndpoint({
        req,
        res,
        assignValue: set,
        responseFieldName: field,
        defaultEnabled: true,
        persist: () => configStore.persist()
      })
    )
  })

  // Get filter mode
  router.get('/filter-mode', (req, res) => {
    res.json({ filterMode: proxyRouter.getBypassMode() })
  })

  // Set filter mode ("ignore" or "focus")
  router.post('/filter-mode', (req, res) => {
    const { mode } = req.body || {}
    const normalized = safeString(mode).toLowerCase()

    if (normalized !== 'ignore' && normalized !== 'focus') {
      return res.status(400).json({ error: 'Invalid filter mode. Expected "ignore" or "focus".' })
    }

    configStore.filterMode = normalized
    configStore.persist()
    proxyRouter.rebuildBypassUrlsForCurrentMode()

    res.json({ success: true, filterMode: proxyRouter.getBypassMode() })
  })

  return router
}

module.exports = { createConfigRoutes }
