'use strict'

/**
 * Management API: host-system helpers (`/api/system/*`).
 *
 * @module api/system
 */

const express = require('express')
const { showNativeFilePicker } = require('../system/file-picker')

/**
 * @returns {import('express').Router}
 */
function createSystemRoutes() {
  const router = express.Router()

  // Open a native file picker (Windows) for local path selection.
  router.post('/system/file-picker', async (req, res) => {
    if (process.platform !== 'win32') {
      return res.status(501).json({ error: 'The native file picker is only available on Windows.' })
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const title = body.title == null ? undefined : String(body.title)
    const filter = body.filter == null ? undefined : String(body.filter)

    try {
      const filePath = await showNativeFilePicker({ title, filter })
      res.json({ path: filePath || null, canceled: !filePath })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      res.status(500).json({ error: message || 'Failed to open the file picker.' })
    }
  })

  return router
}

module.exports = { createSystemRoutes }
