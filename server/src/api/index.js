'use strict'

/**
 * Management API router: the cross-site guard followed by every `/api/*`
 * route group. Mounted by `app.js` under `/api`.
 *
 * @module api
 */

const express = require('express')
const { safeString } = require('../util/strings')
const { createUpload } = require('./upload')
const { createLogsRoutes } = require('./logs')
const { createConfigRoutes } = require('./config')
const { createSystemRoutes } = require('./system')
const { createResourcesRoutes } = require('./resources')
const { createEditRulesRoutes } = require('./edit-rules')
const { createBlockedRoutes } = require('./blocked')
const { createFiltersRoutes } = require('./filters')
const { createDashboardRoutes } = require('./dashboard')
const { createEventsRoutes } = require('./events')

/**
 * Counter of the requests bypassed (redirected) by the filter rules. Owned by
 * the proxy flows, read and reset by the API.
 *
 * @typedef {object} BypassCounter
 * @property {() => number} get
 * @property {(increment?: number) => void} increment
 * @property {() => void} reset
 */

/**
 * @typedef {object} ApiDeps
 * @property {import('../logs/store').LogStore} logStore
 * @property {import('../logs/stats').Stats} stats
 * @property {import('../logs/suggestions').SuggestionTracker} suggestions
 * @property {import('../rules/store').RuleStore} ruleStore
 * @property {import('../state/config-store').ConfigStore} configStore
 * @property {import('../proxy/router').Router} router
 * @property {import('../resources/store').ResourceStore} resourceStore
 * @property {string} storageDir
 * @property {string[]} uiOrigins Browser origins allowed to mutate through the API.
 * @property {BypassCounter} bypassCounter
 * @property {import('../logs/replay').ReplayRunner} replay Sends replays through the proxy.
 * @property {number} [eventsKeepAliveMs] Keep-alive interval of the `/api/events` stream.
 */

/**
 * Reject mutations that a browser marks as coming from another site.
 *
 * CORS alone does not stop "simple" cross-site POSTs from reaching the
 * handlers, so mutations on the management API additionally reject requests
 * whose `Origin` is not one of the UI origins or whose `Sec-Fetch-Site` is
 * `cross-site`. Non-browser clients send neither header and keep working.
 *
 * @param {string[]} uiOrigins
 * @returns {import('express').RequestHandler}
 */
function createCrossSiteGuard(uiOrigins) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next()
    }

    const origin = safeString(req.headers.origin)
    const fetchSite = safeString(req.headers['sec-fetch-site']).toLowerCase()

    if ((origin && !uiOrigins.includes(origin)) || fetchSite === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site requests to the proxy API are not allowed' })
    }

    next()
  }
}

/**
 * @param {ApiDeps} deps
 * @returns {import('express').Router}
 */
function createApiRouter(deps) {
  const {
    logStore,
    stats,
    suggestions,
    ruleStore,
    configStore,
    router: proxyRouter,
    resourceStore,
    storageDir,
    uiOrigins,
    bypassCounter,
    replay,
    eventsKeepAliveMs
  } = deps

  const upload = createUpload(storageDir)
  const router = express.Router()

  router.use(createCrossSiteGuard(uiOrigins))

  router.use(createLogsRoutes({ logStore, stats, suggestions, ruleStore, bypassCounter, replay }))
  router.use(createConfigRoutes({ configStore, ruleStore, router: proxyRouter, bypassCounter }))
  router.use(createSystemRoutes())
  router.use(createResourcesRoutes({ resourceStore, storageDir, upload }))
  router.use(createEditRulesRoutes({ ruleStore, storageDir, upload }))
  router.use(createBlockedRoutes({ router: proxyRouter }))
  router.use(createFiltersRoutes({ router: proxyRouter, suggestions, bypassCounter }))
  router.use(
    createDashboardRoutes({ logStore, stats, router: proxyRouter, resourceStore, bypassCounter })
  )
  router.use(
    createEventsRoutes({
      logStore,
      stats,
      configStore,
      ruleStore,
      router: proxyRouter,
      resourceStore,
      bypassCounter,
      keepAliveMs: eventsKeepAliveMs
    })
  )

  return router
}

module.exports = { createApiRouter, createCrossSiteGuard }
