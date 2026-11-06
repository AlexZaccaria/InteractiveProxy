'use strict'

/**
 * Upstream HTTP(S) access: the undici dispatchers (keep-alive pools, TLS
 * strictness), the shared request helper used by the HTTP bypass path, the
 * main proxy flow and the HTTPS MITM flow, and the common error answer.
 *
 * @module proxy/upstream
 */

const fs = require('fs')
const { URL } = require('url')
const { request, Agent } = require('undici')
const { logWarn } = require('../util/logger')

/** @typedef {import('undici').Dispatcher.ResponseData} UpstreamResponse */

/**
 * Read the optional CA bundle used as an additional trust anchor in strict
 * TLS mode. A missing or unreadable file is logged and yields null.
 *
 * @param {string} file PEM file path, or an empty string when not configured.
 * @returns {string | null}
 */
function loadCaBundle (file) {
  if (!file) return null
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    logWarn('tls', `Failed to read STRICT TLS CA file at ${file}`, error)
    return null
  }
}

/**
 * @typedef {object} UpstreamOptions
 * @property {boolean} strictTls Verify upstream certificates (false accepts self-signed certificates, the dev default).
 * @property {string | null} caBundle Additional CA bundle (PEM) for strict mode.
 * @property {number} headersTimeoutMs Undici headers timeout; 0 keeps the undici default.
 * @property {number} bodyTimeoutMs Undici body timeout; 0 keeps the undici default.
 */

/**
 * @typedef {object} UpstreamRequestParams
 * @property {string} url Fully qualified upstream URL.
 * @property {string} method HTTP method.
 * @property {Record<string, any>} headers Headers to send upstream.
 * @property {any} [body] Optional request body (Buffer, stream or string).
 * @property {AbortSignal} [abortSignal] Optional abort signal.
 * @property {boolean} [bufferResponse] Whether to buffer the entire response body.
 */

/**
 * @typedef {object} Upstream
 * @property {Agent} httpDispatcher
 * @property {Agent} httpsDispatcher
 * @property {string | null} caBundle The loaded CA bundle, also used by raw TLS and WebSocket upstream connections.
 * @property {(urlString: string) => Agent} selectDispatcher
 * @property {(url: string, baseOptions: Record<string, any>, abortSignal?: AbortSignal) => Record<string, any>} createUpstreamRequestOptions
 * @property {(params: UpstreamRequestParams) => Promise<{ response: UpstreamResponse, buffer: Buffer | null }>} performUpstreamRequest
 * @property {(res: import('http').ServerResponse, abortController: AbortController) => () => void} attachAbortOnClose
 * @property {() => Promise<void>} close Close both dispatchers (keep-alive sockets included).
 */

/**
 * Create the upstream access layer.
 *
 * @param {UpstreamOptions} options
 * @returns {Upstream}
 */
function createUpstream ({ strictTls, caBundle, headersTimeoutMs, bodyTimeoutMs }) {
  const httpDispatcher = new Agent({
    connections: 128,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000
  })

  const httpsConnectOptions = strictTls
    ? {
        rejectUnauthorized: true,
        ca: caBundle || undefined
      }
    : {
        rejectUnauthorized: false
      }

  const httpsDispatcher = new Agent({
    connections: 128,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connect: httpsConnectOptions
  })

  /**
   * @param {string} urlString
   * @returns {Agent}
   */
  function selectDispatcher (urlString) {
    try {
      const parsed = new URL(urlString)
      return parsed.protocol === 'https:' ? httpsDispatcher : httpDispatcher
    } catch (error) {
      return httpDispatcher
    }
  }

  /**
   * @param {string} url
   * @param {Record<string, any>} baseOptions
   * @param {AbortSignal} [abortSignal]
   * @returns {Record<string, any>}
   */
  function createUpstreamRequestOptions (url, baseOptions, abortSignal) {
    /** @type {Record<string, any>} */
    const options = {
      ...baseOptions,
      dispatcher: selectDispatcher(url),
      maxRedirections: 0
    }

    if (headersTimeoutMs > 0) {
      options.headersTimeout = headersTimeoutMs
    }

    if (bodyTimeoutMs > 0) {
      options.bodyTimeout = bodyTimeoutMs
    }

    if (abortSignal) {
      options.signal = abortSignal
    }

    return options
  }

  /**
   * Perform an upstream HTTP(S) request via Undici with standard dispatcher
   * selection and timeout handling, returning the raw response plus an
   * optional buffered body. Logging and rewrites are left to callers.
   *
   * @param {UpstreamRequestParams} params
   * @returns {Promise<{ response: UpstreamResponse, buffer: Buffer | null }>}
   */
  async function performUpstreamRequest ({
    url,
    method,
    headers,
    body,
    abortSignal,
    bufferResponse = false
  }) {
    const response = await request(
      url,
      createUpstreamRequestOptions(
        url,
        {
          method,
          headers,
          body
        },
        abortSignal
      )
    )

    let buffer = null
    if (bufferResponse) {
      buffer = response.body
        ? Buffer.from(await response.body.arrayBuffer())
        : Buffer.alloc(0)
    }

    return { response, buffer }
  }

  /**
   * Attach an AbortController to an HTTP response so that an upstream
   * request can be aborted automatically when the client connection closes.
   *
   * @param {import('http').ServerResponse} res
   * @param {AbortController} abortController
   * @returns {() => void} The close listener that was attached.
   */
  function attachAbortOnClose (res, abortController) {
    const onClose = () => {
      try {
        abortController.abort()
      } catch {}
    }

    res.on('close', onClose)
    return onClose
  }

  async function close () {
    await Promise.allSettled([httpDispatcher.close(), httpsDispatcher.close()])
  }

  return {
    httpDispatcher,
    httpsDispatcher,
    caBundle,
    selectDispatcher,
    createUpstreamRequestOptions,
    performUpstreamRequest,
    attachAbortOnClose,
    close
  }
}

/**
 * @typedef {object} UpstreamErrorParams
 * @property {Record<string, any> | null | undefined} [logEntry] Log entry to record the error on.
 * @property {Error} error The upstream error.
 * @property {import('http').ServerResponse} res Response object (Express or raw).
 * @property {string} [message] Error message for raw responses.
 * @property {boolean} [useJson] Use a JSON answer (Express style).
 */

/**
 * Handle an upstream request error by recording it on the log entry and
 * answering 502. Works with both Express responses and raw ServerResponse
 * objects.
 *
 * @param {UpstreamErrorParams} params
 * @param {(logEntry: Record<string, any>, error: Error) => void} recordUpstreamErrorOnLog
 */
function handleUpstreamError ({ logEntry, error, res, message = 'Bad Gateway', useJson = false }, recordUpstreamErrorOnLog) {
  if (logEntry) {
    recordUpstreamErrorOnLog(logEntry, error)
  }

  if (!res.headersSent) {
    const expressRes = /** @type {import('express').Response} */ (res)
    if (useJson && typeof expressRes.status === 'function') {
      expressRes.status(502).json({ error: 'Proxy error', message: error.message })
    } else {
      res.writeHead(502)
      res.end(message)
    }
  } else {
    try { res.end() } catch {}
  }
}

module.exports = {
  loadCaBundle,
  createUpstream,
  handleUpstreamError
}
