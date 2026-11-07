import { Suspense, lazy, memo } from 'react'
import { Check, ChevronDown, Clock, HardDrive, Replace, ShieldAlert } from 'lucide-react'
import Spinner from '../../components/Spinner'
import {
  SourceIcon,
  formatDirection,
  getContentTypeInfo,
  getMethodBadgeClass,
  getSourceBadgeClass,
  getStatusBadgeClass
} from './badges'

const LogDetail = lazy(() => import('./LogDetail'))

/** @typedef {import('../../lib/types').LogSummary} LogSummary */

/**
 * The "Rewrites" badge with the popover listing the rules that applied; the
 * popover shows on hover and stays when the badge is clicked.
 *
 * @param {Object} props
 * @param {import('../../lib/types').LogRewrite[]} props.rewrites
 * @param {boolean} props.pinned
 * @param {() => void} props.onTogglePin
 */
function RewritesBadge({ rewrites, pinned, onTogglePin }) {
  return (
    <div className="relative inline-flex items-center group/rewrites">
      <button
        type="button"
        onClick={event => {
          event.stopPropagation()
          onTogglePin()
        }}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400 hover:bg-emerald-500/20 focus:outline-hidden focus:ring-1 focus:ring-emerald-500/60"
      >
        <span className="text-[10px] uppercase tracking-wide text-emerald-400">Rewrites</span>
        <span className="font-mono">{rewrites.length}</span>
      </button>

      <div
        className={`absolute left-full top-1/2 transform -translate-y-1/2 ml-2 w-80 bg-[#050505] border border-[#2a2a2a] rounded-lg shadow-2xl p-3 text-[11px] text-slate-200 ${
          pinned ? 'visible' : 'invisible group-hover/rewrites:visible'
        }`}
        style={{ zIndex: 99999 }}
        onClick={event => event.stopPropagation()}
      >
        <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-2">
          Applied rewrites
        </div>

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
              <li key={entry.id} className="border border-[#2a2a2a] rounded px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-slate-100 truncate">
                    {displayName}
                  </span>
                  <span className="text-[9px] uppercase tracking-wide text-slate-500">
                    {kindLabel}
                  </span>
                </div>
                {entry.url && (
                  <div className="text-[10px] text-slate-500 truncate mt-0.5">{entry.url}</div>
                )}
                {scopeToShow && (
                  <div className="text-[9px] text-slate-500 mt-0.5">Scope: {scopeToShow}</div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

function DetailFallback() {
  return (
    <div className="border-t border-[#2a2a2a] p-4 bg-[#0a0a0a] flex items-center justify-center">
      <div className="inline-flex items-center gap-2 text-xs text-slate-400">
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
  onCreateJsonPathRule
}) {
  const url = log.fullUrl || log.url
  const contentInfo = log.responseHeaders ? getContentTypeInfo(log) : null
  const ContentIcon = contentInfo ? contentInfo.icon : null

  return (
    <div className="bg-[#1a1a1a] rounded-lg border border-[#2a2a2a] hover:border-slate-500/70 transition-colors">
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
                  <span className="px-2 py-1 rounded text-xs font-medium bg-slate-700/50 text-slate-300 border border-slate-600">
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
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border bg-slate-700/50 border-slate-600 ${contentInfo.color}`}
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
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    onToggleExport(log.id)
                  }}
                  aria-pressed={selectedForExport}
                  aria-label="Mark for export"
                  className={`relative group/export-flag inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                    selectedForExport
                      ? 'bg-indigo-600/25 border-indigo-400 text-indigo-100 hover:bg-indigo-600/35 hover:text-white'
                      : 'bg-[#050508] border-indigo-500/60 text-indigo-300 hover:bg-indigo-600/15 hover:border-indigo-400 hover:text-indigo-200'
                  }`}
                >
                  <Check className="w-4 h-4" />
                  <div
                    className="invisible group-hover/export-flag:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                    style={{ zIndex: 99999 }}
                    onClick={event => event.stopPropagation()}
                  >
                    <div className="font-semibold mb-1 text-slate-200">Export selection</div>
                    <p>
                      {selectedForExport
                        ? 'This request is marked for export. The Export button will include it even if filters change.'
                        : 'Mark this request to be explicitly included when exporting logs. If no requests are marked, all filtered logs are exported.'}
                    </p>
                  </div>
                </button>
                <label
                  className="relative group/replace-action inline-flex items-center justify-center w-8 h-8 rounded-md bg-blue-600/15 border border-blue-500/60 text-blue-200 hover:bg-blue-600/30 hover:text-white cursor-pointer transition-colors"
                  onClick={event => event.stopPropagation()}
                >
                  <span className="sr-only">Replace response with local file</span>
                  <input
                    type="file"
                    className="hidden"
                    onChange={event => {
                      const file = event.target.files && event.target.files[0]
                      if (file) onReplaceResource(log, file)
                      event.target.value = ''
                    }}
                  />
                  <Replace className="w-4 h-4" />
                  <div
                    className="invisible group-hover/replace-action:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                    style={{ zIndex: 99999 }}
                  >
                    <div className="font-semibold mb-1 text-slate-200">Replace response</div>
                    <p>Serve this request from a local file on disk.</p>
                  </div>
                </label>
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    onToggleBlock(url)
                  }}
                  aria-label={blocked ? 'Unblock URL pattern' : 'Block URL pattern'}
                  className={`relative group/block-action inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                    blocked
                      ? 'bg-[#0f1714] border-emerald-600/70 text-emerald-200 hover:bg-emerald-600/30 hover:text-white'
                      : 'bg-[#15100b] border-orange-600/70 text-orange-200 hover:bg-orange-600/30 hover:text-white'
                  }`}
                >
                  <ShieldAlert className="w-4 h-4" />
                  <div
                    className="invisible group-hover/block-action:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                    style={{ zIndex: 99999 }}
                  >
                    <div className="font-semibold mb-1 text-slate-200">
                      {blocked ? 'Unblock URL pattern' : 'Block URL pattern'}
                    </div>
                    <p>
                      {blocked
                        ? 'Remove this pattern from the blocked list.'
                        : 'Add a blocked URL pattern based on this request.'}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={expanded ? 'Collapse request details' : 'Expand request details'}
                  className={`relative group/log-expand inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                    expanded
                      ? 'bg-[#111827] border-slate-300 text-slate-100 hover:bg-[#1f2937] hover:border-slate-200'
                      : 'bg-[#050508] border-slate-600/80 text-slate-300 hover:bg-[#111827] hover:border-slate-400 hover:text-slate-100'
                  }`}
                  onClick={event => {
                    event.stopPropagation()
                    onToggleExpand(log.id)
                  }}
                >
                  <ChevronDown
                    className={`w-4 h-4 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
                  />
                  <div
                    className="invisible group-hover/log-expand:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                    style={{ zIndex: 99999 }}
                  >
                    <div className="font-semibold mb-1 text-slate-200">
                      {expanded ? 'Hide details' : 'Show details'}
                    </div>
                    <p>
                      {expanded
                        ? 'Collapse the full request and response details.'
                        : 'Expand to inspect the full request and response payloads.'}
                    </p>
                  </div>
                </button>
              </div>
            </div>

            <p className="text-white font-mono text-sm truncate mb-1">{url}</p>

            {log.localResource && (
              <p className="text-green-400 text-xs flex items-center gap-1">
                <HardDrive className="w-3 h-3" />
                Served from local resource: {log.localResource}
              </p>
            )}

            <div className="flex items-center space-x-2 mt-2 text-xs text-slate-400">
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
