'use strict'

/**
 * WebSocket proxying: the `upgrade` handler of the HTTP server (block /
 * direct tunnel / full proxy decision), the client-facing handshake and
 * framing through `ws` (a `WebSocketServer` in `noServer` mode), the
 * connection to the target through the `ws` client, and the per-message relay
 * with logging and rewrites.
 *
 * Both ends are terminated by `ws`, so fragmentation, control frames and
 * masking are handled by the library: pings, pongs and close frames (code and
 * reason) are relayed to the other side, an abnormal closure on one side
 * terminates the other, the subprotocol selected by the target is the one
 * announced to the client, and compression is never negotiated so that every
 * message is seen (and rewritten) uncompressed.
 */

const WebSocket = require('ws')
const { WebSocketServer } = WebSocket
const { URL } = require('url')
const { STRICT_TLS_ENABLED, WS_LOG_BODY_ENABLED } = require('../../config')
const { httpUrlToWebSocketUrl } = require('./websocket-url')
const { normalizeWebSocketPayload } = require('../logs/preview')
const { createRawWebSocketTunnel } = require('./tunnel')

/** @typedef {import('./router').Router} Router */
/** @typedef {import('../logs/entries').LogEntryFactory} LogEntryFactory */
/** @typedef {import('../logs/search').LogEntry} LogEntry */
/** @typedef {import('../api').BypassCounter} BypassCounter */
/** @typedef {ReturnType<typeof import('../rewrite/websocket').createWebSocketRewriter>} WebSocketRewriter */

/**
 * Client handshake headers copied to the target handshake. The
 * `Sec-WebSocket-*` headers are produced by `ws` itself (key, version,
 * extensions) or passed through the subprotocol list.
 */
const FORWARDED_HANDSHAKE_HEADERS = ['user-agent', 'origin', 'cookie', 'authorization']

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
 * @property {unknown} data Message payload as delivered by `ws` (Buffer, Buffer[] or ArrayBuffer).
 * @property {boolean} isBinary
 * @property {'server->client' | 'client->server'} direction
 * @property {string} wsUrl
 * @property {number} connectionId
 * @property {WebSocketMetrics} wsMetrics Mutable metrics object.
 * @property {(payload: Buffer, binary: boolean) => void} sendToTarget Function to send data to the other side.
 * @property {boolean} bypass
 */

/**
 * Subprotocols offered by the client, in order and without duplicates (the
 * `ws` client rejects a duplicated entry).
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string[]}
 */
function offeredProtocols (req) {
  const raw = req.headers['sec-websocket-protocol']
  const header = Array.isArray(raw) ? raw.join(',') : (raw || '')
  const seen = new Set()
  /** @type {string[]} */
  const list = []
  for (const entry of header.split(',')) {
    const name = entry.trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      list.push(name)
    }
  }
  return list
}

/**
 * Close one side the way the other side closed: a close frame is relayed
 * with its code and reason (a close frame without status stays without
 * status), an abnormal closure (no close frame, code 1006) terminates the
 * socket. Codes that cannot be sent in a close frame fall back to 1000.
 *
 * @param {WebSocket} ws
 * @param {number} code
 * @param {Buffer} reason
 * @returns {void}
 */
function mirrorClose (ws, code, reason) {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return
  if (code === 1006) {
    ws.terminate()
    return
  }
  if (code === 1005) {
    ws.close()
    return
  }
  const sendable = (code >= 1000 && code <= 1014 && code !== 1004) || (code >= 3000 && code <= 4999)
  try {
    ws.close(sendable ? code : 1000, reason)
  } catch {
    ws.terminate()
  }
}

/**
 * Create the WebSocket proxy bound to its collaborators.
 *
 * @param {WebSocketProxyDeps} deps
 */
