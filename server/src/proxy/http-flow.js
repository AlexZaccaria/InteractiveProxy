'use strict'

/**
 * HTTP forwarding flows of the proxy:
 *
 * - `tryHandleHttpBypass`: the first stop of every plain HTTP request; it
 *   answers blocked requests with 204 and forwards "direct" requests (filter
 *   rules in ignore/focus mode) without inspecting them;
 * - `handleProxiedHttpRequest`: the Express catch-all for everything else —
 *   local resources, rewrites, forwarding to the resolved target, logging;
 * - `handleDirectHttpFlow` / `forwardDirectHttp`: the shared direct/bypass
 *   mechanics, also used by the HTTPS MITM handler.
 *
 * The factory receives every collaborator (stores, rewriters, upstream, log
 * sink) so the module keeps no state of its own.
 */

const { URL } = require('url')
const { safeString } = require('../util/strings')
const { logDebug } = require('../util/logger')
const { REPLAY_BODY_MAX_BYTES } = require('../../config')
const { retainRequestBody } = require('../logs/replay')
const {
  recordBreakpointOnLog,
  abortAtBreakpoint: abortFlowAtBreakpoint,
  headersForTarget,
  toBodyBuffer
} = require('./breakpoints')
const { sleep, writeThrottled } = require('./throttle')
const { getContentType, getHeaderCaseInsensitive } = require('../codecs/compression')
const {
  STREAMED_BODY_MARKER,
  hasApplicableRules,
  shouldStreamResponse,
  pipeUpstreamBody
} = require('./streaming')
const {
  OMIT_HEADERS_BASE,
  OMIT_HEADERS_PROXY,
  OMIT_RESPONSE_HEADERS,
  createForwardHeaders,
  stripIdentifyingHeaders,
  sanitizeHeaders,
  sanitizeAndStripIdentifyingHeaders,
  applyCacheBypassHeadersToResponse,
  setContentLength
} = require('./headers')
const { handleUpstreamError: handleUpstreamErrorWithRecorder } = require('./upstream')

/** @typedef {import('../state/config-store').ConfigStore} ConfigStore */
/** @typedef {import('./router').Router} Router */
/** @typedef {import('./upstream').Upstream} Upstream */
/** @typedef {import('./upstream').UpstreamResponse} UpstreamResponse */
/** @typedef {import('../resources/store').ResourceStore} ResourceStore */
/** @typedef {import('../logs/entries').LogEntryFactory} LogEntryFactory */
/** @typedef {import('../logs/search').LogEntry} LogEntry */
/** @typedef {import('../rules/store').RuleStore} RuleStore */
/** @typedef {import('../api').BypassCounter} BypassCounter */
/** @typedef {ReturnType<typeof import('../rewrite/body').createBodyRewriter>} BodyRewriter */
/** @typedef {ReturnType<typeof import('../rewrite/http-json').createHttpJsonRewriter>} HttpJsonRewriter */
/** @typedef {ReturnType<typeof import('../rewrite/connect').createConnectRewriter>} ConnectRewriter */
/** @typedef {ReturnType<typeof import('../rules/text-rules').createTextRewriter>} TextRewriter */

/**
 * An Express request as seen by the proxy flow: the raw body captured by the
 * body parsers rides along as `rawBody`.
 *
 * @typedef {import('express').Request & { rawBody?: Buffer }} ProxyRequest
 */

/**
 * @typedef {object} HttpFlowDeps
 * @property {ConfigStore} configStore
 * @property {Router} router
 * @property {Upstream} upstream
 * @property {ResourceStore} resourceStore
 * @property {(entry: LogEntry) => void} addLog
 * @property {Pick<LogEntryFactory, 'createHttpFlowLogEntry' | 'recordUpstreamErrorOnLog'>} entries
 * @property {BodyRewriter} bodyRewriter
 * @property {HttpJsonRewriter} httpJson
 * @property {ConnectRewriter} connect
 * @property {TextRewriter} textRules
 * @property {RuleStore} ruleStore
 * @property {(logEntry: LogEntry | null | undefined, appliedRuleIds: string[], phase: string) => void} attachRewriteMetadata
 * @property {BypassCounter} bypassCounter
 * @property {Pick<import('../logs/stats').Stats, 'recordStreamedResponseSize'>} stats Receives the size of streamed responses once known.
 * @property {import('./breakpoints').BreakpointGate} breakpoints Pauses the flows that match a breakpoint rule.
 * @property {import('./throttle').NetworkConditionsMatcher} network Latency and bandwidth cap per URL.
 * @property {(entry: LogEntry) => void} touchLog Re-publishes an entry changed after it was logged.
 * @property {number} port Listening port, the default authority of client-facing URLs.
 */

