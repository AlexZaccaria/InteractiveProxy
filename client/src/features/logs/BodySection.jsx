import { useState } from 'react'
import Spinner from '../../components/Spinner'
import { ConnectTimelines, buildConnectReadablePreview } from './ConnectFrames'
import { JsonBeforeAfter, JsonPanel } from './JsonTree'
import { WsMessagePreview } from './WsMessages'
import { useEffectiveLog } from './useLogDetail'

/**
 * The collapsible body sections of a card. Everything heavy (the detail
 * request, the JSON trees, the HTML preview, the Connect timelines) exists
 * only while a section is open.
 */

/** @typedef {import('../../lib/types').LogDetail} LogDetail */
/** @typedef {(seed: import('./jsonPath').JsonPathRuleSeed) => void} RuleSeedHandler */

const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.avif',
  '.tiff'
]

/**
 * The raw preview and the Base64 of a body, each behind its own toggle.
 *
 * @param {Object} props
 * @param {string} props.title
 * @param {string | null | undefined} props.preview
 * @param {string | null | undefined} props.base64
 * @param {boolean} [props.collapsePreview] Start with the preview closed.
 */
export function RawDataSection({ title, preview, base64, collapsePreview = false }) {
  const [previewOpen, setPreviewOpen] = useState(!collapsePreview && !!preview)
  const [base64Open, setBase64Open] = useState(false)

  if (!preview && !base64) return null

  return (
    <div className="mt-3 space-y-2">
      <div className="text-xs font-semibold text-slate-400">{title}</div>
      {preview && (
        <details
          className="bg-[#0f0f0f] rounded border border-[#2a2a2a] overflow-hidden"
          open={previewOpen}
          onToggle={event => {
            if (event.currentTarget !== event.target) return
            setPreviewOpen(event.currentTarget.open)
          }}
        >
          <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
            {previewOpen ? 'Hide raw preview' : `Show raw preview (${preview.length} characters)`}
          </summary>
          {previewOpen && (
            <pre className="px-3 pb-3 text-xs text-slate-200 overflow-x-auto max-h-60 whitespace-pre-wrap">
              {preview}
            </pre>
          )}
        </details>
      )}
      {base64 && (
        <details
          className="bg-[#0f0f0f] rounded border border-[#2a2a2a] overflow-hidden"
          open={base64Open}
          onToggle={event => {
            if (event.currentTarget !== event.target) return
            setBase64Open(event.currentTarget.open)
          }}
        >
          <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
            {base64Open ? 'Hide Base64' : `Show Base64 (${Math.round(base64.length / 4)} bytes)`}
          </summary>
          {base64Open && (
            <pre className="px-3 pb-3 text-xs text-slate-300 break-all whitespace-pre-wrap">
              {base64}
            </pre>
          )}
        </details>
      )}
    </div>
  )
}

/** @param {{ label: string }} props */
function BodyLoading({ label }) {
  return (
    <div className="mt-2 flex items-center justify-center py-4">
      <div className="inline-flex items-center gap-2 text-xs text-slate-400">
        <Spinner size="sm" color="blue" />
        <span>{label}</span>
      </div>
    </div>
  )
}

/**
 * A collapsible section; its content is mounted only while open.
 *
 * @param {Object} props
 * @param {string} props.label
 * @param {boolean} props.isOpen
 * @param {(open: boolean) => void} props.onOpenChange
 * @param {import('react').ReactNode} props.children
 */
function CollapsibleBody({ label, isOpen, onOpenChange, children }) {
  return (
    <details
      className="mt-3 bg-[#050505] border border-[#2a2a2a] rounded"
      open={isOpen}
      onToggle={event => {
        if (event.currentTarget !== event.target) return
        onOpenChange(event.currentTarget.open)
      }}
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-300 hover:text-slate-100">
        {label}
      </summary>
      {isOpen && <div className="px-3 pb-3">{children}</div>}
    </details>
  )
}

/**
 * The size of a response next to the section title.
 *
 * @param {{ bytes: number | undefined }} props
 */
function ResponseSize({ bytes }) {
  if (!bytes) return null
  return <span className="ml-2 text-xs text-slate-500">({(bytes / 1024).toFixed(2)} KB)</span>
}

/**
 * The request body of an HTTP entry: the JSON view (after and before the
 * rules when any applied), the Connect timelines, or the text, plus the raw
 * preview. WebSocket entries have no request body here; their payload is
 * the message section.
 *
 * @param {{ log: import('../../lib/types').LogSummary, onCreateJsonPathRule?: RuleSeedHandler }} props
 */
