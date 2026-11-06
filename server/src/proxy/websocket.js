'use strict'

/**
 * WebSocket proxying: the `upgrade` handler of the HTTP server (block /
 * direct tunnel / full proxy decision), the client-facing handshake, the
 * connection to the target through `ws`, and the per-frame relay with
 * logging and rewrites.
 *
 * Frames from the client are decoded with the hand-written codec of
 * `websocket-codec.js`, whose limits are listed there (one frame per socket
 * read, no fragment reassembly, control frames relayed as data).
 */

const WebSocket = require('ws')
const { URL } = require('url')
const { STRICT_TLS_ENABLED, WS_LOG_BODY_ENABLED } = require('../../config')
const {
  generateWebSocketAccept,
  httpUrlToWebSocketUrl,
  createWebSocketFrame,
  decodeWebSocketFrame
} = require('./websocket-codec')
const { normalizeWebSocketPayload } = require('../logs/preview')
const { createRawWebSocketTunnel } = require('./tunnel')

/** @typedef {import('./router').Router} Router */
/** @typedef {import('../logs/entries').LogEntryFactory} LogEntryFactory */
/** @typedef {import('../logs/search').LogEntry} LogEntry */
/** @typedef {import('../api').BypassCounter} BypassCounter */
/** @typedef {ReturnType<typeof import('../rewrite/websocket').createWebSocketRewriter>} WebSocketRewriter */

/**
 * @typedef {object} WebSocketProxyDeps
 * @property {Router} router
 * @property {(entry: LogEntry) => void} addLog
 * @property {Pick<LogEntryFactory, 'createWebSocketConnectionLog' | 'logWebSocketMessage' | 'logWebSocketDirectTunnel'>} entries
 * @property {WebSocketRewriter} webSocketRewriter
 * @property {string | null} caBundle Additional CA bundle (PEM) for strict TLS towards the target.
 * @property {BypassCounter} bypassCounter
 */

/**
 * Mutable per-connection counters, logged in the summary entry when the
 * connection ends.
 *
 * @typedef {object} WebSocketMetrics
 * @property {number} connectionId
 * @property {string} wsUrl
 * @property {number} messagesClientToServer
 * @property {number} messagesServerToClient
 * @property {number} bytesClientToServer
 * @property {number} bytesServerToClient
 * @property {number} rewrittenMessages
 */

/**
 * @typedef {object} WebSocketFrameParams
 * @property {unknown} data Raw frame data (server->client) or decoded payload (client->server).
 * @property {boolean} isBinary
 * @property {'server->client' | 'client->server'} direction
 * @property {string} wsUrl
 * @property {number} connectionId
 * @property {WebSocketMetrics} wsMetrics Mutable metrics object.
 * @property {(payload: Buffer, binary: boolean) => void} sendToTarget Function to send data to target.
 * @property {boolean} bypass
 */

/**
 * Create the WebSocket proxy bound to its collaborators.
 *
 * @param {WebSocketProxyDeps} deps
 */