/**
 * @typedef {object} TransformUpstreamArgs
 * @property {UpstreamResponse} upstreamResponse
 * @property {Record<string, any>} headers
 * @property {Buffer | null} buffer
 * @property {string} [requestUrl]
 * @property {string} [fullUrl]
 * @property {LogEntry | null | undefined} logEntry
 */

/**
 * @typedef {object} ForwardDirectHttpParams
 * @property {import('http').IncomingMessage} req
 * @property {import('http').ServerResponse} res
 * @property {string} url
 * @property {string} method
 * @property {Record<string, any>} headers
 * @property {AbortController} abortController
 * @property {boolean} [bufferResponse]
 * @property {Buffer | import('stream').Readable | undefined} [body]
 * @property {LogEntry | null} [logEntry]
 * @property {boolean} [handleHead]
 * @property {string} [bufferedLogMessage]
 * @property {string} [streamedLogMessage]
 * @property {string} [requestUrl]
 * @property {string} [fullUrl]
 * @property {(args: TransformUpstreamArgs) => Promise<{ headers?: Record<string, any>, buffer?: Buffer | null } | undefined | void>} [transformUpstream]
 */

/**
 * @typedef {object} DirectHttpFlowParams
 * @property {import('http').IncomingMessage} req
 * @property {import('http').ServerResponse} res
 * @property {string} targetUrl
 * @property {string} requestUrl
 * @property {string} fullUrl
 * @property {string} targetHost Authority (`host` or `host:port`) sent as the Host header.
 * @property {number} requestStart
 * @property {string} clientIp
 * @property {string[]} omitHeaders
 * @property {Buffer | import('stream').Readable | undefined} [body]
 * @property {boolean} [applyRewrites]
 * @property {boolean} [bufferResponse]
 * @property {boolean} [handleHead]
 */

/**
 * Create the HTTP flows bound to their collaborators.
 *
 * @param {HttpFlowDeps} deps
 */