export function RequestBodySection({ log, onCreateJsonPathRule }) {
  const [isOpen, setIsOpen] = useState(false)
  const { effectiveLog, isLoading, error } = useEffectiveLog(log, isOpen)
  /** @type {LogDetail} */
  const detail = effectiveLog

  const isWebSocket = detail.source === 'websocket'
  const hasConnectRequest =
    !isWebSocket && Boolean(detail.connectRequest?.frames && detail.connectRequest.frames.length)
  const hasStandardBody =
    !isWebSocket &&
    Boolean(detail.body) &&
    (typeof detail.body === 'string'
      ? detail.body.trim().length > 0
      : typeof detail.body === 'object' && Object.keys(detail.body).length > 0)

  const hasAnyRequestBodyInfo =
    !isWebSocket &&
    ((typeof detail.requestBytes === 'number' && detail.requestBytes > 0) ||
      !!detail.requestBodySummary ||
      !!detail.connectSummary)

  const collapseRaw =
    hasConnectRequest ||
    hasStandardBody ||
    Boolean(
      typeof detail.body === 'string' &&
      detail.rawRequestBodyPreview &&
      detail.rawRequestBodyPreview.trim() === detail.body.trim()
    )

  const rawRequestPreview = hasConnectRequest
    ? buildConnectReadablePreview(detail.connectRequest)
    : isWebSocket
      ? null
      : detail.rawRequestBodyPreview
  const rawRequestBase64 = isWebSocket ? null : detail.rawRequestBodyBase64
  const hasRawRequest = Boolean(rawRequestPreview || rawRequestBase64)

  if (!hasAnyRequestBodyInfo && !hasConnectRequest && !hasStandardBody && !hasRawRequest) {
    return null
  }

  const rawRequestSection = hasRawRequest ? (
    <RawDataSection
      title="Raw Request Body"
      preview={rawRequestPreview}
      base64={rawRequestBase64}
      collapsePreview={collapseRaw}
    />
  ) : null

  let content = null
  if (isOpen) {
    const noStructuredData = !detail.requestBodyJson && !detail.body && !detail.connectRequest
    if (isLoading && noStructuredData) {
      content = <BodyLoading label="Loading request body…" />
    } else if (error && noStructuredData) {
      content = (
        <div className="mt-2 text-xs text-red-400">
          Failed to load request body details: {error}
        </div>
      )
    } else {
      let standardContent = null
      if (!hasConnectRequest && hasStandardBody) {
        const requestJson =
          detail.requestBodyJson && typeof detail.requestBodyJson === 'object'
            ? detail.requestBodyJson
            : typeof detail.body === 'object' && detail.body !== null
              ? detail.body
              : null

        if (requestJson) {
          const hasBeforeJson =
            detail.requestBodyJsonBefore && typeof detail.requestBodyJsonBefore === 'object'
          const hasRewrites = Array.isArray(detail.rewrites) && detail.rewrites.length > 0
          const urlPattern = detail.fullUrl || detail.url || ''

          standardContent =
            hasBeforeJson && hasRewrites ? (
              <JsonBeforeAfter
                after={requestJson}
                before={detail.requestBodyJsonBefore}
                contextLabel="Request JSON body"
                urlPattern={urlPattern}
                target="request"
                onCreateJsonPathRule={onCreateJsonPathRule}
              />
            ) : (
              <div className="text-xs text-slate-200">
                <JsonPanel
                  data={requestJson}
                  contextLabel="Request JSON body"
                  urlPattern={urlPattern}
                  target="request"
                  onCreateJsonPathRule={onCreateJsonPathRule}
                />
              </div>
            )
        } else {
          standardContent = (
            <pre className="bg-slate-950 p-3 rounded text-xs text-slate-300 overflow-x-auto max-h-60">
              {String(detail.body ?? '')}
            </pre>
          )
        }
      }

      content = (
        <div className="mt-2">
          {detail.requestBodySummary && (
            <div className="text-xs text-slate-400 mb-2">{detail.requestBodySummary}</div>
          )}
          {hasConnectRequest ? (
            <>
              <ConnectTimelines
                connectData={detail.connectRequest}
                phase="request"
                log={detail}
                onCreateJsonPathRule={onCreateJsonPathRule}
              />
              {rawRequestSection}
            </>
          ) : hasStandardBody ? (
            <>
              {standardContent}
              {rawRequestSection}
            </>
          ) : (
            rawRequestSection || <div className="text-xs text-slate-500">No body captured.</div>
          )}
        </div>
      )
    }
  }

  return (
    <CollapsibleBody label="Request Body" isOpen={isOpen} onOpenChange={setIsOpen}>
      {content}
    </CollapsibleBody>
  )
}

/**
 * The preview of an HTTP response body: the image, the JSON view (after
 * and before the rules when any applied), the HTML in a sandboxed frame
 * with its source, or the text.
 *
 * @param {{ effectiveLog: LogDetail, bodyToShow: string, onCreateJsonPathRule?: RuleSeedHandler }} props
 */