function createWebSocketProxy ({ router, addLog, entries, webSocketRewriter, caBundle, bypassCounter }) {
  const { createWebSocketConnectionLog, logWebSocketMessage, logWebSocketDirectTunnel } = entries
  const { applyWebSocketRewritesAndDescribe } = webSocketRewriter

  /**
   * Unified WebSocket frame handler for both directions.
   * Handles bypass mode, light logging mode, and full rewrite mode.
   *
   * @param {WebSocketFrameParams} params
   * @returns {void}
   */
  function handleWebSocketFrame ({ data, isBinary, direction, wsUrl, connectionId, wsMetrics, sendToTarget, bypass }) {
    const isServerToClient = direction === 'server->client'
    const phase = isServerToClient ? 'response' : 'request'

    // Bypass mode: forward as-is without any processing
    if (bypass) {
      const payloadBuffer = normalizeWebSocketPayload(data)
      sendToTarget(payloadBuffer, isBinary)
      return
    }

    // Light mode: forward as-is but log basic metadata
    if (!WS_LOG_BODY_ENABLED) {
      const payloadBuffer = normalizeWebSocketPayload(data)
      const size = payloadBuffer.length

      if (isServerToClient) {
        wsMetrics.messagesServerToClient += 1
        wsMetrics.bytesServerToClient += size
      } else {
        wsMetrics.messagesClientToServer += 1
        wsMetrics.bytesClientToServer += size
      }

      sendToTarget(payloadBuffer, isBinary)

      logWebSocketMessage({
        direction,
        wsUrl,
        connectionId,
        payloadBuffer,
        isBinary,
        loggingDisabled: true
      })
      return
    }

    // Full mode: apply rewrites and log full content
    const { buffer: payloadBuffer, rewrites, body, originalBody, jsonAfter } = applyWebSocketRewritesAndDescribe(
      data,
      isBinary,
      { requestUrl: wsUrl, fullUrl: wsUrl, phase }
    )

    sendToTarget(payloadBuffer, isBinary)

    const size = payloadBuffer.length
    if (isServerToClient) {
      wsMetrics.messagesServerToClient += 1
      wsMetrics.bytesServerToClient += size
    } else {
      wsMetrics.messagesClientToServer += 1
      wsMetrics.bytesClientToServer += size
    }

    if (Array.isArray(rewrites) && rewrites.length) {
      wsMetrics.rewrittenMessages += 1
    }

    logWebSocketMessage({
      direction,
      wsUrl,
      connectionId,
      payloadBuffer,
      isBinary,
      bodyText: body,
      rewrites,
      // The logger only reads this field when it is a string, so a null
      // original body and an absent one are equivalent.
      originalBodyText: originalBody ?? undefined,
      bodyJson: jsonAfter
    })
  }

  /**
   * Complete a WebSocket upgrade: open the connection to the target, answer
   * the client handshake once the target accepted, then relay frames in both
   * directions (through handleWebSocketFrame) and log the connection summary
   * when either side closes.
   *
   * @param {import('http').IncomingMessage} clientReq
   * @param {import('stream').Duplex} clientSocket
   * @param {string} targetHost Host header sent to the target.
   * @param {number} targetPort
   * @param {string} fullUrl Target URL (http(s) or ws(s) scheme).
   * @param {{ bypass?: boolean }} [options] `bypass` relays without rewrites or logging.
   * @returns {void}
   */
  function handleWebSocketUpgrade (clientReq, clientSocket, targetHost, targetPort, fullUrl, { bypass = false } = {}) {
    const rawUrl = fullUrl || ''
    const wsUrl = httpUrlToWebSocketUrl(rawUrl) || rawUrl
    const connectionId = Date.now() + Math.random()
    const connectionStartTs = Date.now()
    /** @type {WebSocketMetrics} */
    const wsMetrics = {
      connectionId,
      wsUrl,
      messagesClientToServer: 0,
      messagesServerToClient: 0,
      bytesClientToServer: 0,
      bytesServerToClient: 0,
      rewrittenMessages: 0
    }
    let summaryLogged = false

    /** @param {string} [reason] */
    const logWebSocketSummary = (reason) => {
      if (summaryLogged || bypass) return
      summaryLogged = true

      const durationMs = Date.now() - connectionStartTs

      const summaryLog = {
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        method: 'WS',
        url: wsUrl,
        fullUrl: wsUrl,
        source: 'websocket',
        direction: 'summary',
        isConnectionLog: true,
        isWebSocketSummary: true,
        connectionId,
        wsSummary: {
          ...wsMetrics,
          durationMs,
          closeReason: reason || null
        },
        headers: {},
        body: `[WS summary] C->S: ${wsMetrics.messagesClientToServer} messages / ${wsMetrics.bytesClientToServer} bytes, ` +
          `S->C: ${wsMetrics.messagesServerToClient} messages / ${wsMetrics.bytesServerToClient} bytes, ` +
          `rewritten: ${wsMetrics.rewrittenMessages}, duration: ${durationMs}ms`,
        responseBody: null,
        responseHeaders: null
      }

      addLog(summaryLog)
    }

    try {
      // Prepare headers for target WebSocket connection
      /** @type {Record<string, string>} */
      const wsHeaders = {}

      // Copy important headers
      const headersToForward = [
        'user-agent',
        'origin',
        'sec-websocket-version',
        'sec-websocket-key',
        'sec-websocket-extensions',
        'sec-websocket-protocol',
        'cookie',
        'authorization'
      ]

      headersToForward.forEach(header => {
        if (clientReq.headers[header]) {
          // None of the listed headers is ever an array in Node's parser.
          wsHeaders[header] = /** @type {string} */ (clientReq.headers[header])
        }
      })

      // Override host
      wsHeaders.host = targetHost

      // Create WebSocket connection to target server
      /** @type {{ rejectUnauthorized?: boolean, ca?: string }} */
      const wsTlsOptions = {}
      if (STRICT_TLS_ENABLED) {
        wsTlsOptions.rejectUnauthorized = true
        if (caBundle) {
          wsTlsOptions.ca = caBundle
        }
      } else {
        wsTlsOptions.rejectUnauthorized = false // Accept self-signed certs (dev default)
      }

      const targetWs = new WebSocket(wsUrl, {
        headers: wsHeaders,
        ...wsTlsOptions
      })

      targetWs.on('open', () => {
        if (!bypass) {
          const connectionLog = createWebSocketConnectionLog({
            wsUrl,
            source: 'websocket',
            headers: clientReq.headers,
            connectionId,
            message: 'WebSocket connection established'
          })
          addLog(connectionLog)
        }

        // Send upgrade response to client
        const upgradeHeaders = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${generateWebSocketAccept(String(clientReq.headers['sec-websocket-key']))}`
        ]

        if (clientReq.headers['sec-websocket-protocol']) {
          upgradeHeaders.push(`Sec-WebSocket-Protocol: ${clientReq.headers['sec-websocket-protocol']}`)
        }

        clientSocket.write(upgradeHeaders.join('\r\n') + '\r\n\r\n')

        // Pipe data bidirectionally with logging
        targetWs.on('message', (data, isBinary) => {
          if (!clientSocket.writable) return

          handleWebSocketFrame({
            data,
            isBinary,
            direction: 'server->client',
            wsUrl,
            connectionId,
            wsMetrics,
            sendToTarget: (payload, binary) => {
              const frame = createWebSocketFrame(payload, binary)
              clientSocket.write(frame)
            },
            bypass
          })
        })

        clientSocket.on('data', (data) => {
          try {
            const decoded = decodeWebSocketFrame(data)
            if (!decoded || targetWs.readyState !== WebSocket.OPEN) return

            handleWebSocketFrame({
              data: decoded.payload,
              isBinary: decoded.isBinary,
              direction: 'client->server',
              wsUrl,
              connectionId,
              wsMetrics,
              sendToTarget: (payload, binary) => {
                if (binary) {
                  targetWs.send(payload, { binary: true })
                } else {
                  targetWs.send(payload.toString('utf8'), { binary: false })
                }
              },
              bypass
            })
          } catch (e) {
          }
        })
      })

      targetWs.on('error', () => {
        logWebSocketSummary('target-error')
        clientSocket.end()
      })

      targetWs.on('close', () => {
        logWebSocketSummary('target-closed')
        clientSocket.end()
      })

      clientSocket.on('error', () => {
        logWebSocketSummary('client-error')
        targetWs.close()
      })

      clientSocket.on('close', () => {
        logWebSocketSummary('client-closed')
        targetWs.close()
      })
    } catch {
      clientSocket.end()
    }
  }

  /**
   * The `upgrade` handler of the plain HTTP server: resolve the target,
   * then block (204), tunnel verbatim (filter rules) or proxy the WebSocket
   * with logging and rewrites.
   *
   * @param {import('http').IncomingMessage} req
   * @param {import('stream').Duplex} socket
   * @param {Buffer} head
   * @returns {void}
   */
  function handleUpgrade (req, socket, head) {
    const resolvedTarget = router.resolveTargetFromRequest(req)
    const bypassInput = router.buildBypassInputFromHttpRequest(req, resolvedTarget)
    const decision = router.decideWebSocketHandling(bypassInput)
    const targetUrl = bypassInput.targetUrl || bypassInput.fullUrl

    if (!targetUrl) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    if (decision.action === 'block') {
      socket.write('HTTP/1.1 204 No Content\r\n\r\n')
      socket.destroy()
      return
    }

    if (decision.action === 'direct') {
      bypassCounter.increment()
      logWebSocketDirectTunnel({ targetUrl, headers: req.headers })

      createRawWebSocketTunnel({
        req,
        clientSocket: socket,
        head,
        targetUrl,
        strictTls: STRICT_TLS_ENABLED,
        caBundle
      })
      return
    }

    let parsed
    try {
      parsed = new URL(targetUrl)
    } catch (error) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
      return
    }

    const targetHost = parsed.hostname
    const targetPort = parsed.port ? Number(parsed.port) : ((parsed.protocol === 'https:' || parsed.protocol === 'wss:') ? 443 : 80)

    handleWebSocketUpgrade(req, socket, targetHost, targetPort, targetUrl, { bypass: false })
  }

  return {
    handleWebSocketFrame,
    handleWebSocketUpgrade,
    handleUpgrade
  }
}

/** @typedef {ReturnType<typeof createWebSocketProxy>} WebSocketProxy */

module.exports = { createWebSocketProxy }
