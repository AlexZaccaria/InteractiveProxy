import { Suspense, lazy, memo } from 'react'
import {
  Check,
  ChevronDown,
  Clock,
  HardDrive,
  Replace,
  RotateCw,
  ShieldAlert,
  Terminal
} from 'lucide-react'
import Spinner from '../../components/Spinner'
import {
  SourceIcon,
  formatDirection,
  getContentTypeInfo,
  getMethodBadgeClass,
  getSourceBadgeClass,
  getStatusBadgeClass
} from './badges'
import Tooltip from '../../components/Tooltip'

const LogDetail = lazy(() => import('./LogDetail'))

/** @typedef {import('../../lib/types').LogSummary} LogSummary */

/**
 * HTTP entries can be replayed and copied as curl; WebSocket connections,
 * messages and summaries cannot.
 *
 * @param {LogSummary} log
 * @returns {boolean}
 */
export function isReplayableLog(log) {
  return (
    log.method !== 'WS' &&
    log.source !== 'websocket' &&
    !log.isConnectionLog &&
    !log.isWebSocketSummary
  )
}

/**
 * The outcome of the breakpoints an entry went through, one phase per line.
 *
 * @param {{ request?: string, response?: string }} breakpoint
 * @returns {string}
 */
export function describeBreakpoint(breakpoint) {
  return ['request', 'response']
    .filter(phase => typeof breakpoint[phase] === 'string')
    .map(phase => `${phase === 'request' ? 'Request' : 'Response'}: ${breakpoint[phase]}`)
    .join(' · ')
}

/**
 * The network conditions a rule applied to an entry.
 *
 * @param {{ ruleName: string, delayMs: number, throttleKbps: number }} network
 * @returns {string}
 */
export function describeNetwork(network) {
  const parts = []
  if (network.delayMs > 0) parts.push(`+${network.delayMs} ms`)
  if (network.throttleKbps > 0) parts.push(`${network.throttleKbps} kbps`)
  return `${parts.join(' · ')} (${network.ruleName})`
}

/**
 * The "Rewrites" badge with the panel listing the rules that applied; the
 * panel shows on hover and stays open while the badge is pinned by a click.
 *
 * @param {Object} props
 * @param {import('../../lib/types').LogRewrite[]} props.rewrites
 * @param {boolean} props.pinned
 * @param {() => void} props.onTogglePin
 */
function RewritesBadge({ rewrites, pinned, onTogglePin }) {
  const list = (
    <ul className="space-y-1 max-h-48 overflow-y-auto">
      {rewrites.map(entry => {
        const displayName =
          typeof entry.name === 'string' && entry.name.trim()
            ? entry.name.trim()
            : `Rule ${entry.id}`

        const rawKind = typeof entry.kind === 'string' ? entry.kind.trim() : ''
        const kindLabel =
          rawKind === 'jsonPath' ? 'JSONPath' : rawKind === 'text' ? 'Text' : rawKind || 'Rule'

        // The scope the rule actually matched for this entry; the
        // configured target when the phase is not known.
        const appliedScope =
          typeof entry.appliedScope === 'string' && entry.appliedScope.trim()
            ? entry.appliedScope.trim()
            : null
        const targetScope =
          typeof entry.target === 'string' && entry.target.trim() ? entry.target.trim() : null
        const scopeToShow = appliedScope || targetScope

        return (
          <li key={entry.id} className="border border-edge rounded px-2 py-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-fg-strong truncate">{displayName}</span>
              <span className="text-[9px] uppercase tracking-wide text-fg-faint">{kindLabel}</span>
            </div>
            {entry.url && (
              <div className="text-[10px] text-fg-faint truncate mt-0.5">{entry.url}</div>
            )}
            {scopeToShow && (
              <div className="text-[9px] text-fg-faint mt-0.5">Scope: {scopeToShow}</div>
            )}
          </li>
        )
      })}
    </ul>
  )

  return (
    <Tooltip
      title="Applied rewrites"
      description={list}
      placement="right"
      open={pinned || undefined}
      panelClassName="w-80 max-w-[calc(100vw-1rem)]"
      className="items-center"
    >
      <button
        type="button"
        onClick={event => {
          event.stopPropagation()
          onTogglePin()
        }}
        aria-pressed={pinned}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400 hover:bg-emerald-500/20 focus:outline-hidden focus:ring-1 focus:ring-emerald-500/60"
      >
        <span className="text-[10px] uppercase tracking-wide text-emerald-400">Rewrites</span>
        <span className="font-mono">{rewrites.length}</span>
      </button>
    </Tooltip>
  )
}

function DetailFallback() {
  return (
    <div className="border-t border-edge p-4 bg-surface flex items-center justify-center">
      <div className="inline-flex items-center gap-2 text-xs text-fg-muted">
        <Spinner size="sm" />
        <span>Loading details…</span>
      </div>
    </div>
  )
}

