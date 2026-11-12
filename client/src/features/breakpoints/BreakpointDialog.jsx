import { useEffect, useRef, useState } from 'react'
import { Ban, Send, X } from 'lucide-react'
import Spinner from '../../components/Spinner'
import { ApiError } from '../../lib/api'
import {
  INPUT_CLASS,
  LABEL_CLASS,
  METHODS,
  TEXTAREA_CLASS,
  formatBytes,
  formatHeaderLines,
  parseHeaderLines
} from '../../lib/httpForm'
import { useAbortBreakpoint, useResumeBreakpoint } from '../../lib/queries'

/** @typedef {import('../../lib/types').PausedBreakpoint} PausedBreakpoint */

/**
 * @typedef {Object} BreakpointFields
 * @property {string} method
 * @property {string} url
 * @property {string} statusCode
 * @property {string} headersText
 * @property {string} bodyText
 */

/**
 * @param {PausedBreakpoint} item
 * @returns {BreakpointFields}
 */
function initialFields(item) {
  if (item.phase === 'response' && item.response) {
    return {
      method: item.method,
      url: item.url,
      statusCode: String(item.response.statusCode),
      headersText: formatHeaderLines(item.response.headers),
      bodyText: item.response.body || ''
    }
  }
  return {
    method: item.method,
    url: item.url,
    statusCode: '',
    headersText: formatHeaderLines(item.headers),
    bodyText: item.body || ''
  }
}

/**
 * The editor of a flow held at a breakpoint. Request phase: method, URL,
 * headers and body of the request about to be forwarded. Response phase:
 * status, headers and body of the response about to go back to the client.
 * Send resumes the flow with the edits, Abort answers the client with an
 * error, closing the editor leaves the flow paused.
 *
 * @param {Object} props
 * @param {PausedBreakpoint} props.item
 * @param {() => void} props.onClose
 */
