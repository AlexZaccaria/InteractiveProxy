import React, { useEffect, useMemo } from 'react'
import { Activity, BarChart3, AlertTriangle, X } from 'lucide-react'
import { useAudit, useEditRules, useEditRuleUsage } from '../lib/queries'
import { useProxyStore } from '../store/useProxyStore'

/** Audit polling period while the event stream is not open. */
const AUDIT_POLL_MS = 5000

/**
 * Secret audit panel for detailed proxy performance analysis.
 *
 * This component is intentionally not linked from the main navigation;
 * it is opened via a hidden triple-click gesture on the header icon.
 *
 * The metrics are fetched when the panel opens, then whenever App.jsx
 * invalidates them after a burst of `log` events or, without the stream, on
 * a fixed interval.
 *
 * @param {Object} props
 * @param {() => void} props.onClose
 * @param {{ byHandling?: Record<string, any[]> } | null} [props.routes] The `routes` of the dashboard payload.
 */
function AuditPanel({ onClose, routes }) {
  // Escape closes the panel, whatever has the focus.
  useEffect(() => {
    /** @param {KeyboardEvent} event */
    const handleKeyDown = event => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const eventsConnected = useProxyStore(state => state.eventsConnected)
  const auditQuery = useAudit({ refetchInterval: eventsConnected ? false : AUDIT_POLL_MS })
  const rulesQuery = useEditRules()
  const usageQuery = useEditRuleUsage()

  const loading = auditQuery.isLoading
  const error = auditQuery.error ? auditQuery.error.message || String(auditQuery.error) : null
  const audit = auditQuery.data
  const errorBuckets = audit && audit.errorBuckets ? audit.errorBuckets : {}
  const totalErrors = audit && typeof audit.totalErrors === 'number' ? audit.totalErrors : 0
  const hostStats = audit && Array.isArray(audit.hostStats) ? audit.hostStats : []

  // Best-effort edit rule usage snapshot, with rarely-used rules first to
  // highlight obsolete ones.
  const editRuleUsage = useMemo(() => {
    if (!rulesQuery.data || !usageQuery.data) return []
    const usageMap = usageQuery.data.usage || {}

    return rulesQuery.data
      .filter(rule => rule && rule.id)
      .map(rule => {
        const countRaw = usageMap[rule.id]
        const count =
          typeof countRaw === 'number' && Number.isFinite(countRaw) && countRaw > 0 ? countRaw : 0
        return {
          id: rule.id,
          name: rule.name || '(unnamed rule)',
          enabled: rule.enabled !== false,
          kind: rule.kind || 'text',
          url: rule.url || '',
          target: rule.target || 'both',
          count
        }
      })
      .sort((a, b) => {
        if (a.count !== b.count) return a.count - b.count
        return a.name.localeCompare(b.name)
      })
  }, [rulesQuery.data, usageQuery.data])

  const dashboardRoutesByHandling = useMemo(() => {
    if (!routes || !routes.byHandling || typeof routes.byHandling !== 'object') {
      return null
    }

    const normalizeList = key => {
      const list = routes.byHandling[key]
      return Array.isArray(list) ? list : []
    }

    return {
      processed: normalizeList('processed'),
      redirected: normalizeList('redirected'),
      blocked: normalizeList('blocked'),
      served: normalizeList('served')
    }
  }, [routes])

  const formatMs = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
    if (value < 1) return `${value.toFixed(2)} ms`
    if (value < 100) return `${value.toFixed(1)} ms`
    return `${Math.round(value)} ms`
  }

  const formatBytes = bytes => {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '-'
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
    const value = bytes / Math.pow(k, i)
    const fixed =
      value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
    return `${fixed} ${sizes[i]}`
  }

  /**
   * Render a small table listing the top routes for a specific flow/handling bucket.
   *
   * @param {string} title
   * @param {Array<{
   *   host?: string;
   *   path?: string;
   *   handling?: string;
   *   count?: number;
   *   avgMs?: number;
   *   maxMs?: number;
   *   avgBytes?: number;
   *   kbPerSecond?: number;
   * }>} rows
   * @returns {JSX.Element}
   */
  const renderFlowTable = (title, rows) => {
    if (!rows || rows.length === 0) {
      return (
        <div className="border border-edge rounded-xl bg-surface-sunken p-3 text-[11px] text-fg-faint">
          <div className="text-xs font-semibold text-fg-body mb-1">{title}</div>
          <div>No routes observed for this flow yet.</div>
        </div>
      )
    }

    return (
      <div className="border border-edge rounded-xl bg-surface-sunken p-3">
        <div className="text-xs font-semibold text-fg-body mb-2">{title}</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] text-left text-fg-body border-collapse">
            <thead>
              <tr className="border-b border-edge text-fg-muted">
                <th className="py-1 pr-2">Host</th>
                <th className="py-1 pr-2">Path</th>
                <th className="py-1 pr-2 text-right">Calls</th>
                <th className="py-1 pr-2 text-right">Avg total</th>
                <th className="py-1 pr-2 text-right">Max total</th>
                <th className="py-1 pr-2 text-right">Avg payload</th>
                <th className="py-1 pr-2 text-right">KB/s</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(entry => (
                <tr
                  key={`${entry.handling || 'unknown'}:${entry.host || 'unknown'}${entry.path || '/'}`}
                  className="border-b border-edge-subtle last:border-0"
                >
                  <td className="py-1 pr-2 font-mono text-[11px] truncate max-w-xs">
                    {entry.host || 'unknown'}
                  </td>
                  <td className="py-1 pr-2 font-mono text-[11px] truncate max-w-xs">
                    {entry.path || '/'}
                  </td>
                  <td className="py-1 pr-2 text-right">{entry.count ?? 0}</td>
                  <td className="py-1 pr-2 text-right text-fg-base">{formatMs(entry.avgMs)}</td>
                  <td className="py-1 pr-2 text-right text-fg-base">{formatMs(entry.maxMs)}</td>
                  <td className="py-1 pr-2 text-right text-fg-base">
                    {formatBytes(entry.avgBytes)}
                  </td>
                  <td className="py-1 pr-2 text-right text-fg-base">
                    {typeof entry.kbPerSecond === 'number' && Number.isFinite(entry.kbPerSecond)
                      ? `${entry.kbPerSecond.toFixed(1)} KB/s`
                      : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-panel-title"
        className="relative max-w-6xl w-full mx-4 max-h-[80vh] rounded-2xl border border-edge bg-surface-sunken shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge bg-surface-inset">
          <div className="flex items-center gap-2">
            <div className="bg-blue-500/20 p-1.5 rounded-lg">
              <Activity className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <div
                id="audit-panel-title"
                className="text-xs font-semibold uppercase tracking-wide text-fg-muted"
              >
                Proxy Audit Panel
              </div>
              <div className="text-[11px] text-fg-faint">Detailed latency and error metrics</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-surface-hover text-fg-muted hover:text-fg-strong transition-colors"
            aria-label="Close audit panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto max-h-[calc(80vh-44px)]">
          {loading && <div className="text-xs text-fg-muted">Loading audit metrics…</div>}
          {error && (
            <div className="text-xs text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-3 h-3" />
              <span>Failed to load logs: {error}</span>
            </div>
          )}

          {/* Error buckets */}
          <div className="border border-edge rounded-xl bg-surface-sunken p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-fg-body">
                <AlertTriangle className="w-3 h-3 text-red-400" />
                <span>Upstream error categories</span>
              </div>
              <div className="text-[11px] text-fg-faint">
                source: /api/logs.upstreamErrorCategory
              </div>
            </div>
            {totalErrors === 0 ? (
              <div className="text-[11px] text-fg-faint">
                No upstream error entries in the current log window.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-left text-fg-body border-collapse">
                  <thead>
                    <tr className="border-b border-edge text-fg-muted">
                      <th className="py-1 pr-2">Category</th>
                      <th className="py-1 pr-2 text-right">Count</th>
                      <th className="py-1 pr-2 text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(errorBuckets).map(([category, count]) => {
                      const pct = totalErrors > 0 ? (count / totalErrors) * 100 : 0
                      return (
                        <tr key={category} className="border-b border-edge-subtle last:border-0">
                          <td className="py-1 pr-2 font-mono text-[11px]">{category}</td>
                          <td className="py-1 pr-2 text-right">{count}</td>
                          <td className="py-1 pr-2 text-right text-fg-muted">{pct.toFixed(1)}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Edit rules usage snapshot */}
          {editRuleUsage && editRuleUsage.length > 0 && (
            <div className="border border-edge rounded-xl bg-surface-sunken p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-fg-body">
                  <BarChart3 className="w-3 h-3 text-cyan-400" />
                  <span>Edit rules usage (current log window)</span>
                </div>
                <div className="text-[11px] text-fg-faint">
                  source: /api/edit-rules & /api/edit-rules/usage
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-left text-fg-body border-collapse">
                  <thead>
                    <tr className="border-b border-edge text-fg-muted">
                      <th className="py-1 pr-2">Rule</th>
                      <th className="py-1 pr-2">Kind</th>
                      <th className="py-1 pr-2">Target</th>
                      <th className="py-1 pr-2">URL pattern</th>
                      <th className="py-1 pr-2 text-right">Recent matches</th>
                      <th className="py-1 pr-2 text-right">Enabled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editRuleUsage.map(rule => (
                      <tr key={rule.id} className="border-b border-edge-subtle last:border-0">
                        <td className="py-1 pr-2 font-mono text-[11px] truncate max-w-xs">
                          {rule.name}
                        </td>
                        <td className="py-1 pr-2 text-fg-body">{rule.kind}</td>
                        <td className="py-1 pr-2 text-fg-body">{rule.target}</td>
                        <td className="py-1 pr-2 font-mono text-[11px] truncate max-w-xs">
                          {rule.url || '—'}
                        </td>
                        <td className="py-1 pr-2 text-right text-fg-base">{rule.count}</td>
                        <td className="py-1 pr-2 text-right">
                          <span
                            className={
                              rule.enabled
                                ? 'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-400/60'
                                : 'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-neutral/40 text-fg-muted border border-fg-dim/60'
                            }
                          >
                            {rule.enabled ? 'ON' : 'OFF'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Per-flow slowest routes from /api/dashboard */}
          {dashboardRoutesByHandling && (
            <div className="border border-edge rounded-xl bg-surface-sunken p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-fg-body">
                  <BarChart3 className="w-3 h-3 text-purple-400" />
                  <span>Top 10 routes per flow</span>
                </div>
                <div className="text-[11px] text-fg-faint">
                  grouped by handling (processed, redirected, blocked, served)
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {renderFlowTable('Processed (proxy / MITM)', dashboardRoutesByHandling.processed)}
                {renderFlowTable(
                  'Redirected / bypassed upstream',
                  dashboardRoutesByHandling.redirected
                )}
                {renderFlowTable('Blocked by rules', dashboardRoutesByHandling.blocked)}
                {renderFlowTable('Served from local resources', dashboardRoutesByHandling.served)}
              </div>
            </div>
          )}

          {/* Top hosts by average latency */}
          <div className="border border-edge rounded-xl bg-surface-sunken p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-fg-body">
                <BarChart3 className="w-3 h-3 text-emerald-400" />
                <span>Top hosts by average upstream latency</span>
              </div>
              <div className="text-[11px] text-fg-faint">limit: 20 hosts, last 1000 logs</div>
            </div>
            {hostStats.length === 0 ? (
              <div className="text-[11px] text-fg-faint">
                No upstream latency data available yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-left text-fg-body border-collapse">
                  <thead>
                    <tr className="border-b border-edge text-fg-muted">
                      <th className="py-1 pr-2">Host</th>
                      <th className="py-1 pr-2 text-right">Calls</th>
                      <th className="py-1 pr-2 text-right">Avg latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hostStats.map(entry => (
                      <tr key={entry.host} className="border-b border-edge-subtle last:border-0">
                        <td className="py-1 pr-2 font-mono text-[11px] truncate max-w-xs">
                          {entry.host}
                        </td>
                        <td className="py-1 pr-2 text-right">{entry.count}</td>
                        <td className="py-1 pr-2 text-right text-fg-base">
                          {formatMs(entry.avgDuration)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default AuditPanel
