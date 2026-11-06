'use strict'

/**
 * Management API: local resources (`/api/resources*`).
 *
 * @module api/resources
 */

const path = require('path')
const fsPromises = require('fs').promises
const express = require('express')
const { safeTrim } = require('../util/strings')

/**
 * @typedef {object} ResourcesRoutesDeps
 * @property {import('../resources/store').ResourceStore} resourceStore
 * @property {string} storageDir
 * @property {import('multer').Multer} upload
 */

/**
 * @param {ResourcesRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createResourcesRoutes ({ resourceStore, storageDir, upload }) {
  const router = express.Router()

  router.get('/resources', (req, res) => {
    res.json(resourceStore.list())
  })

  router.post('/resources', upload.single('file'), async (req, res) => {
    try {
      const { url, contentType } = req.body || {}
      const rawUrl = safeTrim(url)

      if (!rawUrl) {
        return res.status(400).json({ error: 'URL is required' })
      }

      const normalizedContentType = safeTrim(contentType)

      /** @type {import('../resources/store').LocalResource} */
      let resourceData

      if (req.file) {
        // File upload
        resourceData = {
          type: 'file',
          filename: req.file.filename,
          originalName: req.file.originalname,
          contentType: normalizedContentType || req.file.mimetype,
          size: req.file.size,
          createdAt: new Date().toISOString(),
          enabled: true
        }
      } else if (req.body && Object.hasOwn(req.body, 'content') && req.body.content) {
        // Text/JSON content
        const filename = `${Date.now()}-content.txt`
        await fsPromises.writeFile(path.join(storageDir, filename), req.body.content)
        resourceData = {
          type: 'text',
          filename,
          contentType: normalizedContentType || 'text/plain',
          size: req.body.content.length,
          createdAt: new Date().toISOString(),
          enabled: true
        }
      } else {
        return res.status(400).json({ error: 'File or content is required' })
      }

      resourceStore.set(rawUrl, resourceData)
      await resourceStore.save()

      res.json({
        success: true,
        message: 'Resource added successfully',
        resource: { url: rawUrl, ...resourceData }
      })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/resources/toggle', async (req, res) => {
    try {
      const { url, enabled } = req.body || {}
      const rawUrl = safeTrim(url)

      if (!rawUrl) {
        return res.status(400).json({ error: 'URL is required' })
      }

      if (!resourceStore.has(rawUrl)) {
        return res.status(404).json({ error: 'Resource not found' })
      }

      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Invalid "enabled" flag: expected a boolean.' })
      }

      const updated = resourceStore.toggle(rawUrl, enabled !== false)
      await resourceStore.save()

      res.json({ success: true, resource: { url: rawUrl, ...updated } })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.delete('/resources/:encodedUrl', async (req, res) => {
    try {
      const url = decodeURIComponent(req.params.encodedUrl)

      if (await resourceStore.remove(url)) {
        await resourceStore.save()

        res.json({ success: true, message: 'Resource deleted successfully' })
      } else {
        res.status(404).json({ error: 'Resource not found' })
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  return router
}

module.exports = { createResourcesRoutes }