function HttpResponsePreview({ effectiveLog, bodyToShow, onCreateJsonPathRule }) {
  const contentType = effectiveLog.responseHeaders?.['content-type'] || ''
  const contentTypeText = Array.isArray(contentType) ? contentType.join(', ') : String(contentType)
  const url = (effectiveLog.fullUrl || effectiveLog.url || '').toLowerCase()
  const trimmedBody = bodyToShow.trim()
  const isBinary = bodyToShow.includes('[Binary')

  const isImage =
    contentTypeText.includes('image/') || IMAGE_EXTENSIONS.some(ext => url.endsWith(ext))

  if (isImage) {
    const href = effectiveLog.fullUrl || effectiveLog.url
    return (
      <div className="bg-slate-950 p-3 rounded">
        {isBinary ? (
          <>
            <img
              src={href}
              alt="Response preview"
              className="max-w-full max-h-96 rounded border border-slate-700"
              onError={event => {
                event.currentTarget.style.display = 'none'
                const fallback = event.currentTarget.nextSibling
                if (fallback instanceof HTMLElement) fallback.style.display = 'block'
              }}
            />
            <div style={{ display: 'none' }} className="text-slate-500 text-sm">
              Unable to load image. Try opening it in a new tab:
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline ml-1"
              >
                {href}
              </a>
            </div>
          </>
        ) : (
          <div className="text-slate-500 text-sm">
            Image detected but body is not available.
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline ml-1"
            >
              Open in new tab
            </a>
          </div>
        )}
      </div>
    )
  }

  // The server provides the JSON view; the client never parses bodies.
  const jsonData =
    effectiveLog.responseBodyJson && typeof effectiveLog.responseBodyJson === 'object'
      ? effectiveLog.responseBodyJson
      : typeof effectiveLog.responseBody === 'object' && effectiveLog.responseBody !== null
        ? effectiveLog.responseBody
        : null

  if (jsonData && !isBinary) {
    const hasRewrites = Array.isArray(effectiveLog.rewrites) && effectiveLog.rewrites.length > 0
    const urlPattern = effectiveLog.fullUrl || effectiveLog.url || ''

    if (
      hasRewrites &&
      effectiveLog.responseBodyJsonBefore &&
      typeof effectiveLog.responseBodyJsonBefore === 'object'
    ) {
      return (
        <JsonBeforeAfter
          after={jsonData}
          before={effectiveLog.responseBodyJsonBefore}
          contextLabel="Response JSON body"
          urlPattern={urlPattern}
          target="response"
          onCreateJsonPathRule={onCreateJsonPathRule}
        />
      )
    }

    return (
      <div className="text-xs text-slate-200">
        <JsonPanel
          data={jsonData}
          contextLabel="Response JSON body"
          urlPattern={urlPattern}
          target="response"
          onCreateJsonPathRule={onCreateJsonPathRule}
        />
      </div>
    )
  }

  const isHTML =
    contentTypeText.includes('html') ||
    trimmedBody.startsWith('<!DOCTYPE') ||
    trimmedBody.startsWith('<html')

  if (isHTML && !isBinary) {
    return (
      <div className="space-y-2">
        <div className="bg-slate-950 border border-slate-700 rounded p-3 max-h-96 overflow-auto">
          <iframe
            srcDoc={bodyToShow}
            className="w-full h-96 bg-white rounded"
            sandbox="allow-same-origin"
            title="HTML Preview"
          />
        </div>
        <details className="bg-slate-950 rounded">
          <summary className="cursor-pointer p-3 text-xs text-slate-400 hover:text-slate-300">
            Show HTML source
          </summary>
          <pre className="p-3 text-xs text-slate-300 overflow-x-auto max-h-60 border-t border-slate-800">
            {bodyToShow}
          </pre>
        </details>
      </div>
    )
  }

  return (
    <pre className="bg-[#0f0f0f] border border-[#2a2a2a] p-3 rounded text-xs text-slate-300 overflow-x-auto max-h-96">
      {bodyToShow || 'No content available'}
    </pre>
  )
}

/**
 * The response body of an HTTP entry or the message of a WebSocket entry,
 * plus the raw preview.
 *
 * @param {{ log: import('../../lib/types').LogSummary, onCreateJsonPathRule?: RuleSeedHandler }} props
 */
