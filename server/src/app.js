'use strict'

/**
 * Express application of the proxy: CORS, body capture, the guard that hands
 * traffic addressed to other hosts to the proxy flow, the management API,
 * the bundled UI and the catch-all proxy handler.
 *
 * @module app
 */

const fs = require('fs')
const path = require('path')
const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const { getContentType, isProtoContentType } = require('./codecs/compression')

/**
 * @typedef {import('http').IncomingMessage & { rawBody?: Buffer }} RequestWithRawBody
 */

/**
 * Keep the raw bytes of every parsed body on `req.rawBody` so the proxy flow
 * can forward them unchanged.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Buffer} buf
 */
function captureRawBody(req, res, buf) {
  if (buf && buf.length) {
    ;/** @type {RequestWithRawBody} */ (req).rawBody = Buffer.from(buf)
  }
}

/**
 * @typedef {object} AppOptions
 * @property {string[]} uiOrigins Browser origins allowed to call the API.
 * @property {string} bodyLimit Body size limit accepted by the parsers (e.g. "10mb").
 * @property {(req: import('http').IncomingMessage) => boolean} isProxyTargetedRequest
 *   True for traffic addressed to another host (to forward, not to route).
 * @property {(req: import('express').Request, res: import('express').Response) => unknown} handleProxiedHttpRequest
 *   The proxy flow (local resources, forwarding, logging).
 * @property {import('express').Router} apiRouter The management API (mounted under /api).
 * @property {string} [clientBuildDir] Directory of the built client, served when it exists.
 */

/**
 * Build the Express application.
 *
 * @param {AppOptions} options
 * @returns {import('express').Express}
 */
function createApp({
  uiOrigins,
  bodyLimit,
  isProxyTargetedRequest,
  handleProxiedHttpRequest,
  apiRouter,
  clientBuildDir
}) {
  const app = express()

  // Middleware
  app.use(
    cors({
      origin: (origin, callback) => {
        // Requests without an Origin header come from non-browser clients
        // (curl, scripts) and are allowed. Browser requests are allowed only
        // from the UI origins so other websites cannot read API responses.
        callback(null, !origin || uiOrigins.includes(origin))
      }
    })
  )

  app.set('trust proxy', true)
  app.use(
    bodyParser.raw({
      type: req => isProtoContentType(getContentType(req.headers)),
      limit: bodyLimit,
      verify: captureRawBody,
      inflate: false
    })
  )
  app.use(bodyParser.json({ limit: bodyLimit, verify: captureRawBody }))
  app.use(bodyParser.urlencoded({ extended: true, limit: bodyLimit, verify: captureRawBody }))
  // Every other body (text/plain, XML, binary, multipart of proxied traffic) is
  // captured raw so the proxy flow forwards it byte for byte. Multipart bodies
  // addressed to the management API are left to multer.
  app.use(
    bodyParser.raw({
      type: req => {
        const contentType = getContentType(req.headers).toLowerCase()
        if (contentType.startsWith('multipart/')) return isProxyTargetedRequest(req)
        return true
      },
      limit: bodyLimit,
      verify: captureRawBody,
      inflate: false
    })
  )

  // Express routes by path, so a proxied request such as
  // http://example.com/api/users or http://example.com/index.html would
  // otherwise be answered by the management API or the bundled UI. Hand traffic
  // addressed to other hosts to the proxy flow before any route is considered.
  app.use((req, res, next) => {
    if (isProxyTargetedRequest(req)) {
      return handleProxiedHttpRequest(req, res)
    }
    next()
  })

  app.use('/api', apiRouter)

  // Bundled UI: when the client has been built (`npm run build`), serve it from
  // the proxy's own origin so a single process is enough. Only requests
  // addressed to the proxy itself get here (see isProxyTargetedRequest), and
  // paths that are not files of the build fall through to the proxy flow.
  if (clientBuildDir && fs.existsSync(path.join(clientBuildDir, 'index.html'))) {
    app.use(express.static(clientBuildDir, { index: 'index.html' }))
  }

  // Proxy middleware - handles all other requests
  app.use('*', handleProxiedHttpRequest)

  return app
}

module.exports = { createApp, captureRawBody }
