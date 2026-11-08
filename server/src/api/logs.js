'use strict'

/**
 * Management API: request logs (`/api/logs*`).
 *
 * @module api/logs
 */

const express = require('express')
const { safeString } = require('../util/strings')
const { filterLogsCore, getFileTypeFromLogEntry } = require('../logs/search')
const { buildClientLogView, filterLogsForApiRequest } = require('../logs/views')

/**
 * @typedef {object} LogsRoutesDeps
 * @property {import('../logs/store').LogStore} logStore
 * @property {import('../logs/stats').Stats} stats
 * @property {import('../logs/suggestions').SuggestionTracker} suggestions
 * @property {import('../rules/store').RuleStore} ruleStore
 * @property {import('./index').BypassCounter} bypassCounter
 */

/**
 * @param {LogsRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createLogsRoutes({ logStore, stats, suggestions, ruleStore, bypassCounter }) {
  const router = express.Router()

  router.get('/logs', (req, res) => {
    try {
      const { items, total, hasMore, offset, limit } = filterLogsForApiRequest(req, logStore)

      res.json({
        items,
        total,
        hasMore,
        offset,
        limit
      })
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch logs' })
    }
  })

  router.get('/logs/export', (req, res) => {
    try {
      const query = req.query || {}
      const { ordered } = filterLogsCore(query, logStore)

      // When an explicit list of IDs is provided, restrict the export to those
      // entries only. This allows the UI to mark individual logs for export
      // while preserving the legacy behaviour (export all filtered logs) when
      // no IDs are specified.
      const idsParam = safeString(query.ids)
      let effective = ordered
      if (idsParam) {
        const ids = idsParam
          .split(',')
          .map(value => value.trim())
          .filter(Boolean)
        if (ids.length > 0) {
          const idSet = new Set(ids.map(id => String(id)))
          effective = ordered.filter(log => log && idSet.has(String(log.id)))
        }
      }

      const items = effective.map(log => ({
        ...log,
        fileType: log && log.fileType ? log.fileType : getFileTypeFromLogEntry(log)
      }))

      res.json({ items, total: items.length })
    } catch (error) {
      res.status(500).json({ error: 'Failed to export logs' })
    }
  })

  router.get('/logs/:id', (req, res) => {
    try {
      const { id } = req.params
      const log = logStore.findById(id)

      if (!log) {
        return res.status(404).json({ error: 'Log not found' })
      }

      const view = buildClientLogView(log)
      if (!view) {
        return res.status(500).json({ error: 'Failed to build log view' })
      }

      res.json(view)
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch log details' })
    }
  })

  router.delete('/logs', (req, res) => {
    logStore.clear()
    bypassCounter.reset()
    suggestions.reset()
    stats.reset()
    ruleStore.clearUsage()
    res.json({ success: true, message: 'Logs cleared' })
  })

  return router
}

module.exports = { createLogsRoutes }
