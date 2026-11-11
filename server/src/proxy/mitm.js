'use strict'

/**
 * HTTPS interception: the `connect` handler of the HTTP server. A CONNECT
 * that the filter rules mark as direct is tunnelled verbatim; every other
 * tunnel is terminated with a certificate issued by the proxy's CA for the
 * requested host, and the decrypted requests go through the same local
 * resource / rewrite / forward / log pipeline as plain HTTP (WebSocket
 * upgrades included).
 *
 * All tunnels share one `https.Server`, created on the first CONNECT: the SNI
 * callback picks the certificate of the name the client asks for (secure
 * contexts are cached per name), and clients that send no SNI (IP-literal
 * targets) get the certificate of the CONNECT host through the server's
 * default context, swapped before the socket is handed over. The request
 * handler finds the CONNECT target of its connection through the client
 * socket's remote endpoint.
 */

const http = require('http')
const https = require('https')
const tls = require('tls')
const { URL } = require('url')
const { MITM_BYPASS_REWRITES_ENABLED, REPLAY_BODY_MAX_BYTES } = require('../../config')
const { getCA, generateCertForHost } = require('../tls/ca')
const { createLruCache } = require('../util/lru')
const { retainRequestBody } = require('../logs/replay')
const {
  recordBreakpointOnLog,
  abortAtBreakpoint: abortFlowAtBreakpoint,
  headersForTarget
} = require('./breakpoints')
const { createRawTunnel } = require('./tunnel')
const { getContentType, getHeaderCaseInsensitive } = require('../codecs/compression')
const { STREAMED_BODY_MARKER, shouldStreamResponse, pipeUpstreamBody } = require('./streaming')

/** Secure contexts kept per SNI name. */
const SECURE_CONTEXT_CACHE_MAX = 500

/**
 * Target of a CONNECT tunnel, as seen by the decrypted requests.
 *
 * @typedef {object} TunnelTarget
 * @property {string} host
 * @property {number} port
 * @property {string} authority `host`, or `host:port` when the port is not 443.
 */

/**
 * Key identifying a client connection on both the raw socket and the TLS
 * socket wrapped around it (same underlying handle, same endpoint).
 *
 * @param {import('net').Socket} socket
 * @returns {string}
 */
function socketKey(socket) {
  return `${socket.remoteFamily || ''}|${socket.remoteAddress || ''}|${socket.remotePort || ''}`
}
const {
  OMIT_HEADERS_MITM,
  OMIT_RESPONSE_HEADERS,
  createForwardHeaders,
  sanitizeAndStripIdentifyingHeaders,
  applyCacheBypassHeadersToObject,
  setContentLength
} = require('./headers')
const { handleUpstreamError: handleUpstreamErrorWithRecorder } = require('./upstream')

/** @typedef {import('../state/config-store').ConfigStore} ConfigStore */
/** @typedef {import('./router').Router} Router */
/** @typedef {import('./upstream').Upstream} Upstream */
/** @typedef {import('../resources/store').ResourceStore} ResourceStore */
/** @typedef {import('../logs/entries').LogEntryFactory} LogEntryFactory */
/** @typedef {import('../logs/search').LogEntry} LogEntry */
/** @typedef {import('../api').BypassCounter} BypassCounter */
/** @typedef {ReturnType<typeof import('../rewrite/body').createBodyRewriter>} BodyRewriter */
/** @typedef {ReturnType<typeof import('../rewrite/http-json').createHttpJsonRewriter>} HttpJsonRewriter */
/** @typedef {import('./http-flow').HttpFlow} HttpFlow */
/** @typedef {import('./websocket').WebSocketProxy} WebSocketProxy */

