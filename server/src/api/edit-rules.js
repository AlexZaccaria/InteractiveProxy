'use strict'

/**
 * Management API: live edit rules and their presets (`/api/edit-rules*`,
 * `/api/edit-rule-presets*`).
 *
 * @module api/edit-rules
 */

const path = require('path')
const fsPromises = require('fs').promises
const express = require('express')
const { coerceJsonPathScalarFromText } = require('../rules/schema')

/**
 * @typedef {object} EditRulesRoutesDeps
 * @property {import('../rules/store').RuleStore} ruleStore
 * @property {string} storageDir
 * @property {import('multer').Multer} upload
 */

/**
 * @param {EditRulesRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createEditRulesRoutes({ ruleStore, storageDir, upload }) {
  const router = express.Router()

  router.get('/edit-rule-presets', (req, res) => {
    res.json({ presets: ruleStore.getPresets() })
  })

  router.post('/edit-rule-presets', async (req, res) => {
    const raw =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null

    if (!raw) {
      return res.status(400).json({ error: 'Invalid payload: expected JSON object.' })
    }

    const preset = ruleStore.addPreset(raw)
    await ruleStore.savePresets()

    res.status(201).json({ preset })
  })

  router.delete('/edit-rule-presets/:id', async (req, res) => {
    const { id } = req.params

    if (!ruleStore.removePreset(id)) {
      return res.status(404).json({ error: 'Preset not found' })
    }

    await ruleStore.savePresets()
    res.status(204).end()
  })

  router.get('/edit-rules', (req, res) => {
    res.json({ rules: ruleStore.getRules() })
  })

  /**
   * Return a lightweight usage report for live edit rules.
   *
   * The payload is intentionally compact: a flat id->count map that the
   * frontend can join with /api/edit-rules metadata without duplicating
   * rule configuration on the wire.
   */
  router.get('/edit-rules/usage', (req, res) => {
    res.json(ruleStore.getUsageSnapshot())
  })

  router.post('/edit-rules/value-file', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'File is required' })
      }

      let valueType = 'string'
      try {
        const filePath = path.join(storageDir, req.file.filename)
        const text = await fsPromises.readFile(filePath, 'utf8')
        valueType = coerceJsonPathScalarFromText(text).valueType
      } catch {
        valueType = 'string'
      }

      res.json({
        filename: req.file.filename,
        originalName: req.file.originalname,
        valueType
      })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/edit-rules', (req, res) => {
    // Allow both legacy text rules and new jsonPath rules. The normalizeEditRule
    // helper is responsible for interpreting the payload and ensuring a
    // consistent internal representation.
    const raw =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null

    if (!raw) {
      return res.status(400).json({ error: 'Invalid payload: expected JSON object.' })
    }

    const rule = ruleStore.addRule(raw)
    ruleStore.save()

    res.status(201).json({ rule })
  })

  router.put('/edit-rules/:id', (req, res) => {
    const { id } = req.params
    if (!ruleStore.findRule(id)) {
      return res.status(404).json({ error: 'Rule not found' })
    }

    const patch =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null

    if (!patch) {
      return res.status(400).json({ error: 'Invalid payload: expected JSON object.' })
    }

    const updated = ruleStore.updateRule(id, patch)
    ruleStore.save()

    res.json({ rule: updated })
  })

  router.delete('/edit-rules/:id', (req, res) => {
    const { id } = req.params

    if (!ruleStore.removeRule(id)) {
      return res.status(404).json({ error: 'Rule not found' })
    }

    ruleStore.save()

    res.status(204).end()
  })

  return router
}

module.exports = { createEditRulesRoutes }
