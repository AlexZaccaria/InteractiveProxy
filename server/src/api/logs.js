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
const {
  ReplayInputError,
  isReplayable,
  buildReplayRequest,
  describeReplayRequest,
  applyReplayOverrides,
  buildCurlCommand
} = require('../logs/replay')
const { buildHar, parseHar } = require('../logs/har')
const { REPLAY_BODY_MAX_BYTES } = require('../../config')
const { version: PROXY_VERSION } = require('../../package.json')

/**
 * @typedef {object} LogsRoutesDeps
 * @property {import('../logs/store').LogStore} logStore
 * @property {import('../logs/stats').Stats} stats
 * @property {import('../logs/suggestions').SuggestionTracker} suggestions
 * @property {import('../rules/store').RuleStore} ruleStore
 * @property {import('./index').BypassCounter} bypassCounter
 * @property {import('../logs/replay').ReplayRunner} replay
 */

/**
 * @param {LogsRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createLogsRoutes({ logStore, stats, suggestions, ruleStore, bypassCounter, replay }) {
  const router = express.Router()

  /**
   * The entry of `/logs/:id/...` when it exists and can be replayed; answers
   * the request otherwise.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @returns {import('../logs/search').LogEntry | null}
   */
  function findReplayableLog(req, res) {
    const log = logStore.findById(req.params.id)
    if (!log) {
      res.status(404).json({ error: 'Log not found' })
      return null
    }
    if (!isReplayable(log)) {
      res.status(400).json({ error: 'This entry cannot be replayed' })
      return null
    }
    return log
  }

  router.get('/logs/:id/replay', (req, res) => {
    const log = findReplayableLog(req, res)
    if (!log) return
    try {
      res.json(describeReplayRequest(log))
    } catch (error) {
      res.status(500).json({ error: 'Failed to build the replay request' })
    }
  })

  router.post('/logs/:id/replay', async (req, res) => {
    const log = findReplayableLog(req, res)
    if (!log) return

    let request
    try {
      request = applyReplayOverrides(buildReplayRequest(log), req.body)
    } catch (error) {
      if (error instanceof ReplayInputError) {
        return res.status(400).json({ error: error.message })
      }
      return res.status(500).json({ error: 'Failed to build the replay request' })
    }

    try {
      const result = await replay.send(log, request)
      res.json({ success: true, ...result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(502).json({ error: `Replay failed: ${message}` })
    }
  })

  router.get('/logs/:id/curl', (req, res) => {
    const log = findReplayableLog(req, res)
    if (!log) return
    try {
      const viaProxy = ['1', 'true', 'yes'].includes(safeString(req.query.viaProxy).toLowerCase())
      res.json(
        buildCurlCommand(buildReplayRequest(log), { proxyUrl: viaProxy ? replay.proxyUrl : null })
      )
    } catch (error) {
      res.status(500).json({ error: 'Failed to build the curl command' })
    }
  })

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

      if (safeString(query.format).toLowerCase() === 'har') {
        res.json(buildHar(effective, { version: PROXY_VERSION }))
        return
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

  router.post('/logs/import', (req, res) => {
    let parsed
    try {
      parsed = parseHar(req.body, {
        maxEntries: logStore.capacity,
        retainBodyBytes: REPLAY_BODY_MAX_BYTES
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return res.status(400).json({ error: message })
    }
    for (const entry of parsed.entries) logStore.add(entry)
    res.json({ success: true, imported: parsed.entries.length, skipped: parsed.skipped })
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