function createHttpFlow({
  configStore,
  router,
  upstream,
  resourceStore,
  addLog,
  entries,
  bodyRewriter,
  httpJson,
  connect,
  textRules,
  ruleStore,
  attachRewriteMetadata,
  bypassCounter,
  stats,
  breakpoints,
  network,
  touchLog,
  port
}) {
  const { createHttpFlowLogEntry, recordUpstreamErrorOnLog } = entries

  /**
   * @param {import('http').ServerResponse} res
   * @param {LogEntry | null} logEntry
   * @param {'request' | 'response'} phase
   * @param {boolean} alreadyLogged
   */
  const abortAtBreakpoint = (res, logEntry, phase, alreadyLogged) =>
    abortFlowAtBreakpoint({ res, logEntry, phase, alreadyLogged, addLog, touchLog })
  const { performUpstreamRequest, attachAbortOnClose } = upstream
  const { applyHeaderRewrites } = httpJson
  const { applyConnectRewritesForBypass } = connect
  const { processRequestBodyWithRewrites, handleBufferedUpstreamResponseWithRewrites } =
    bodyRewriter

  /** @param {import('./upstream').UpstreamErrorParams} params */
  const handleUpstreamError = params =>
    handleUpstreamErrorWithRecorder(params, recordUpstreamErrorOnLog)

  /**
   * Shared helper for direct/bypass HTTP flows. Handles log entry creation,
   * bypass count increment, header forwarding, and upstream request.
   *
   * @param {DirectHttpFlowParams} params
   * @returns {Promise<void>}
   */
  async function handleDirectHttpFlow({
    req,
    res,
    targetUrl,
    requestUrl,
    fullUrl,
    targetHost,
    requestStart,
    clientIp,
    omitHeaders,
    body,
    applyRewrites = false,
    bufferResponse = false,
    handleHead = false
  }) {
    const method = /** @type {string} */ (req.method)
    const hasLogging = configStore.interactiveModeEnabled === true
    const logEntry = hasLogging
      ? createHttpFlowLogEntry({
          requestStart,
          method,
          url: requestUrl,
          fullUrl: targetUrl,
          headers: req.headers,
          source: 'direct',
          clientIp
        })
      : null

    bypassCounter.increment()

    let headersToForward = createForwardHeaders(req.headers, omitHeaders, {
      host: targetHost
    })

    if (applyRewrites) {
      headersToForward = stripIdentifyingHeaders(headersToForward)
      headersToForward = applyHeaderRewrites(
        headersToForward,
        { requestUrl, fullUrl, phase: 'request' },
        logEntry
      )
    }

    if (body && Buffer.isBuffer(body) && body.length > 0) {
      headersToForward['content-length'] = body.length
    }

    const transformUpstream = applyRewrites
      ? /** @param {TransformUpstreamArgs} args */ async ({ headers, buffer }) => {
          let upstreamHeaders = headers
          let responseBuffer = buffer

          if (responseBuffer) {
            upstreamHeaders = applyHeaderRewrites(
              upstreamHeaders,
              { requestUrl, fullUrl, phase: 'response' },
              logEntry
            )

            const connectResult = applyConnectRewritesForBypass(responseBuffer, upstreamHeaders, {
              requestUrl,
              fullUrl
            })
            responseBuffer = connectResult.buffer
          }

          return { headers: upstreamHeaders, buffer: responseBuffer }
        }
      : undefined

    const abortController = new AbortController()

    await forwardDirectHttp({
      req,
      res,
      url: targetUrl,
      method,
      headers: headersToForward,
      abortController,
      bufferResponse,
      body,
      logEntry,
      handleHead,
      bufferedLogMessage: '[bypass buffered response]',
      streamedLogMessage: '[streamed direct response]',
      requestUrl,
      fullUrl,
      transformUpstream
    })
  }

  /**
   * Try to handle an HTTP request using a direct upstream bypass when allowed
   * by the current block/bypass rules. Returns true if the request was fully
   * handled here.
   *
   * When a request is blocked we emit a "blocked" log entry. When it is
   * bypassed (handling === 'direct') we now emit a lightweight "direct"
   * log entry so redirected resources are visible in /api/logs and the
   * audit panel without changing the bypass behaviour itself.
   *
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @returns {Promise<boolean>}
   */
  async function tryHandleHttpBypass(req, res) {
    if (req.method === 'CONNECT') return false
    const connectionHeader = safeString(req.headers?.connection).toLowerCase()
    const wantsUpgrade = Boolean(req.headers?.upgrade) || connectionHeader.includes('upgrade')
    if (wantsUpgrade) return false

    const resolvedTarget = router.resolveTargetFromRequest(req)
    const routingContext = router.buildBypassInputFromHttpRequest(req, resolvedTarget)
    const handling = router.decideHttpHandling(routingContext)

    const requestStart = Date.now()
    const requestUrl = safeString(req.url) || '/'
    const hostHeader = safeString(req.headers?.host)
    const socket = /** @type {{ encrypted?: boolean } | undefined} */ (req.socket)
    const protocol = socket?.encrypted ? 'https' : 'http'
    const authority = hostHeader || `localhost:${port}`
    // Proxy-style requests carry an absolute request line already.
    const clientFacingUrl = /^https?:\/\//i.test(requestUrl)
      ? requestUrl
      : `${protocol}://${authority}${requestUrl}`
    const clientIp = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown'

    if (handling === 'block') {
      if (configStore.interactiveModeEnabled) {
        const logEntry = createHttpFlowLogEntry({
          requestStart,
          method: /** @type {string} */ (req.method),
          url: requestUrl,
          fullUrl: clientFacingUrl,
          headers: req.headers,
          source: 'blocked',
          clientIp
        })
        logEntry.statusCode = 204
        addLog(logEntry)
      }

      res.writeHead(204)
      res.end()
      return true
    }

    if (handling !== 'direct') {
      // Either blocked or proxied by the main Express pipeline.
      return false
    }

    const targetUrl = routingContext.targetUrl || routingContext.fullUrl

    if (!targetUrl) {
      res.writeHead(404)
      res.end('Bypass target unavailable')
      return true
    }

    const target = new URL(targetUrl)
    const hasBody = !(req.method === 'GET' || req.method === 'HEAD')

    await handleDirectHttpFlow({
      req,
      res,
      targetUrl,
      requestUrl,
      fullUrl: targetUrl,
      targetHost: target.host,
      requestStart,
      clientIp,
      omitHeaders: OMIT_HEADERS_BASE,
      body: hasBody ? req : undefined,
      applyRewrites: false,
      bufferResponse: false,
      handleHead: true
    })

    return true
  }

  /**
   * Forward an HTTP request directly to an upstream target using
   * performUpstreamRequest. Shared by plain HTTP bypass and HTTPS
   * MITM direct flows.
   *
   * This helper focuses on the forwarding/logging/streaming mechanics.
   * Callers are responsible for routing decisions and any header/body
   * rewrites performed before or after the call.
   *
   * For advanced scenarios (such as HTTPS MITM bypass rewrites), callers
   * can provide a transformUpstream hook that receives the upstream
   * response/headers/body and may return updated { headers, buffer }.
   *
   * @param {ForwardDirectHttpParams} params
   * @returns {Promise<{response: UpstreamResponse|null, buffer: Buffer|null}>}
   */
  async function forwardDirectHttp({
    req,
    res,
    url,
    method,
    headers,
    abortController,
    bufferResponse = false,
    body,
    logEntry,
    handleHead = false,
    bufferedLogMessage = '[bypass mitm buffered response]',
    streamedLogMessage = '[streamed direct response]',
    requestUrl,
    fullUrl,
    transformUpstream
  }) {
    const onClose = attachAbortOnClose(res, abortController)

    try {
      const upstreamStart = Date.now()

      const { response: upstreamResponse, buffer: responseBufferRaw } =
        await performUpstreamRequest({
          url,
          method,
          headers,
          body,
          abortSignal: abortController.signal,
          bufferResponse
        })

      /** @type {Record<string, any>} */
      let upstreamHeaders = upstreamResponse.headers
      let responseBuffer = responseBufferRaw

      if (typeof transformUpstream === 'function') {
        const transformed =
          (await transformUpstream({
            upstreamResponse,
            headers: upstreamHeaders,
            buffer: responseBuffer,
            requestUrl,
            fullUrl,
            logEntry
          })) || /** @type {{ headers?: Record<string, any>, buffer?: Buffer | null }} */ ({})

        if (transformed.headers) {
          upstreamHeaders = transformed.headers
        }
        if (Object.hasOwn(transformed, 'buffer')) {
          responseBuffer = transformed.buffer ?? null
        }
      }

      if (logEntry) {
        logEntry.upstreamDurationMs = Date.now() - upstreamStart
        logEntry.targetUrl = url
        logEntry.statusCode = upstreamResponse.statusCode
        logEntry.responseHeaders = upstreamHeaders
        if (bufferResponse && responseBuffer && Buffer.isBuffer(responseBuffer)) {
          logEntry.responseBody = bufferedLogMessage
          logEntry.responseSize = responseBuffer.length
        } else {
          logEntry.responseBody = streamedLogMessage
          logEntry.responseSize = null
        }
        addLog(logEntry)
      }

      const filteredHeaders = sanitizeHeaders(upstreamHeaders, OMIT_RESPONSE_HEADERS)
      if (bufferResponse && responseBuffer && Buffer.isBuffer(responseBuffer)) {
        setContentLength(filteredHeaders, responseBuffer)
      }
      res.writeHead(upstreamResponse.statusCode, filteredHeaders)

      if (
        bufferResponse &&
        responseBuffer &&
        Buffer.isBuffer(responseBuffer) &&
        responseBuffer.length > 0
      ) {
        res.end(responseBuffer)
      } else if (handleHead && req.method === 'HEAD') {
        res.end()
        if (upstreamResponse.body) {
          upstreamResponse.body.resume()
        }
      } else if (upstreamResponse.body) {
        upstreamResponse.body.pipe(res)
      } else {
        res.end()
      }

      return { response: upstreamResponse, buffer: responseBuffer }
    } catch (error) {
      handleUpstreamError({
        logEntry,
        error: /** @type {Error} */ (error),
        res,
        message: 'Bypass proxy error'
      })
      return { response: null, buffer: null }
    } finally {
      res.removeListener('close', onClose)
    }
  }

  /**
   * Proxy flow for every request that is not a call to the management API:
   * local resources, forwarding to the resolved target and logging. Also used
   * by the proxy-targeted guard for traffic addressed to other hosts.
   *
   * @param {ProxyRequest} req
   * @param {import('express').Response} res
   * @returns {Promise<void>}
   */
  async function handleProxiedHttpRequest(req, res) {
    const requestUrl = req.originalUrl
    // Proxy-style requests carry an absolute request line already.
    const fullUrl = /^https?:\/\//i.test(requestUrl)
      ? requestUrl
      : req.protocol + '://' + req.get('host') + requestUrl
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown'
    const requestStart = Date.now()

    const hasLogging = configStore.interactiveModeEnabled === true

    // Log the request (only build a detailed log entry when interactive mode is enabled)
    const logEntry = hasLogging
      ? createHttpFlowLogEntry({
          requestStart,
          method: req.method,
          url: requestUrl,
          fullUrl,
          headers: req.headers,
          source: 'unknown',
          clientIp
        })
      : null

    // The client's bytes are kept for a replay before any rule touches them.
    if (logEntry && req.rawBody) retainRequestBody(logEntry, req.rawBody, REPLAY_BODY_MAX_BYTES)

    if (req.rawBody) {
      const { buffer: rewrittenBuffer } = processRequestBodyWithRewrites({
        buffer: req.rawBody,
        headers: req.headers,
        requestUrl,
        fullUrl,
        logEntry,
        allowBodyRewriteFallback: false,
        logNonJsonBody: false
      })
      req.rawBody = rewrittenBuffer
    } else if (req.body !== undefined) {
      if (logEntry) {
        logEntry.body = req.body
      }
    }

    // Check if we have an enabled local resource for this URL
    const localMatch = resourceStore.findMatching(requestUrl, fullUrl)

    if (localMatch) {
      const { url: matchedUrl, resource } = localMatch

      if (logEntry) {
        logEntry.source = 'local'
        logEntry.localResource = matchedUrl
        logEntry.statusCode = typeof resource.status === 'number' ? resource.status : 200
        addLog(logEntry)
      }

      resourceStore.serveStream(res, resource, {
        sourceTag: 'local',
        errorPrefix: '[proxy] Error streaming local resource'
      })
    } else {
      // Resolve target URL/host using the same logic as the bypass/upgrade flows.
      const resolvedTarget = router.resolveTargetFromRequest(req)
      const resolvedTargetUrl = resolvedTarget ? resolvedTarget.url : null

      if (resolvedTargetUrl) {
        const abortController = new AbortController()
        const onClose = attachAbortOnClose(res, abortController)

        try {
          const upstreamStart = Date.now()

          const target = new URL(resolvedTargetUrl)
          const omitHeaders = OMIT_HEADERS_PROXY
          let headersToForward = createForwardHeaders(req.headers, omitHeaders, {
            host: target.host,
            connection: 'close'
          })

          // Actively proxied HTTP requests drop identifying tracing headers
          // before any further header rewrites are applied.
          headersToForward = stripIdentifyingHeaders(headersToForward)
          headersToForward = applyHeaderRewrites(
            headersToForward,
            { requestUrl, fullUrl, phase: 'request' },
            logEntry
          )

          /** @type {Buffer | string | undefined} */
          let body
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
              // req.rawBody has already been rewritten by applyConnectFrameRewrites above
              // Just use it directly for forwarding
              body = req.rawBody

              headersToForward['content-length'] = body.length
            } else if (req.body !== undefined) {
              const isJson = getContentType(headersToForward).includes('application/json')
              const rawBodyString =
                isJson && typeof req.body !== 'string' ? JSON.stringify(req.body) : req.body
              const textBody = safeString(rawBodyString)
              const rewriteResult = textRules.applyEditRulesToText(textBody, {
                requestUrl,
                fullUrl,
                phase: 'request'
              })
              body = rewriteResult.changed ? rewriteResult.text : rawBodyString
              if (rewriteResult.changed) {
                attachRewriteMetadata(logEntry, rewriteResult.appliedRuleIds, 'request')
              }
              if (typeof body === 'string') {
                headersToForward['content-length'] = Buffer.byteLength(body)
              }
            }
          }

          let method = req.method
          let targetUrl = resolvedTargetUrl

          // A request breakpoint holds the flow until the UI sends it on,
          // with its edits, or aborts it.
          const requestBreakpoint = breakpoints.match('request', {
            requestUrl,
            fullUrl: targetUrl
          })
          if (requestBreakpoint) {
            const resolution = await breakpoints.pause({
              phase: 'request',
              rule: requestBreakpoint,
              request: {
                method,
                url: targetUrl,
                headers: headersToForward,
                body: toBodyBuffer(body)
              }
            })
            if (resolution.action === 'abort') {
              abortAtBreakpoint(res, logEntry, 'request', false)
              return
            }
            if (resolution.edited) {
              headersToForward = headersForTarget(
                resolution.request.headers,
                resolution.request.url,
                targetUrl
              )
              method = resolution.request.method
              targetUrl = resolution.request.url
              body = resolution.request.body || undefined
              if (Buffer.isBuffer(body)) {
                headersToForward['content-length'] = body.length
              } else {
                delete headersToForward['content-length']
              }
            }
            recordBreakpointOnLog(logEntry, 'request', resolution.edited ? 'edited' : 'continued', {
              request: resolution.request
            })
          }

          // Network conditions: a latency before the upstream request and a
          // bandwidth cap on the response.
          const conditions = network.match({ requestUrl, fullUrl: targetUrl })
          const bytesPerSecond = conditions ? conditions.bytesPerSecond : 0
          if (conditions) {
            if (logEntry) logEntry.network = conditions.summary
            if (conditions.delayMs > 0) await sleep(conditions.delayMs)
          }

          const { response: upstreamResponse } = await performUpstreamRequest({
            url: targetUrl,
            method,
            headers: headersToForward,
            body,
            abortSignal: abortController.signal,
            bufferResponse: false
          })

          if (logEntry) {
            logEntry.upstreamDurationMs = Date.now() - upstreamStart
          }

          /** @type {Record<string, any>} */
          let upstreamHeaders = upstreamResponse.headers
          upstreamHeaders = applyHeaderRewrites(
            upstreamHeaders,
            { requestUrl, fullUrl, phase: 'response' },
            logEntry
          )

          // A response breakpoint needs the whole body: the response is then
          // buffered as for a rule.
          const responseBreakpoint = breakpoints.match('response', {
            requestUrl,
            fullUrl: targetUrl
          })

          // Stream when no rule can touch the body and nothing needs it for
          // logging; otherwise buffer it for rewrites and previews.
          const canStream =
            !responseBreakpoint &&
            upstreamResponse.body &&
            shouldStreamResponse({
              method,
              contentType: getContentType(upstreamHeaders),
              contentLength: getHeaderCaseInsensitive(upstreamHeaders, 'content-length'),
              hasRules: hasApplicableRules(ruleStore, {
                requestUrl,
                fullUrl: targetUrl,
                phase: 'response'
              }),
              interactive: configStore.interactiveModeEnabled === true
            })

          if (canStream) {
            if (logEntry) {
              logEntry.source = 'proxied'
              logEntry.targetUrl = targetUrl
              logEntry.fullUrl = targetUrl // Use target URL instead of proxy URL
              logEntry.statusCode = upstreamResponse.statusCode
              logEntry.responseHeaders = upstreamHeaders
              logEntry.responseBody = STREAMED_BODY_MARKER
              logEntry.responseSize = null
              addLog(logEntry)
            }

            const forwardedResponseHeaders = sanitizeAndStripIdentifyingHeaders(
              upstreamHeaders,
              OMIT_RESPONSE_HEADERS
            )
            Object.entries(forwardedResponseHeaders).forEach(([key, value]) => {
              // sanitizeHeaders never keeps undefined values; the guard only narrows the type.
              if (value !== undefined) res.setHeader(key, value)
            })

            applyCacheBypassHeadersToResponse(res, 'remote')

            res.status(upstreamResponse.statusCode)
            // Awaited so that the abort-on-close listener stays attached for
            // the whole transfer; the size is known only at the end.
            const { bytes } = await pipeUpstreamBody(upstreamResponse.body, res, {
              bytesPerSecond
            })
            if (logEntry) {
              logEntry.responseSize = bytes
              stats.recordStreamedResponseSize(logEntry, bytes)
            }
            return
          }
          const responseBuffer = upstreamResponse.body
            ? Buffer.from(await upstreamResponse.body.arrayBuffer())
            : Buffer.alloc(0)

          const { finalResponseBuffer, upstreamHeaders: rewrittenHeaders } =
            handleBufferedUpstreamResponseWithRewrites({
              responseBuffer,
              upstreamHeaders,
              requestUrl,
              jsonPathFullUrl: targetUrl,
              logEntry,
              source: 'proxied',
              targetUrlForLog: targetUrl,
              overrideFullUrlOnLog: true,
              allowUnaryConnectText: false,
              statusCode: upstreamResponse.statusCode,
              enableConnectFrameTextRewrites: false
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
                method,
                url: targetUrl,
                headers: headersToForward,
                body: toBodyBuffer(body)
              },
              response: { statusCode, headers: rewrittenHeaders, body: finalResponseBuffer }
            })
            if (resolution.action === 'abort') {
              abortAtBreakpoint(res, logEntry, 'response', true)
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

          res.status(statusCode)

          const forwardedResponseHeaders = sanitizeAndStripIdentifyingHeaders(
            responseHeadersToSend,
            OMIT_RESPONSE_HEADERS
          )
          Object.entries(forwardedResponseHeaders).forEach(([key, value]) => {
            // sanitizeHeaders never keeps undefined values; the guard only narrows the type.
            if (value !== undefined) res.setHeader(key, value)
          })

          applyCacheBypassHeadersToResponse(res, 'remote')

          if (method === 'HEAD') {
            res.end()
          } else if (bytesPerSecond > 0) {
            await writeThrottled(res, responseBodyToSend, bytesPerSecond)
          } else {
            res.send(responseBodyToSend)
          }
        } catch (error) {
          handleUpstreamError({ logEntry, error: /** @type {Error} */ (error), res, useJson: true })
        } finally {
          res.removeListener('close', onClose)
        }
      } else {
        // No local resource and no target: the request is addressed to the
        // proxy itself (a UI asset that does not exist, a stray favicon) and
        // is not traffic to show in the log.
        logDebug('http-flow', `No target for own-origin request ${req.method} ${requestUrl}`)

        res.status(404).json({
          error: 'No local resource found and no target URL specified',
          hint: 'Add X-Target-URL header with the destination URL or configure a local resource'
        })
      }
    }
  }

  return {
    handleProxiedHttpRequest,
    tryHandleHttpBypass,
    handleDirectHttpFlow,
    forwardDirectHttp,
    /**
     * Whether a text or JSONPath rule can apply to the body of a URL in a
     * phase (shared with the MITM handler for its streaming decision).
     *
     * @param {{ requestUrl?: string, fullUrl?: string, phase: 'request' | 'response' }} context
     * @returns {boolean}
     */
    hasApplicableRules: context => hasApplicableRules(ruleStore, context)
  }
}

/** @typedef {ReturnType<typeof createHttpFlow>} HttpFlow */

module.exports = { createHttpFlow }
