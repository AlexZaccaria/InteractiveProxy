'use strict'

/**
 * Management API: breakpoint rules (`/api/breakpoints`) and the flows held
 * at a breakpoint (`/api/breakpoints/pending`).
 *
 * @module api/breakpoints
 */

const express = require('express')
const { safeTrim, isValidId } = require('../util/strings')
const { normalizeBreakpointRule, normalizePhase } = require('../rules/breakpoint-store')
const { ReplayInputError } = require('../logs/replay')

/**
 * @typedef {object} BreakpointsRoutesDeps
 * @property {import('../rules/breakpoint-store').BreakpointStore} breakpointStore
 * @property {import('../proxy/breakpoints').BreakpointGate} breakpointGate
 */

const PHASES = new Set(['request', 'response', 'both'])

/**
 * @param {BreakpointsRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createBreakpointsRoutes({ breakpointStore, breakpointGate }) {
  const router = express.Router()

  router.get('/breakpoints', (req, res) => {
    res.json(breakpointStore.getRules())
  })

  router.post('/breakpoints', async (req, res) => {
    const { id, url, action, enabled, name, phase } = req.body || {}
    const rules = breakpointStore.getRules()

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
    if (phase !== undefined && !PHASES.has(String(phase).toLowerCase())) {
      return res
        .status(400)
        .json({ error: 'Invalid "phase": expected "request", "response" or "both".' })
    }

    if (action === 'add') {
      const normalizedUrl = safeTrim(url)
      if (!normalizedUrl) {
        return res.status(400).json({ error: 'URL is required' })
      }
      rules.push(normalizeBreakpointRule({ id, enabled, name, url: normalizedUrl, phase }))
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
      if (phase !== undefined) next.phase = normalizePhase(phase)
      rules[index] = normalizeBreakpointRule(next)
    } else {
      if (!isValidId(id)) {
        return res.status(400).json({ error: 'ID is required for remove' })
      }
      breakpointStore.setRules(rules.filter(rule => rule.id !== id))
    }

    await breakpointStore.save()
    res.json({ success: true, breakpointRules: breakpointStore.getRules() })
  })

  router.get('/breakpoints/pending', (req, res) => {
    res.json({ items: breakpointGate.list() })
  })

  router.post('/breakpoints/pending/:id/resume', (req, res) => {
    try {
      if (!breakpointGate.resume(req.params.id, req.body || {})) {
        return res.status(404).json({ error: 'No flow is paused with this id' })
      }
      res.json({ success: true })
    } catch (error) {
      if (error instanceof ReplayInputError) {
        return res.status(400).json({ error: error.message })
      }
      res.status(500).json({ error: 'Failed to resume the flow' })
    }
  })

  router.post('/breakpoints/pending/:id/abort', (req, res) => {
    if (!breakpointGate.abort(req.params.id)) {
      return res.status(404).json({ error: 'No flow is paused with this id' })
    }
    res.json({ success: true })
  })

  return router
}

module.exports = { createBreakpointsRoutes }
