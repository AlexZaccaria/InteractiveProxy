'use strict'

/**
 * HTTPS interception: the `connect` handler of the HTTP server. A CONNECT
 * that the filter rules mark as direct is tunnelled verbatim; every other
 * tunnel is terminated with a certificate issued by the proxy's CA for the
 * requested host, and the decrypted requests go through the same local
 * resource / rewrite / forward / log pipeline as plain HTTP (WebSocket
 * upgrades included).
 *
 * One `https.Server` is created per tunnel; the shared server with a single
 * SNI callback is a later step of the plan.
 */

const https = require('https')
const tls = require('tls')
const { URL } = require('url')
const { MITM_BYPASS_REWRITES_ENABLED } = require('../../config')
const { getCA, generateCertForHost } = require('../tls/ca')
const { createRawTunnel } = require('./tunnel')
const {
  OMIT_HEADERS_MITM,
  OMIT_RESPONSE_HEADERS,
  createForwardHeaders,
  sanitizeAndStripIdentifyingHeaders,
  applyCacheBypassHeadersToObject
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
 * @property {Pick<HttpFlow, 'handleDirectHttpFlow'>} httpFlow
 * @property {Pick<WebSocketProxy, 'handleWebSocketUpgrade'>} webSocketProxy
 * @property {BypassCounter} bypassCounter
 */

/**
 * Create the CONNECT handler bound to its collaborators.
 *
 * @param {MitmDeps} deps
 */
function createMitmHandler ({
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
  bypassCounter
}) {
  const { createHttpFlowLogEntry, logWebSocketDirectTunnel, recordUpstreamErrorOnLog } = entries
  const { performUpstreamRequest, attachAbortOnClose } = upstream
  const { applyHeaderRewrites } = httpJson
  const { processRequestBodyWithRewrites, handleBufferedUpstreamResponseWithRewrites } = bodyRewriter
  const { handleDirectHttpFlow } = httpFlow
  const { handleWebSocketUpgrade } = webSocketProxy

  /** @param {import('./upstream').UpstreamErrorParams} params */
  const handleUpstreamError = params => handleUpstreamErrorWithRecorder(params, recordUpstreamErrorOnLog)

  /**
   * Handle a CONNECT request: raw tunnel for direct flows, TLS termination
   * with a per-host certificate and full processing otherwise.
   *
   * @param {import('http').IncomingMessage} req
   * @param {import('net').Socket} clientSocket
   * @param {Buffer} head
   * @returns {void}
   */
  function handleConnect (req, clientSocket, head) {
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

    // Generate certificate for this host
    const cert = generateCertForHost(targetHost, getCA())

    // Create HTTPS server for this connection
    /** @type {import('https').ServerOptions} */
    const httpsServerOptions = {
      key: cert.key,
      cert: cert.cert,
      maxHeaderSize: 16384, // 16KB header limit (default is 8KB)
      SNICallback: (servername, cb) => {
        const sniCert = generateCertForHost(servername, getCA())
        cb(null, tls.createSecureContext({
          key: sniCert.key,
          cert: sniCert.cert
        }))
      }
    }

    // Tell client the tunnel is established
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: Cascade-Proxy-MITM\r\n\r\n')

    // Create HTTPS server to decrypt client traffic
    const httpsServer = https.createServer(httpsServerOptions, async (clientReq, clientRes) => {
      const requestUrl = /** @type {string} */ (clientReq.url)
      const fullUrl = `https://${targetAuthority}${requestUrl}`
      const method = /** @type {string} */ (clientReq.method)
      const requestStart = Date.now()
      const clientIp = clientReq.socket?.remoteAddress || clientReq.connection?.remoteAddress || 'unknown'
      const parsedFullUrl = new URL(fullUrl)

      // Check if this is a WebSocket upgrade request
      if (clientReq.headers.upgrade && clientReq.headers.upgrade.toLowerCase() === 'websocket') {
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
          clientReq.socket.write('HTTP/1.1 204 No Content\r\n\r\n')
          clientReq.socket.destroy()
          return
        }

        // Attach header so WebSocket handler can reuse resolved info
        clientReq.headers['x-target-url'] = clientReq.headers['x-target-url'] ||
          `${parsedFullUrl.protocol}//${parsedFullUrl.host}${parsedFullUrl.pathname || ''}`

        if (wsDecision.action === 'direct') {
          // In HTTPS MITM we cannot create a true raw tunnel here because TLS has
          // already been terminated. Approximate "direct" by disabling rewrites
          // and logging (bypass=true) while still using the MITM TLS tunnel.
          bypassCounter.increment()
          logWebSocketDirectTunnel({ targetUrl: fullUrl, headers: clientReq.headers, suffix: ' (MITM bypass)' })

          handleWebSocketUpgrade(clientReq, clientReq.socket, targetHost, targetPort, fullUrl, { bypass: true })
          return
        }

        // WebSocket upgrade with full MITM (rewrites + logging)
        handleWebSocketUpgrade(clientReq, clientReq.socket, targetHost, targetPort, fullUrl, { bypass: false })
        return
      }

      // Collect request body
      /** @type {Buffer[]} */
      const chunks = []
      clientReq.on('data', chunk => chunks.push(chunk))
      clientReq.on('end', async () => {
        /** @type {Buffer} */
        let body = Buffer.concat(chunks)

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
            bufferResponse: MITM_BYPASS_REWRITES_ENABLED,
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
          return clientRes.end()
        }

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
            headersToForward = applyHeaderRewrites(headersToForward, { requestUrl, fullUrl, phase: 'request' }, logEntry)

            if (body.length > 0) {
              // Body has already been rewritten (Connect/protobuf or fallback) by
              // applyConnectRewritesAndDecode earlier when we built the log entry.
              // We just need to set the correct Content-Length for the upstream request.
              headersToForward['content-length'] = body.length
            }

            const { response: upstreamResponse, buffer: responseBufferRaw } = await performUpstreamRequest({
              url: fullUrl,
              method,
              headers: headersToForward,
              body: body.length > 0 ? body : undefined,
              abortSignal: abortController.signal,
              bufferResponse: true
            })

            if (logEntry) {
              logEntry.upstreamDurationMs = Date.now() - upstreamStart
            }

            // Parse and optionally rewrite response body before forwarding/logging.
            /** @type {Record<string, any>} */
            let upstreamHeaders = upstreamResponse.headers
            upstreamHeaders = applyHeaderRewrites(upstreamHeaders, { requestUrl, fullUrl, phase: 'response' }, logEntry)

            const {
              finalResponseBuffer,
              upstreamHeaders: rewrittenHeaders
            } = handleBufferedUpstreamResponseWithRewrites({
              // bufferResponse: true always yields a Buffer (empty when there is no body).
              responseBuffer: /** @type {Buffer} */ (responseBufferRaw),
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

            // Forward response with cache-busting headers, dropping identifying
            // tracing headers for actively MITM-processed responses.
            const responseHeaders = sanitizeAndStripIdentifyingHeaders(
              rewrittenHeaders,
              OMIT_RESPONSE_HEADERS
            )
            applyCacheBypassHeadersToObject(responseHeaders)

            clientRes.writeHead(upstreamResponse.statusCode, responseHeaders)
            clientRes.end(finalResponseBuffer)
          } catch (error) {
            handleUpstreamError({ logEntry, error: /** @type {Error} */ (error), res: clientRes })
          } finally {
            clientRes.removeListener('close', onClose)
          }
        }
      })
    })

    // Pipe the client socket to the HTTPS server
    httpsServer.emit('connection', clientSocket)
    if (head && head.length) {
      clientSocket.unshift(head)
    }
  }

  return { handleConnect }
}

/** @typedef {ReturnType<typeof createMitmHandler>} MitmHandler */

module.exports = { createMitmHandler }