/**
 * @typedef {object} MitmDeps
 * @property {ConfigStore} configStore
 * @property {Router} router
 * @property {Upstream} upstream
 * @property {ResourceStore} resourceStore
 * @property {(entry: LogEntry) => void} addLog
 * @property {Pick<LogEntryFactory, 'createHttpFlowLogEntry' | 'logWebSocketDirectTunnel' | 'recordUpstreamErrorOnLog'>} entries
 * @property {BodyRewriter} bodyRewriter
 * @property {HttpJsonRewriter} httpJson
 * @property {Pick<HttpFlow, 'handleDirectHttpFlow' | 'hasApplicableRules'>} httpFlow
 * @property {Pick<WebSocketProxy, 'handleWebSocketUpgrade'>} webSocketProxy
 * @property {BypassCounter} bypassCounter
 * @property {Pick<import('../logs/stats').Stats, 'recordStreamedResponseSize'>} stats Receives the size of streamed responses once known.
 * @property {import('./breakpoints').BreakpointGate} breakpoints Pauses the flows that match a breakpoint rule.
 * @property {(entry: LogEntry) => void} touchLog Re-publishes an entry changed after it was logged.
 */

/**
 * Create the CONNECT handler bound to its collaborators.
 *
 * @param {MitmDeps} deps
 */
