import HeaderList from './HeaderList'
import { RequestBodySection, ResponseBodySection } from './BodySection'

/**
 * The expanded part of a card: the request headers and body, the response
 * headers and body (or the WebSocket message), and the error. Loaded with
 * `React.lazy` by the card, so the JSON viewer and the body sections are
 * not part of the initial bundle.
 *
 * @param {Object} props
 * @param {import('../../lib/types').LogSummary} props.log
 * @param {(seed: import('./jsonPath').JsonPathRuleSeed) => void} [props.onCreateJsonPathRule]
 */
export default function LogDetail({ log, onCreateJsonPathRule }) {
  // WebSocket entries always get the message section: the summary view has
  // no body field, the detail fetched when the section opens carries the
  // decoded message (wsBodyJsonAfter / wsBodyJsonBefore).
  const hasResponseSection =
    log.source === 'websocket' ||
    Boolean(log.responseHeaders) ||
    Boolean(log.responseBody) ||
    Boolean(log.wsSummary && typeof log.wsSummary === 'object')

  return (
    <div className="border-t border-edge p-4 bg-surface">
      <div className="space-y-4">
        <div className="border-b border-edge-strong pb-4">
          <h3 className="text-base font-bold text-blue-400 mb-3">📤 Request</h3>

          <div className="space-y-3">
            <div>
              <h4 className="text-sm font-semibold text-fg-body mb-2">Request Headers</h4>
              <HeaderList headers={log.headers} />
            </div>

            <RequestBodySection log={log} onCreateJsonPathRule={onCreateJsonPathRule} />
          </div>
        </div>

        {hasResponseSection && (
          <div>
            <h3 className="text-base font-bold text-green-400 mb-3">
              {log.source === 'websocket' ? '💬 Message' : '📥 Response'}
            </h3>

            <div className="space-y-3">
              {log.responseHeaders && (
                <div>
                  <h4 className="text-sm font-semibold text-fg-body mb-2">Response Headers</h4>
                  <HeaderList headers={log.responseHeaders} />
                </div>
              )}

              <ResponseBodySection log={log} onCreateJsonPathRule={onCreateJsonPathRule} />
            </div>
          </div>
        )}

        {log.error && (
          <div>
            <h3 className="text-base font-bold text-red-400 mb-3">❌ Error</h3>
            <pre className="bg-red-950/30 p-3 rounded text-xs text-red-300 overflow-x-auto">
              {log.error}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
