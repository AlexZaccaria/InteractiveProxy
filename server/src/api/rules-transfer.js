'use strict'

/**
 * Management API: export and import of every rule kind in one file
 * (`/api/rules/export`, `/api/rules/import`): edit rules and their presets,
 * blocked rules, filter rules and breakpoint rules.
 *
 * @module api/rules-transfer
 */

const express = require('express')
const { normalizeBlockedRule, normalizeBypassRule } = require('../proxy/router')
const { normalizeBreakpointRule } = require('../rules/breakpoint-store')
const { safeString } = require('../util/strings')

const FORMAT = 'interactive-proxy-rules'
const VERSION = 1

/**
 * @typedef {object} RulesTransferDeps
 * @property {import('../rules/store').RuleStore} ruleStore
 * @property {import('../proxy/router').Router} router
 * @property {import('../rules/breakpoint-store').BreakpointStore} breakpointStore
 */

/**
 * Merge imported records into the existing ones by id: a record with the
 * id of an existing one replaces it, the others are appended.
 *
 * @template {{ id?: unknown }} T
 * @param {T[]} existing
 * @param {T[]} imported
 * @returns {T[]}
 */
function mergeById(existing, imported) {
  const result = existing.slice()
  for (const record of imported) {
    // A record without an id is always new: it gets one when normalised.
    const id = typeof record.id === 'string' && record.id ? record.id : null
    const index = id === null ? -1 : result.findIndex(item => item.id === id)
    if (index === -1) result.push(record)
    else result[index] = record
  }
  return result
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>[]}
 */
function recordsOf(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []
}

/**
 * @param {RulesTransferDeps} deps
 * @returns {import('express').Router}
 */
function createRulesTransferRoutes({ ruleStore, router: proxyRouter, breakpointStore }) {
  const router = express.Router()

  router.get('/rules/export', (req, res) => {
    res.json({
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      editRules: ruleStore.getRules(),
      presets: ruleStore.getPresets(),
      blockedRules: proxyRouter.getBlockedRules(),
      filterRules: proxyRouter.getBypassRules(),
      breakpointRules: breakpointStore.getRules()
    })
  })

  router.post('/rules/import', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : null
    if (!body || body.format !== FORMAT) {
      return res.status(400).json({ error: `Not a rules file: "format" must be "${FORMAT}"` })
    }
    if (body.version !== undefined && Number(body.version) > VERSION) {
      return res.status(400).json({ error: `Unsupported rules file version ${body.version}` })
    }
    const mode = safeString(body.mode).toLowerCase() === 'replace' ? 'replace' : 'merge'

    const editRules = recordsOf(body.editRules)
    const presets = recordsOf(body.presets)
    const blockedRules = recordsOf(body.blockedRules).map(normalizeBlockedRule)
    const filterRules = recordsOf(body.filterRules).map(normalizeBypassRule)
    const breakpointRules = recordsOf(body.breakpointRules)
      .map(normalizeBreakpointRule)
      .filter(rule => rule.url)

    try {
      if (editRules.length > 0 || mode === 'replace') {
        ruleStore.replaceRules(
          mode === 'replace' ? editRules : mergeById(ruleStore.getRules(), editRules)
        )
        await ruleStore.save()
      }

      if (presets.length > 0 || mode === 'replace') {
        const current = ruleStore.getPresets()
        const next = mode === 'replace' ? presets : mergeById(current, presets)
        for (const preset of current.slice()) ruleStore.removePreset(preset.id)
        for (const preset of next) ruleStore.addPreset(preset)
        await ruleStore.savePresets()
      }

      if (blockedRules.length > 0 || mode === 'replace') {
        proxyRouter.setBlockedRules(
          mode === 'replace' ? blockedRules : mergeById(proxyRouter.getBlockedRules(), blockedRules)
        )
        await proxyRouter.saveBlockedUrls()
      }

      if (filterRules.length > 0 || mode === 'replace') {
        proxyRouter.setBypassRules(
          mode === 'replace' ? filterRules : mergeById(proxyRouter.getBypassRules(), filterRules)
        )
        await proxyRouter.saveBypassUrls()
      }

      if (breakpointRules.length > 0 || mode === 'replace') {
        breakpointStore.setRules(
          mode === 'replace'
            ? breakpointRules
            : mergeById(breakpointStore.getRules(), breakpointRules)
        )
        await breakpointStore.save()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return res.status(500).json({ error: `Import failed: ${message}` })
    }

    res.json({
      success: true,
      mode,
      counts: {
        editRules: editRules.length,
        presets: presets.length,
        blockedRules: blockedRules.length,
        filterRules: filterRules.length,
        breakpointRules: breakpointRules.length
      }
    })
  })

  return router
}

module.exports = { FORMAT, VERSION, mergeById, createRulesTransferRoutes }
