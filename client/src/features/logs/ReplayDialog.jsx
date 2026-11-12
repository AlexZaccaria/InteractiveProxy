import { useEffect, useRef, useState } from 'react'
import { Send, X } from 'lucide-react'
import Spinner from '../../components/Spinner'
import { useReplayForm, useReplayLog } from '../../lib/queries'

/** @typedef {import('../../lib/types').LogSummary} LogSummary */
/** @typedef {import('../../lib/types').ReplayOverrides} ReplayOverrides */
/** @typedef {import('../../lib/types').ReplayResult} ReplayResult */

import {
  INPUT_CLASS,
  LABEL_CLASS,
  METHODS,
  TEXTAREA_CLASS,
  formatBytes,
  formatHeaderLines,
  parseHeaderLines
} from '../../lib/httpForm'

export { formatBytes, formatHeaderLines, parseHeaderLines }

/**
 * @typedef {Object} ReplayFields
 * @property {string} method
 * @property {string} url
 * @property {string} headersText
 * @property {string} bodyText
 */

/**
 * The replay form of an entry: method, URL, headers and body, filled from
 * `GET /api/logs/:id/replay` and sent with `POST /api/logs/:id/replay`.
 * A binary body is sent as captured unless a text body is typed; a body
 * that was not kept is pointed out.
 *
 * @param {Object} props
 * @param {LogSummary} props.log
 * @param {() => void} props.onClose
 */
export default function ReplayDialog({ log, onClose }) {
  const form = useReplayForm(log.id)
  const replay = useReplayLog()
  const [fields, setFields] = useState(/** @type {ReplayFields | null} */ (null))
  const [error, setError] = useState(/** @type {string | null} */ (null))
  const [result, setResult] = useState(/** @type {ReplayResult | null} */ (null))
  const firstFieldRef = useRef(/** @type {HTMLSelectElement | null} */ (null))

  const description = form.data
  const ready = fields !== null

  useEffect(() => {
    if (!description || ready) return
    setFields({
      method: description.method,
      url: description.url,
      headersText: formatHeaderLines(description.headers),
      bodyText: description.body || ''
    })
  }, [description, ready])

  useEffect(() => {
    if (ready && firstFieldRef.current) firstFieldRef.current.focus()
  }, [ready])

  // Escape closes; the element focused before the dialog opened gets the
  // focus back when it closes.
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

  const binaryBody = Boolean(description && description.bodyCaptured && !description.bodyIsText)
  const missingBody = Boolean(description && description.bodyExpected && !description.bodyCaptured)

  /**
   * @template {keyof ReplayFields} K
   * @param {K} key
   * @param {ReplayFields[K]} value
   */
  const update = (key, value) => {
    setFields(current => (current ? { ...current, [key]: value } : current))
  }

  /** @param {import('react').FormEvent} event */
  const submit = async event => {
    event.preventDefault()
    if (!fields || !description) return

    const parsed = parseHeaderLines(fields.headersText)
    if (parsed.error) {
      setError(parsed.error)
      return
    }

    /** @type {ReplayOverrides} */
    const request = { method: fields.method, url: fields.url.trim(), headers: parsed.headers }
    if (fields.bodyText !== '') {
      request.body = fields.bodyText
    } else if (binaryBody) {
      request.bodyBase64 = description.bodyBase64
    } else {
      request.body = null
    }

    setError(null)
    try {
      setResult(await replay.mutateAsync({ id: log.id, request }))
    } catch (failure) {
      setResult(null)
      setError(failure instanceof Error ? failure.message : String(failure))
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
        aria-labelledby="replay-dialog-title"
        className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-surface-raised border border-edge rounded-lg shadow-2xl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <h2 id="replay-dialog-title" className="text-sm font-semibold text-fg-strong">
            Replay request
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the replay form"
            className="p-1 rounded hover:bg-surface-highlight text-fg-muted hover:text-fg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={submit} className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
            {form.isLoading && (
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                <Spinner size="sm" />
                <span>Loading the request…</span>
              </div>
            )}
            {form.error && (
              <p className="text-xs text-red-300">
                {form.error instanceof Error ? form.error.message : String(form.error)}
              </p>
            )}

            {fields && description && (
              <>
                <div className="flex gap-2">
                  <div className="shrink-0 w-32">
                    <label htmlFor="replay-method" className={LABEL_CLASS}>
                      Method
                    </label>
                    <select
                      id="replay-method"
                      name="method"
                      ref={firstFieldRef}
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
                    <label htmlFor="replay-url" className={LABEL_CLASS}>
                      URL
                    </label>
                    <input
                      id="replay-url"
                      name="url"
                      type="text"
                      value={fields.url}
                      onChange={event => update('url', event.target.value)}
                      className={`${INPUT_CLASS} font-mono`}
                      spellCheck={false}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="replay-headers" className={LABEL_CLASS}>
                    Headers
                  </label>
                  <textarea
                    id="replay-headers"
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
                  <label htmlFor="replay-body" className={LABEL_CLASS}>
                    Body
                  </label>
                  {binaryBody && (
                    <p className="text-[11px] text-fg-faint mb-1">
                      Binary body of {formatBytes(description.bodySize)}: it is sent as captured
                      unless a text body is typed here.
                    </p>
                  )}
                  {missingBody && (
                    <p className="text-[11px] text-amber-300 mb-1">
                      The body of the original request was not kept
                      {description.bodyNotKeptBytes > 0
                        ? ` (${formatBytes(description.bodyNotKeptBytes)}, over the retention limit)`
                        : ' (the request was forwarded without inspection)'}
                      : type one here, or send without.
                    </p>
                  )}
                  <textarea
                    id="replay-body"
                    name="body"
                    rows={8}
                    value={fields.bodyText}
                    onChange={event => update('bodyText', event.target.value)}
                    className={TEXTAREA_CLASS}
                    spellCheck={false}
                    placeholder={binaryBody ? 'Binary body, sent as captured' : 'No body'}
                  />
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-edge">
            <div className="min-w-0 text-xs truncate" role="status">
              {error && <span className="text-red-300">{error}</span>}
              {result && !error && (
                <span className="text-emerald-300">
                  Sent: {result.statusCode} · {formatBytes(result.responseBytes)} ·{' '}
                  {result.durationMs} ms
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-3 h-8 rounded-lg text-xs border border-edge text-fg-body hover:bg-surface-highlight transition-colors"
              >
                {result ? 'Close' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={!fields || replay.isPending}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {replay.isPending ? <Spinner size="sm" /> : <Send className="w-3.5 h-3.5" />}
                {result ? 'Send again' : 'Send'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