export function ResponseBodySection({ log, onCreateJsonPathRule }) {
  const [isOpen, setIsOpen] = useState(false)
  const { effectiveLog, isLoading, error } = useEffectiveLog(log, isOpen)
  /** @type {LogDetail} */
  const detail = effectiveLog

  const isWebSocket = detail.source === 'websocket'
  const hasConnectResponse =
    Boolean(detail.connectResponse?.frames && detail.connectResponse.frames.length) ||
    Array.isArray(detail.responseBody)

  const hasAnyResponseBodyInfo =
    (typeof detail.responseBytes === 'number' && detail.responseBytes > 0) ||
    !!detail.responseBodySummary ||
    !!detail.connectSummary ||
    (!!detail.wsSummary && typeof detail.wsSummary === 'object')

  const bodyStringCandidate =
    typeof detail.responseBody === 'string'
      ? detail.responseBody
      : isWebSocket && detail.body && typeof detail.body === 'string'
        ? detail.body
        : ''

  const collapseRaw = Boolean(
    hasConnectResponse ||
    detail.responseBody ||
    (bodyStringCandidate &&
      detail.rawResponseBodyPreview &&
      detail.rawResponseBodyPreview.trim() === bodyStringCandidate.trim()) ||
    (!hasConnectResponse &&
      !detail.responseBody &&
      detail.rawResponseBodyPreview &&
      detail.rawResponseBodyPreview.length > 2000) ||
    (isWebSocket && bodyStringCandidate && bodyStringCandidate.length > 2000)
  )

  const rawResponsePreview = hasConnectResponse
    ? buildConnectReadablePreview(detail.connectResponse)
    : isWebSocket
      ? bodyStringCandidate || (detail.body != null ? String(detail.body) : '')
      : detail.rawResponseBodyPreview
  const rawResponseBase64 = isWebSocket ? null : detail.rawResponseBodyBase64
  const hasRawResponse = Boolean(rawResponsePreview || rawResponseBase64)

  if (
    !hasAnyResponseBodyInfo &&
    !hasConnectResponse &&
    !detail.responseBody &&
    !isWebSocket &&
    !hasRawResponse
  ) {
    return null
  }

  const rawResponseSection = hasRawResponse ? (
    <RawDataSection
      title={isWebSocket ? 'Raw Message' : 'Raw Response Body'}
      preview={rawResponsePreview}
      base64={rawResponseBase64}
      collapsePreview={collapseRaw}
    />
  ) : null

  let content = null
  if (isOpen) {
    // The loading and error states show only until some structured data
    // (a body, Connect frames, a message) is available.
    const noStructuredData =
      !hasConnectResponse && !detail.responseBody && !(isWebSocket && detail.body)

    if (isLoading && noStructuredData) {
      content = <BodyLoading label="Loading response body…" />
    } else if (error && noStructuredData) {
      content = (
        <div className="mt-2 text-xs text-red-400">
          Failed to load response body details: {error}
        </div>
      )
    } else if (hasConnectResponse) {
      content = (
        <div className="mt-2">
          <h4 className="text-sm font-semibold text-slate-300 mb-2">
            Response Body
            <ResponseSize bytes={detail.responseSize} />
          </h4>
          {detail.responseBodySummary && (
            <div className="text-xs text-slate-400 mb-2">{detail.responseBodySummary}</div>
          )}
          <ConnectTimelines
            connectData={detail.connectResponse}
            phase="response"
            log={detail}
            onCreateJsonPathRule={onCreateJsonPathRule}
          />
          {rawResponseSection}
        </div>
      )
    } else {
      let bodyToShow = ''
      if (detail.responseBody) {
        if (typeof detail.responseBody === 'string') {
          bodyToShow = detail.responseBody
        } else {
          try {
            bodyToShow = JSON.stringify(detail.responseBody, null, 2)
          } catch {
            bodyToShow = String(detail.responseBody)
          }
        }
      } else if (isWebSocket && detail.body) {
        bodyToShow = typeof detail.body === 'string' ? detail.body : JSON.stringify(detail.body)
      }

      if (!bodyToShow && rawResponseSection) {
        content = (
          <div className="mt-2">
            <h4 className="text-sm font-semibold text-slate-300 mb-2">
              {isWebSocket ? 'Message' : 'Response Body'}
            </h4>
            {rawResponseSection}
          </div>
        )
      } else {
        content = (
          <div className="mt-2">
            <h4 className="text-sm font-semibold text-slate-300 mb-2">
              {isWebSocket ? 'Message Preview' : 'Response Body Preview'}
              <ResponseSize bytes={detail.responseSize} />
            </h4>
            {isWebSocket ? (
              <WsMessagePreview
                effectiveLog={detail}
                bodyToShow={bodyToShow}
                onCreateJsonPathRule={onCreateJsonPathRule}
              />
            ) : (
              <HttpResponsePreview
                effectiveLog={detail}
                bodyToShow={bodyToShow}
                onCreateJsonPathRule={onCreateJsonPathRule}
              />
            )}
            {rawResponseSection}
          </div>
        )
      }
    }
  }

  return (
    <CollapsibleBody
      label={isWebSocket ? 'Message / Response Body' : 'Response Body'}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
    >
      {content}
    </CollapsibleBody>
  )
}