export default function BreakpointDialog({ item, onClose }) {
  const resume = useResumeBreakpoint()
  const abort = useAbortBreakpoint()
  const [fields, setFields] = useState(() => initialFields(item))
  const [error, setError] = useState(/** @type {string | null} */ (null))
  const firstFieldRef = useRef(/** @type {HTMLElement | null} */ (null))

  const isRequest = item.phase === 'request'
  const shownBody = isRequest ? item : item.response
  const binaryBody = Boolean(shownBody && shownBody.bodySize > 0 && !shownBody.bodyIsText)
  const busy = resume.isPending || abort.isPending

  useEffect(() => {
    if (firstFieldRef.current) firstFieldRef.current.focus()
  }, [])

  useEffect(() => {
    const previous = document.activeElement
    /** @param {KeyboardEvent} event */
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus()
    }
  }, [onClose])

  /**
   * @template {keyof BreakpointFields} K
   * @param {K} key
   * @param {BreakpointFields[K]} value
   */
  const update = (key, value) => setFields(current => ({ ...current, [key]: value }))

  /** @param {unknown} failure */
  const showFailure = failure => {
    if (failure instanceof ApiError && failure.status === 404) {
      setError('This flow is no longer paused: it was resumed elsewhere or timed out.')
      return
    }
    setError(failure instanceof Error ? failure.message : String(failure))
  }

  /** @param {import('react').FormEvent} event */
  const send = async event => {
    event.preventDefault()
    const parsed = parseHeaderLines(fields.headersText)
    if (parsed.error) {
      setError(parsed.error)
      return
    }

    /** @type {Record<string, unknown>} */
    const overrides = { headers: parsed.headers }
    if (isRequest) {
      overrides.method = fields.method
      overrides.url = fields.url.trim()
    } else {
      overrides.statusCode = Number(fields.statusCode)
    }
    if (fields.bodyText !== '') {
      overrides.body = fields.bodyText
    } else if (binaryBody && shownBody) {
      overrides.bodyBase64 = shownBody.bodyBase64
    } else {
      overrides.body = null
    }

    setError(null)
    try {
      await resume.mutateAsync({ id: item.id, overrides })
      onClose()
    } catch (failure) {
      showFailure(failure)
    }
  }

  const abortFlow = async () => {
    setError(null)
    try {
      await abort.mutateAsync(item.id)
      onClose()
    } catch (failure) {
      showFailure(failure)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="breakpoint-dialog-title"
        className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-surface-raised border border-amber-500/60 rounded-lg shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-edge">
          <div className="min-w-0">
            <h2 id="breakpoint-dialog-title" className="text-sm font-semibold text-fg-strong">
              {isRequest ? 'Request paused at a breakpoint' : 'Response paused at a breakpoint'}
            </h2>
            <p className="text-[11px] text-fg-muted truncate">
              Rule {item.rule.name || item.rule.url} · {item.method}{' '}
              <span className="font-mono">{item.url}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the breakpoint editor"
            className="p-1 rounded hover:bg-surface-highlight text-fg-muted hover:text-fg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={send} className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
            {isRequest ? (
              <div className="flex gap-2">
                <div className="shrink-0 w-32">
                  <label htmlFor="breakpoint-editor-method" className={LABEL_CLASS}>
                    Method
                  </label>
                  <select
                    id="breakpoint-editor-method"
                    name="method"
                    ref={element => {
                      firstFieldRef.current = element
                    }}
                    value={fields.method}
                    onChange={event => update('method', event.target.value)}
                    className={INPUT_CLASS}
                  >
                    {METHODS.map(method => (
                      <option key={method} value={method}>
                        {method}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 min-w-0">
                  <label htmlFor="breakpoint-editor-url" className={LABEL_CLASS}>
                    URL
                  </label>
                  <input
                    id="breakpoint-editor-url"
                    name="url"
                    type="text"
                    value={fields.url}
                    onChange={event => update('url', event.target.value)}
                    className={`${INPUT_CLASS} font-mono`}
                    spellCheck={false}
                  />
                </div>
              </div>
            ) : (
              <div className="w-32">
                <label htmlFor="breakpoint-editor-status" className={LABEL_CLASS}>
                  Status code
                </label>
                <input
                  id="breakpoint-editor-status"
                  name="statusCode"
                  type="number"
                  min={100}
                  max={599}
                  ref={element => {
                    firstFieldRef.current = element
                  }}
                  value={fields.statusCode}
                  onChange={event => update('statusCode', event.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
            )}

            <div>
              <label htmlFor="breakpoint-editor-headers" className={LABEL_CLASS}>
                Headers
              </label>
              <textarea
                id="breakpoint-editor-headers"
                name="headers"
                rows={6}
                value={fields.headersText}
                onChange={event => update('headersText', event.target.value)}
                className={TEXTAREA_CLASS}
                spellCheck={false}
                placeholder="One per line, as name: value"
              />
            </div>

            <div>
              <label htmlFor="breakpoint-editor-body" className={LABEL_CLASS}>
                Body
              </label>
              {binaryBody && shownBody && (
                <p className="text-[11px] text-fg-faint mb-1">
                  Binary body of {formatBytes(shownBody.bodySize)}: it is sent as it is unless a
                  text body is typed here.
                </p>
              )}
              {!isRequest && item.response && item.response.bodyDecoded && (
                <p className="text-[11px] text-fg-faint mb-1">
                  Shown decompressed; an edited body is sent uncompressed.
                </p>
              )}
              <textarea
                id="breakpoint-editor-body"
                name="body"
                rows={8}
                value={fields.bodyText}
                onChange={event => update('bodyText', event.target.value)}
                className={TEXTAREA_CLASS}
                spellCheck={false}
                placeholder={binaryBody ? 'Binary body, sent as it is' : 'No body'}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-edge">
            <div className="min-w-0 text-xs truncate" role="status">
              {error && <span className="text-red-300">{error}</span>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={abortFlow}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs border border-red-600/50 text-red-300 hover:bg-red-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {abort.isPending ? <Spinner size="sm" /> : <Ban className="w-3.5 h-3.5" />}
                Abort
              </button>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {resume.isPending ? <Spinner size="sm" /> : <Send className="w-3.5 h-3.5" />}
                {isRequest ? 'Send request' : 'Send response'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