function createMitmHandler({
  configStore,
  router,
  upstream,
  resourceStore,
  addLog,
  entries,
  bodyRewriter,
  httpJson,
  httpFlow,
  webSocketProxy,
  bypassCounter,
  stats,
  breakpoints,
  touchLog
}) {
  const { createHttpFlowLogEntry, logWebSocketDirectTunnel, recordUpstreamErrorOnLog } = entries
  const { performUpstreamRequest, attachAbortOnClose } = upstream
  const { applyHeaderRewrites } = httpJson
  const { processRequestBodyWithRewrites, handleBufferedUpstreamResponseWithRewrites } =
    bodyRewriter
  const { handleDirectHttpFlow, hasApplicableRules } = httpFlow
  const { handleWebSocketUpgrade } = webSocketProxy

  /** @param {import('./upstream').UpstreamErrorParams} params */
  const handleUpstreamError = params =>
    handleUpstreamErrorWithRecorder(params, recordUpstreamErrorOnLog)

  /** CONNECT target per open client connection (see socketKey). */
  /** @type {Map<string, TunnelTarget>} */
  const tunnelTargets = new Map()

  /**
   * Raw client sockets of the open tunnels. They are detached from the HTTP
   * server by the CONNECT handshake, so `closeAllConnections()` does not
   * reach them: `close()` destroys them itself, otherwise `server.close()`
   * would wait for them forever.
   *
   * @type {Set<import('net').Socket>}
   */
  const tunnelSockets = new Set()

  /** @type {import('../util/lru').LruCache<string, import('tls').SecureContext>} */
  const secureContexts = createLruCache(SECURE_CONTEXT_CACHE_MAX)

  /** @type {import('https').Server|null} */
  let httpsServer = null

  /** Host whose certificate is the server's current default context. */
  /** @type {string|null} */
  let defaultContextHost = null

  /**
   * Secure context carrying the certificate of a host, built once per name.
   *
   * @param {string} hostname
   * @returns {import('tls').SecureContext}
   */
  function getSecureContext(hostname) {
    const cached = secureContexts.get(hostname)
    if (cached) return cached
    const cert = generateCertForHost(hostname, getCA())
    const context = tls.createSecureContext({ key: cert.key, cert: cert.cert })
    secureContexts.set(hostname, context)
    return context
  }

  /**
   * The shared HTTPS server, created on the first CONNECT so that building
   * the handler costs no key generation.
   *
   * @returns {import('https').Server}
   */
  function getHttpsServer() {
    if (!httpsServer) {
      httpsServer = https.createServer(
        {
          maxHeaderSize: 16384, // 16KB header limit (default is 8KB)
          SNICallback: (servername, cb) => {
            try {
              cb(null, getSecureContext(servername))
            } catch (error) {
              cb(/** @type {Error} */ (error))
            }
          }
        },
        handleDecryptedRequest
      )
      // With an `upgrade` listener in place Node hands WebSocket upgrades
      // over with their socket detached from the HTTP parser, which the `ws`
      // handshake needs.
      httpsServer.on('upgrade', handleDecryptedUpgrade)
      // A client that aborts its handshake is not an error of the proxy.
      httpsServer.on('tlsClientError', () => {})
    }
    return httpsServer
  }

  /**
   * Make the certificate of a host the default context of the shared server,
   * which is what a client that sends no SNI receives. The TLS socket of a
   * connection captures the default context when the socket is handed over,
   * so this is set right before `emit('connection')` and only when the host
   * differs from the previous tunnel.
   *
   * @param {import('https').Server} server
   * @param {string} hostname
   */
  function setDefaultContext(server, hostname) {
    if (defaultContextHost === hostname) return
    const cert = generateCertForHost(hostname, getCA())
    server.setSecureContext({ key: cert.key, cert: cert.cert })
    defaultContextHost = hostname
  }

  /**
   * Close the shared HTTPS server and its connections (no-op before the
   * first tunnel).
   *
   * @returns {Promise<void>}
   */
  async function close() {
    const server = httpsServer
    httpsServer = null
    defaultContextHost = null
    tunnelTargets.clear()
    for (const socket of tunnelSockets) {
      socket.destroy()
    }
    tunnelSockets.clear()
    if (!server) return
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    // The server never listened on its own, so close() only tears it down.
    await new Promise(resolve => server.close(() => resolve(undefined)))
  }

  /**
   * Handle a CONNECT request: raw tunnel for direct flows, TLS termination
   * with a per-host certificate and full processing otherwise.
   *
   * @param {import('http').IncomingMessage} req
   * @param {import('net').Socket} clientSocket
   * @param {Buffer} head
   * @returns {void}
   */
  function handleConnect(req, clientSocket, head) {
    const clientIp = clientSocket.remoteAddress
    /** @type {URL} */
    let targetUrl
    try {
      targetUrl = new URL(`http://${req.url}`)
    } catch (error) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      clientSocket.end()
      return
    }

    const targetHost = targetUrl.hostname
    const targetPort = targetUrl.port ? Number(targetUrl.port) : 443
    // Authority used in every URL built for this tunnel: the port is kept when
    // it is not the HTTPS default, otherwise upstream requests would go to 443.
    const targetAuthority = targetPort === 443 ? targetHost : `${targetHost}:${targetPort}`

    const routingContext = router.buildRoutingContext({
      requestUrl: '/',
      fullUrl: `https://${targetAuthority}`,
      host: targetHost,
      path: '/',
      targetUrl: `https://${targetAuthority}`,
      method: req.method
    })

    const httpHandling = router.decideHttpHandling(routingContext)

    if (httpHandling === 'direct') {
      bypassCounter.increment()

      if (configStore.interactiveModeEnabled) {
        const requestStart = Date.now()
        const fullUrl = `https://${targetAuthority}`
        const logEntry = createHttpFlowLogEntry({
          requestStart,
          method: /** @type {string} */ (req.method),
          url: '/',
          fullUrl,
          headers: req.headers,
          source: 'tunnel',
          clientIp
        })
        // Represent the raw CONNECT tunnel by its 200 Connection Established
        // handshake for auditing purposes.
        logEntry.statusCode = 200
        addLog(logEntry)
      }

      const targetSocket = createRawTunnel({
        clientSocket,
        targetHost,
        targetPort,
        head
      })

      targetSocket.on('error', (/** @type {NodeJS.ErrnoException} */ error) => {
        if (error && error.code === 'ECONNRESET') {
          return
        }
      })

      return
    }

    /** @type {TunnelTarget} */
    const target = { host: targetHost, port: targetPort, authority: targetAuthority }
    const key = socketKey(clientSocket)
    tunnelTargets.set(key, target)
    tunnelSockets.add(clientSocket)
    clientSocket.once('close', () => {
      tunnelSockets.delete(clientSocket)
      if (tunnelTargets.get(key) === target) {
        tunnelTargets.delete(key)
      }
    })

    const server = getHttpsServer()
    setDefaultContext(server, targetHost)

    // The HTTP server hands the socket over with half-open allowed (it needs
    // that for request bodies); for a TLS tunnel a client FIN means the
    // session is over, and a half-open raw socket would otherwise outlive
    // the TLS socket and keep the server's connection count up forever.
    clientSocket.allowHalfOpen = false

    // Tell client the tunnel is established
    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\nProxy-agent: Cascade-Proxy-MITM\r\n\r\n'
    )

    // Hand the client socket to the shared HTTPS server, which decrypts it
    server.emit('connection', clientSocket)
    if (head && head.length) {
      clientSocket.unshift(head)
    }
  }

  /**
   * One decrypted WebSocket upgrade of a tunnel (the `upgrade` event of the
   * shared HTTPS server): block (204), relay without rewrites or logging
   * (filter rules say direct) or proxy with rewrites and logging.
   *
   * @param {import('http').IncomingMessage} clientReq
   * @param {import('stream').Duplex} socket The decrypted (TLS) socket.
   * @param {Buffer} head
   * @returns {void}
   */
  function handleDecryptedUpgrade(clientReq, socket, head) {
    // The upgrade socket is the TLS socket of the tunnel, which shares its
    // remote endpoint with the raw socket the target was recorded for.
    const target = tunnelTargets.get(socketKey(/** @type {import('net').Socket} */ (socket)))
    if (!target) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
      return
    }
    // The proxy speaks no upgrade protocol but WebSocket: anything else
    // (e.g. `Upgrade: h2c`) is forwarded as an ordinary request.
    const upgradeHeader = String(clientReq.headers.upgrade || '')
      .trim()
      .toLowerCase()
    if (upgradeHeader !== 'websocket') {
      forwardUpgradeAsPlainRequest(clientReq, socket, head)
      return
    }

    const { host: targetHost, authority: targetAuthority } = target
    const requestUrl = /** @type {string} */ (clientReq.url)
    const fullUrl = `https://${targetAuthority}${requestUrl}`
    const method = /** @type {string} */ (clientReq.method)
    const parsedFullUrl = new URL(fullUrl)

    const wsRoutingContext = router.buildRoutingContext({
      requestUrl,
      fullUrl,
      host: targetHost,
      path: parsedFullUrl.pathname,
      targetUrl: fullUrl,
      method
    })
    const wsDecision = router.decideWebSocketHandling(wsRoutingContext)

    if (wsDecision.action === 'block') {
      socket.write('HTTP/1.1 204 No Content\r\n\r\n')
      socket.destroy()
      return
    }

    // Attach header so WebSocket handler can reuse resolved info
    clientReq.headers['x-target-url'] =
      clientReq.headers['x-target-url'] ||
      `${parsedFullUrl.protocol}//${parsedFullUrl.host}${parsedFullUrl.pathname || ''}`

    if (wsDecision.action === 'direct') {
      // In HTTPS MITM we cannot create a true raw tunnel here because TLS has
      // already been terminated. Approximate "direct" by disabling rewrites
      // and logging (bypass=true) while still using the MITM TLS tunnel.
      bypassCounter.increment()
      logWebSocketDirectTunnel({
        targetUrl: fullUrl,
        headers: clientReq.headers,
        suffix: ' (MITM bypass)'
      })

      handleWebSocketUpgrade(clientReq, socket, targetHost, fullUrl, { bypass: true, head })
      return
    }

    // WebSocket upgrade with full MITM (rewrites + logging)
    handleWebSocketUpgrade(clientReq, socket, targetHost, fullUrl, { bypass: false, head })
  }

  /**
   * A tunnel request that asks for an upgrade other than WebSocket reaches
   * the `upgrade` listener with its socket detached from the HTTP parser.
   * The proxy cannot speak that protocol, so the request is forwarded as an
   * ordinary one: the upgrade headers are dropped, a response object is
   * attached to the socket by hand and the connection is closed after the
   * answer, as Node does for a server without an `upgrade` listener.
   *
   * @param {import('http').IncomingMessage} clientReq
   * @param {import('stream').Duplex} socket The decrypted (TLS) socket.
   * @param {Buffer} head Bytes received after the headers: the request body, if any.
   * @returns {void}
   */
  function forwardUpgradeAsPlainRequest(clientReq, socket, head) {
    const requestStart = Date.now()
    // undici refuses upgrade/keep-alive headers and the h2c settings make no
    // sense without the upgrade.
    delete clientReq.headers.upgrade
    delete clientReq.headers['http2-settings']
    delete clientReq.headers['keep-alive']
    clientReq.headers.connection = 'close'

    const netSocket = /** @type {import('net').Socket} */ (socket)
    const res = new http.ServerResponse(clientReq)
    res.shouldKeepAlive = false
    res.assignSocket(netSocket)
    res.once('finish', () => {
      res.detachSocket(netSocket)
      netSocket.end()
    })

    processDecryptedRequest(
      clientReq,
      res,
      head && head.length ? head : Buffer.alloc(0),
      requestStart
    )
  }

  /**
   * One decrypted request of a tunnel: the same blocked / direct / local
   * resource / forward pipeline as plain HTTP (WebSocket upgrades arrive
   * through handleDecryptedUpgrade instead). Collects the body, then hands
   * over to processDecryptedRequest.
   *
   * @param {import('http').IncomingMessage} clientReq
   * @param {import('http').ServerResponse} clientRes
   * @returns {void}
   */
  function handleDecryptedRequest(clientReq, clientRes) {
    const requestStart = Date.now()

    // Collect request body
    /** @type {Buffer[]} */
    const chunks = []
    clientReq.on('data', chunk => chunks.push(chunk))
    clientReq.on('end', () => {
      processDecryptedRequest(clientReq, clientRes, Buffer.concat(chunks), requestStart)
    })
  }

  /**
   * The pipeline of one decrypted request once its body is available
   * (blocked / direct / local resource / forward, with rewrites and logging).
   *
   * @param {import('http').IncomingMessage} clientReq
   * @param {import('http').ServerResponse} clientRes
   * @param {Buffer} requestBody
   * @param {number} requestStart
   * @returns {Promise<void>}
   */
  async function processDecryptedRequest(clientReq, clientRes, requestBody, requestStart) {
    const target = tunnelTargets.get(socketKey(clientReq.socket))
    if (!target) {
      // Only reachable if a connection outlived its tunnel bookkeeping.
      clientRes.writeHead(502)
      clientRes.end('Unknown tunnel')
      return
    }
    const { host: targetHost, authority: targetAuthority } = target
    const requestUrl = /** @type {string} */ (clientReq.url)
    const fullUrl = `https://${targetAuthority}${requestUrl}`
    const method = /** @type {string} */ (clientReq.method)
    const clientIp =
      clientReq.socket?.remoteAddress || clientReq.connection?.remoteAddress || 'unknown'
    const parsedFullUrl = new URL(fullUrl)
    /** @type {Buffer} */
    let body = requestBody

    {
      const routingContext = router.buildRoutingContext({
        requestUrl,
        fullUrl,
        host: targetHost,
        path: parsedFullUrl.pathname,
        targetUrl: fullUrl,
        method
      })

      const httpHandling = router.decideHttpHandling(routingContext)

      if (httpHandling === 'direct') {
        // Direct flows buffer only when a rule can actually rewrite the
        // response; otherwise the body is piped through.
        const responseRulesApply =
          MITM_BYPASS_REWRITES_ENABLED &&
          hasApplicableRules({ requestUrl, fullUrl, phase: 'response' })

        await handleDirectHttpFlow({
          req: clientReq,
          res: clientRes,
          targetUrl: fullUrl,
          requestUrl,
          fullUrl,
          targetHost: targetAuthority,
          requestStart,
          clientIp,
          omitHeaders: OMIT_HEADERS_MITM,
          body: body.length > 0 ? body : undefined,
          applyRewrites: MITM_BYPASS_REWRITES_ENABLED,
          bufferResponse: responseRulesApply,
          handleHead: false
        })

        return
      }

      const hasLogging = configStore.interactiveModeEnabled === true

      // Log to UI (only build a detailed log entry when interactive mode is enabled)
      const logEntry = hasLogging
        ? createHttpFlowLogEntry({
            requestStart,
            method,
            url: requestUrl,
            fullUrl,
            headers: clientReq.headers,
            source: 'mitm',
            clientIp
          })
        : null

      // Blocked URLs are handled via decideHttpHandling; when the decision
      // is "block" we mirror the existing 204 behaviour while relying on the
      // shared decision logic used by HTTP/WS flows.
      if (httpHandling === 'block') {
        if (logEntry) {
          logEntry.source = 'blocked'
          logEntry.statusCode = 204
          addLog(logEntry)
        }

        clientRes.writeHead(204)
        clientRes.end()
        return
      }

      // The client's bytes are kept for a replay before any rule touches them.
      if (logEntry) retainRequestBody(logEntry, body, REPLAY_BODY_MAX_BYTES)

      if (body.length > 0) {
        const { buffer: rewrittenBody } = processRequestBodyWithRewrites({
          buffer: body,
          headers: clientReq.headers,
          requestUrl,
          fullUrl,
          logEntry,
          allowBodyRewriteFallback: true,
          logNonJsonBody: true
        })
        body = rewrittenBody
      }

      // Check for enabled local resource
      const localMatch = resourceStore.findMatching(requestUrl, fullUrl)

      if (localMatch) {
        const { url: matchedUrl, resource } = localMatch

        if (logEntry) {
          logEntry.source = 'local'
          logEntry.localResource = matchedUrl
          addLog(logEntry)
        }

        resourceStore.serveStream(clientRes, resource, {
          sourceTag: 'local',
          errorPrefix: '[proxy] Error streaming local resource (connect)'
        })
      } else {
        // Forward to real server
        const abortController = new AbortController()
        const onClose = attachAbortOnClose(clientRes, abortController)

        try {
          const upstreamStart = Date.now()

          const omitHeaders = OMIT_HEADERS_MITM
          let headersToForward = createForwardHeaders(clientReq.headers, omitHeaders, {
            host: targetAuthority
          })
          headersToForward = applyHeaderRewrites(
            headersToForward,
            { requestUrl, fullUrl, phase: 'request' },
            logEntry
          )

          if (body.length > 0) {
            // Body has already been rewritten (Connect/protobuf or fallback) by
            // applyConnectRewritesAndDecode earlier when we built the log entry.
            // We just need to set the correct Content-Length for the upstream request.
            headersToForward['content-length'] = body.length
          }

          let upstreamMethod = method
          let upstreamUrl = fullUrl

          // A request breakpoint holds the flow until the UI sends it on,
          // with its edits, or aborts it.
          const requestBreakpoint = breakpoints.match('request', { requestUrl, fullUrl })
          if (requestBreakpoint) {
            const resolution = await breakpoints.pause({
              phase: 'request',
              rule: requestBreakpoint,
              request: {
                method,
                url: fullUrl,
                headers: headersToForward,
                body: body.length > 0 ? body : null
              }
            })
            if (resolution.action === 'abort') {
              abortFlowAtBreakpoint({
                res: clientRes,
                logEntry,
                phase: 'request',
                alreadyLogged: false,
                addLog,
                touchLog
              })
              return
            }
            if (resolution.edited) {
              headersToForward = headersForTarget(
                resolution.request.headers,
                resolution.request.url,
                fullUrl
              )
              upstreamMethod = resolution.request.method
              upstreamUrl = resolution.request.url
              body = resolution.request.body || Buffer.alloc(0)
              if (body.length > 0) {
                headersToForward['content-length'] = body.length
              } else {
                delete headersToForward['content-length']
              }
            }
            recordBreakpointOnLog(logEntry, 'request', resolution.edited ? 'edited' : 'continued', {
              request: resolution.request
            })
          }

          const { response: upstreamResponse } = await performUpstreamRequest({
            url: upstreamUrl,
            method: upstreamMethod,
            headers: headersToForward,
            body: body.length > 0 ? body : undefined,
            abortSignal: abortController.signal,
            bufferResponse: false
          })

          if (logEntry) {
            logEntry.upstreamDurationMs = Date.now() - upstreamStart
          }

          // Parse and optionally rewrite response body before forwarding/logging.
          /** @type {Record<string, any>} */
          let upstreamHeaders = upstreamResponse.headers
          upstreamHeaders = applyHeaderRewrites(
            upstreamHeaders,
            { requestUrl, fullUrl, phase: 'response' },
            logEntry
          )

          // A response breakpoint needs the whole body: the response is then
          // buffered as for a rule.
          const responseBreakpoint = breakpoints.match('response', { requestUrl, fullUrl })

          // Stream when no rule can touch the body and nothing needs it for
          // logging; otherwise buffer it for rewrites and previews.
          const canStream =
            !responseBreakpoint &&
            upstreamResponse.body &&
            shouldStreamResponse({
              method: upstreamMethod,
              contentType: getContentType(upstreamHeaders),
              contentLength: getHeaderCaseInsensitive(upstreamHeaders, 'content-length'),
              hasRules: hasApplicableRules({ requestUrl, fullUrl, phase: 'response' }),
              interactive: configStore.interactiveModeEnabled === true
            })

          if (canStream) {
            if (logEntry) {
              logEntry.source = 'mitm'
              logEntry.targetUrl = fullUrl
              logEntry.statusCode = upstreamResponse.statusCode
              logEntry.responseHeaders = upstreamHeaders
              logEntry.responseBody = STREAMED_BODY_MARKER
              logEntry.responseSize = null
              addLog(logEntry)
            }

            const streamedHeaders = sanitizeAndStripIdentifyingHeaders(
              upstreamHeaders,
              OMIT_RESPONSE_HEADERS
            )
            applyCacheBypassHeadersToObject(streamedHeaders)
            clientRes.writeHead(upstreamResponse.statusCode, streamedHeaders)

            // Awaited so that the abort-on-close listener stays attached for
            // the whole transfer; the size is known only at the end.
            const { bytes } = await pipeUpstreamBody(upstreamResponse.body, clientRes)
            if (logEntry) {
              logEntry.responseSize = bytes
              stats.recordStreamedResponseSize(logEntry, bytes)
            }
            return
          }

          const responseBufferRaw = upstreamResponse.body
            ? Buffer.from(await upstreamResponse.body.arrayBuffer())
            : Buffer.alloc(0)

          const { finalResponseBuffer, upstreamHeaders: rewrittenHeaders } =
            handleBufferedUpstreamResponseWithRewrites({
              responseBuffer: responseBufferRaw,
              upstreamHeaders,
              requestUrl,
              jsonPathFullUrl: fullUrl,
              logEntry,
              source: 'mitm',
              targetUrlForLog: fullUrl,
              overrideFullUrlOnLog: false,
              allowUnaryConnectText: true,
              statusCode: upstreamResponse.statusCode,
              enableConnectFrameTextRewrites: true,
              frameRewriteFullUrl: fullUrl
            })

          let statusCode = upstreamResponse.statusCode
          /** @type {Record<string, any>} */
          let responseHeadersToSend = rewrittenHeaders
          let responseBodyToSend = finalResponseBuffer

          // A response breakpoint holds the rewritten response until the UI
          // sends it on, with its edits, or aborts it. The entry is already
          // logged, so an edit re-publishes it.
          if (responseBreakpoint) {
            const resolution = await breakpoints.pause({
              phase: 'response',
              rule: responseBreakpoint,
              request: {
                method: upstreamMethod,
                url: upstreamUrl,
                headers: headersToForward,
                body: body.length > 0 ? body : null
              },
              response: { statusCode, headers: rewrittenHeaders, body: finalResponseBuffer }
            })
            if (resolution.action === 'abort') {
              abortFlowAtBreakpoint({
                res: clientRes,
                logEntry,
                phase: 'response',
                alreadyLogged: true,
                addLog,
                touchLog
              })
              return
            }
            if (resolution.edited && resolution.response) {
              statusCode = resolution.response.statusCode
              responseHeadersToSend = resolution.response.headers
              responseBodyToSend = resolution.response.body || Buffer.alloc(0)
            }
            recordBreakpointOnLog(
              logEntry,
              'response',
              resolution.edited ? 'edited' : 'continued',
              {
                response: resolution.response || undefined
              }
            )
            if (logEntry) touchLog(logEntry)
          }

          // Forward response with cache-busting headers, dropping identifying
          // tracing headers for actively MITM-processed responses.
          const responseHeaders = sanitizeAndStripIdentifyingHeaders(
            responseHeadersToSend,
            OMIT_RESPONSE_HEADERS
          )
          applyCacheBypassHeadersToObject(responseHeaders)
          setContentLength(responseHeaders, responseBodyToSend)

          clientRes.writeHead(statusCode, responseHeaders)
          clientRes.end(responseBodyToSend)
        } catch (error) {
          handleUpstreamError({ logEntry, error: /** @type {Error} */ (error), res: clientRes })
        } finally {
          clientRes.removeListener('close', onClose)
        }
      }
    }
  }

  return { handleConnect, close }
}

/** @typedef {ReturnType<typeof createMitmHandler>} MitmHandler */

module.exports = { createMitmHandler }