function createWebSocketProxy ({ router, addLog, entries, webSocketRewriter, caBundle, bypassCounter }) {
  const { createWebSocketConnectionLog, logWebSocketMessage, logWebSocketDirectTunnel } = entries
  const { applyWebSocketRewritesAndDescribe } = webSocketRewriter

  /**
   * Unified WebSocket message handler for both directions.
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
   * the client handshake once the target accepted (announcing the subprotocol
   * the target selected), then relay messages, pings, pongs and close frames
   * in both directions (messages through handleWebSocketFrame) and log the
   * connection summary when either side closes.
   *
   * @param {import('http').IncomingMessage} clientReq
   * @param {import('stream').Duplex} clientSocket
   * @param {string} targetHost Host header sent to the target.
   * @param {number} _targetPort Unused: the port travels inside `fullUrl`.
   * @param {string} fullUrl Target URL (http(s) or ws(s) scheme).
   * @param {{ bypass?: boolean, head?: Buffer }} [options] `bypass` relays without rewrites or logging; `head` is the first packet of the upgraded socket.
   * @returns {void}
   */
  function handleWebSocketUpgrade (clientReq, clientSocket, targetHost, _targetPort, fullUrl, { bypass = false, head = Buffer.alloc(0) } = {}) {
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

    /** Refuse the upgrade while the raw socket is still ours. */
    const rejectUpgrade = () => {
      if (clientSocket.writable) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      }
      clientSocket.destroy()
    }

    // Prepare headers for target WebSocket connection
    /** @type {Record<string, string>} */
    const wsHeaders = {}
    for (const header of FORWARDED_HANDSHAKE_HEADERS) {
      const value = clientReq.headers[header]
      if (typeof value === 'string' && value) {
        wsHeaders[header] = value
      }
    }

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

    /** @type {WebSocket} */
    let targetWs
    try {
      targetWs = new WebSocket(wsUrl, offeredProtocols(clientReq), {
        headers: wsHeaders,
        perMessageDeflate: false,
        autoPong: false,
        ...wsTlsOptions
      })
    } catch {
      rejectUpgrade()
      return
    }

    /** The client side once the handshake has been answered. */
    /** @type {WebSocket|null} */
    let clientWs = null

    // Until the handshake is answered the raw socket is ours: a client that
    // gives up meanwhile must not leave the target connection open.
    const onEarlyClose = () => targetWs.terminate()
    clientSocket.once('close', onEarlyClose)

    targetWs.on('error', () => {
      logWebSocketSummary('target-error')
      if (clientWs) {
        clientWs.terminate()
      } else {
        rejectUpgrade()
      }
    })

    targetWs.on('close', (code, reason) => {
      logWebSocketSummary('target-closed')
      if (clientWs) {
        mirrorClose(clientWs, code, reason)
      } else {
        clientSocket.destroy()
      }
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

      const wss = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        autoPong: false,
        clientTracking: false,
        // The client gets the subprotocol the target selected, none otherwise.
        handleProtocols: () => targetWs.protocol || false
      })

      // Answers the handshake (or refuses it with 400 and destroys the socket,
      // in which case the early-close listener ends the target side).
      wss.handleUpgrade(clientReq, clientSocket, head, accepted => {
        clientSocket.removeListener('close', onEarlyClose)
        clientWs = accepted
        relay(accepted)
      })
    })

    /**
     * Wire both `ws` endpoints together.
     *
     * @param {WebSocket} client
     */
    function relay (client) {
      client.on('message', (data, isBinary) => {
        if (targetWs.readyState !== WebSocket.OPEN) return

        handleWebSocketFrame({
          data,
          isBinary,
          direction: 'client->server',
          wsUrl,
          connectionId,
          wsMetrics,
          sendToTarget: (payload, binary) => targetWs.send(payload, { binary }),
          bypass
        })
      })

      targetWs.on('message', (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN) return

        handleWebSocketFrame({
          data,
          isBinary,
          direction: 'server->client',
          wsUrl,
          connectionId,
          wsMetrics,
          sendToTarget: (payload, binary) => client.send(payload, { binary }),
          bypass
        })
      })

      // Control frames are relayed as they are (neither side answers pings
      // on its own, see autoPong above).
      client.on('ping', data => {
        if (targetWs.readyState === WebSocket.OPEN) targetWs.ping(data)
      })
      client.on('pong', data => {
        if (targetWs.readyState === WebSocket.OPEN) targetWs.pong(data)
      })
      targetWs.on('ping', data => {
        if (client.readyState === WebSocket.OPEN) client.ping(data)
      })
      targetWs.on('pong', data => {
        if (client.readyState === WebSocket.OPEN) client.pong(data)
      })

      client.on('close', (code, reason) => {
        logWebSocketSummary('client-closed')
        mirrorClose(targetWs, code, reason)
      })

      client.on('error', () => {
        logWebSocketSummary('client-error')
        targetWs.terminate()
      })
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

    handleWebSocketUpgrade(req, socket, targetHost, targetPort, targetUrl, { bypass: false, head })
  }

  return {
    handleWebSocketFrame,
    handleWebSocketUpgrade,
    handleUpgrade
  }
}

/** @typedef {ReturnType<typeof createWebSocketProxy>} WebSocketProxy */

module.exports = { createWebSocketProxy }