/**
 * One card of the list: the badges, the actions, the URL and the time, and
 * the lazily loaded details when expanded. Memoised: the list re-renders
 * on every refetch, a card only when its entry or its flags change.
 *
 * @param {Object} props
 * @param {LogSummary} props.log
 * @param {boolean} props.expanded
 * @param {boolean} props.selectedForExport
 * @param {boolean} props.blocked A blocked pattern matches the URL.
 * @param {boolean} props.rewritesPinned
 * @param {(id: string) => void} props.onToggleExpand
 * @param {(id: string) => void} props.onToggleExport
 * @param {(url: string) => void} props.onToggleBlock
 * @param {(id: string) => void} props.onToggleRewritesPin
 * @param {(log: LogSummary, file: File) => void} props.onReplaceResource
 * @param {(log: LogSummary) => void} props.onReplay Opens the replay form for the entry.
 * @param {(log: LogSummary) => void} props.onCopyCurl Copies the entry as a curl command.
 * @param {boolean} [props.curlCopied] The curl command of this entry was just copied.
 * @param {(seed: import('./jsonPath').JsonPathRuleSeed) => void} [props.onCreateJsonPathRule]
 */
function LogRow({
  log,
  expanded,
  selectedForExport,
  blocked,
  rewritesPinned,
  onToggleExpand,
  onToggleExport,
  onToggleBlock,
  onToggleRewritesPin,
  onReplaceResource,
  onReplay,
  onCopyCurl,
  curlCopied = false,
  onCreateJsonPathRule
}) {
  const url = log.fullUrl || log.url
  const contentInfo = log.responseHeaders ? getContentTypeInfo(log) : null
  const ContentIcon = contentInfo ? contentInfo.icon : null
  const replayable = isReplayableLog(log)

  return (
    <div className="bg-surface-raised rounded-lg border border-edge hover:border-fg-faint/70 transition-colors">
      <div className="p-4 cursor-pointer" onClick={() => onToggleExpand(log.id)}>
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2 relative">
              <div className="flex flex-wrap items-center gap-2">
                <SourceIcon source={log.source} />
                <span
                  className={`px-2 py-1 rounded text-xs font-medium border ${getMethodBadgeClass(log.method)}`}
                >
                  {log.method}
                </span>
                {log.direction && (
                  <span className="px-2 py-1 rounded text-xs font-medium bg-accent-neutral/50 text-fg-body border border-fg-dim">
                    {formatDirection(log)}
                  </span>
                )}
                {/* The WEBSOCKET badge is redundant next to the WS method */}
                {log.method !== 'WS' && (
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium border ${getSourceBadgeClass(log.source)}`}
                  >
                    {log.source.toUpperCase()}
                  </span>
                )}
                {log.statusCode && (
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium border ${getStatusBadgeClass(log.statusCode)}`}
                  >
                    {log.statusCode}
                  </span>
                )}
                {contentInfo && ContentIcon && (
                  <span
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border bg-accent-neutral/50 border-fg-dim ${contentInfo.color}`}
                  >
                    <ContentIcon className="w-3 h-3" />
                    {contentInfo.label}
                  </span>
                )}
                {Array.isArray(log.rewrites) && log.rewrites.length > 0 && (
                  <RewritesBadge
                    rewrites={log.rewrites}
                    pinned={rewritesPinned}
                    onTogglePin={() => onToggleRewritesPin(log.id)}
                  />
                )}
                {log.replayOf && (
                  <Tooltip
                    title="Replay"
                    description="Sent again from the UI. The original entry is still in the list."
                  >
                    <span className="px-2 py-1 rounded text-xs font-medium border bg-cyan-500/10 border-cyan-500/40 text-cyan-300">
                      REPLAY
                    </span>
                  </Tooltip>
                )}
                {log.breakpoint && typeof log.breakpoint === 'object' && (
                  <Tooltip title="Breakpoint" description={describeBreakpoint(log.breakpoint)}>
                    <span className="px-2 py-1 rounded text-xs font-medium border bg-amber-500/10 border-amber-500/40 text-amber-300">
                      BREAKPOINT
                    </span>
                  </Tooltip>
                )}
                {log.network && typeof log.network === 'object' && (
                  <Tooltip title="Network conditions" description={describeNetwork(log.network)}>
                    <span className="px-2 py-1 rounded text-xs font-medium border bg-pink-500/10 border-pink-500/40 text-pink-300">
                      SLOW
                    </span>
                  </Tooltip>
                )}
                {log.passthrough && typeof log.passthrough === 'object' && (
                  <Tooltip
                    title="TLS passthrough"
                    description={`Relayed without TLS termination by the rule ${log.passthrough.ruleName}.`}
                  >
                    <span className="px-2 py-1 rounded text-xs font-medium border bg-blue-500/10 border-blue-500/40 text-blue-300">
                      PASSTHROUGH
                    </span>
                  </Tooltip>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {replayable && (
                  <Tooltip
                    title="Replay request"
                    description="Send this request again through the proxy, after editing its method, URL, headers or body."
                  >
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation()
                        onReplay(log)
                      }}
                      aria-label="Replay request"
                      className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-cyan-600/15 border border-cyan-500/60 text-cyan-200 hover:bg-cyan-600/30 hover:text-fg transition-colors"
                    >
                      <RotateCw className="w-4 h-4" />
                    </button>
                  </Tooltip>
                )}
                {replayable && (
                  <Tooltip
                    title={curlCopied ? 'Copied' : 'Copy as cURL'}
                    description="Copy a curl command that repeats this request, headers and body included."
                  >
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation()
                        onCopyCurl(log)
                      }}
                      aria-label={curlCopied ? 'Copied as cURL' : 'Copy as cURL'}
                      className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
                        curlCopied
                          ? 'bg-emerald-500/20 border-emerald-500/70 text-emerald-200'
                          : 'bg-surface-sunken border-fg-dim/80 text-fg-body hover:bg-surface-highlight hover:border-fg-muted hover:text-fg-strong'
                      }`}
                    >
                      {curlCopied ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Terminal className="w-4 h-4" />
                      )}
                    </button>
                  </Tooltip>
                )}
                <Tooltip
                  title="Export selection"
                  description={
                    selectedForExport
                      ? 'This request is marked for export. The Export button will include it even if filters change.'
                      : 'Mark this request to be explicitly included when exporting logs. If no requests are marked, all filtered logs are exported.'
                  }
                >
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      onToggleExport(log.id)
                    }}
                    aria-pressed={selectedForExport}
                    aria-label="Mark for export"
                    className={`inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                      selectedForExport
                        ? 'bg-indigo-600/25 border-indigo-400 text-indigo-100 hover:bg-indigo-600/35 hover:text-fg'
                        : 'bg-surface-sunken border-indigo-500/60 text-indigo-300 hover:bg-indigo-600/15 hover:border-indigo-400 hover:text-indigo-200'
                    }`}
                  >
                    <Check className="w-4 h-4" />
                  </button>
                </Tooltip>
                <Tooltip
                  title="Replace response"
                  description="Serve this request from a local file on disk."
                >
                  <label
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-blue-600/15 border border-blue-500/60 text-blue-200 hover:bg-blue-600/30 hover:text-fg cursor-pointer transition-colors"
                    onClick={event => event.stopPropagation()}
                  >
                    <span className="sr-only">Replace response with local file</span>
                    <input
                      type="file"
                      name="replace-response-file"
                      className="hidden"
                      onChange={event => {
                        const file = event.target.files && event.target.files[0]
                        if (file) onReplaceResource(log, file)
                        event.target.value = ''
                      }}
                    />
                    <Replace className="w-4 h-4" />
                  </label>
                </Tooltip>
                <Tooltip
                  title={blocked ? 'Unblock URL pattern' : 'Block URL pattern'}
                  description={
                    blocked
                      ? 'Remove this pattern from the blocked list.'
                      : 'Add a blocked URL pattern based on this request.'
                  }
                >
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      onToggleBlock(url)
                    }}
                    aria-label={blocked ? 'Unblock URL pattern' : 'Block URL pattern'}
                    className={`inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                      blocked
                        ? 'bg-emerald-500/10 border-emerald-600/70 text-emerald-200 hover:bg-emerald-600/30 hover:text-fg'
                        : 'bg-orange-500/10 border-orange-600/70 text-orange-200 hover:bg-orange-600/30 hover:text-fg'
                    }`}
                  >
                    <ShieldAlert className="w-4 h-4" />
                  </button>
                </Tooltip>
                <Tooltip
                  title={expanded ? 'Hide details' : 'Show details'}
                  description={
                    expanded
                      ? 'Collapse the full request and response details.'
                      : 'Expand to inspect the full request and response payloads.'
                  }
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Collapse request details' : 'Expand request details'}
                    className={`inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                      expanded
                        ? 'bg-surface-highlight border-fg-body text-fg-strong hover:bg-surface-highlight/80 hover:border-fg-base'
                        : 'bg-surface-sunken border-fg-dim/80 text-fg-body hover:bg-surface-highlight hover:border-fg-muted hover:text-fg-strong'
                    }`}
                    onClick={event => {
                      event.stopPropagation()
                      onToggleExpand(log.id)
                    }}
                  >
                    <ChevronDown
                      className={`w-4 h-4 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
                    />
                  </button>
                </Tooltip>
              </div>
            </div>

            <p className="text-fg font-mono text-sm truncate mb-1">{url}</p>

            {log.localResource && (
              <p className="text-green-400 text-xs flex items-center gap-1">
                <HardDrive className="w-3 h-3" />
                Served from local resource: {log.localResource}
              </p>
            )}

            <div className="flex items-center space-x-2 mt-2 text-xs text-fg-muted">
              <Clock className="w-3 h-3" />
              <span>{new Date(log.timestamp).toLocaleString('it-IT')}</span>
            </div>
          </div>
        </div>
      </div>

      {expanded && (
        <Suspense fallback={<DetailFallback />}>
          <LogDetail log={log} onCreateJsonPathRule={onCreateJsonPathRule} />
        </Suspense>
      )}
    </div>
  )
}

export default memo(LogRow)
