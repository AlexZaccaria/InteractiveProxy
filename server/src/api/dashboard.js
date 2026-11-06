'use strict'

/**
 * Management API: dashboard counters and the audit snapshot
 * (`/api/dashboard`, `/api/audit`).
 *
 * @module api/dashboard
 */

const express = require('express')

/**
 * @typedef {object} DashboardRoutesDeps
 * @property {import('../logs/store').LogStore} logStore
 * @property {import('../logs/stats').Stats} stats
 * @property {import('../proxy/router').Router} router
 * @property {import('../resources/store').ResourceStore} resourceStore
 * @property {import('./index').BypassCounter} bypassCounter
 */

/**
 * @param {DashboardRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createDashboardRoutes ({ logStore, stats, router: proxyRouter, resourceStore, bypassCounter }) {
  const router = express.Router()

  router.get('/dashboard', (req, res) => {
    const { stats: dashboard, editedRequests, performance, payloads, routes } = stats.getDashboardSnapshot()

    res.json({
      stats: dashboard,
      performance,
      payloads,
      routes,
      resources: resourceStore.list(),
      blocked: proxyRouter.getBlockedUrls(),
      filterMetrics: {
        totalFiltered: bypassCounter.get(),
        activeRules: proxyRouter.getBypassUrls().length
      },
      editedRequests
    })
  })

  // Lightweight audit snapshot of the current in-memory log window (upstream
  // error distribution and per-host latency) for the secret Proxy Audit Panel.
  router.get('/audit', (req, res) => {
    try {
      res.json(stats.buildAuditSnapshot(logStore))
    } catch (error) {
      console.error('[proxy] Error building audit snapshot:', error)
      res.status(500).json({ error: 'Failed to build audit snapshot' })
    }
  })

  return router
}

module.exports = { createDashboardRoutes }
