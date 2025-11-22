import React, { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Clock, AlertTriangle, X } from 'lucide-react';

/**
 * Secret audit panel for detailed proxy performance analysis.
 *
 * This component is intentionally not linked from the main navigation;
 * it is opened via a hidden triple-click gesture on the header icon.
 */
function AuditPanel({ onClose, performance, payloads, routes }) {
  const [latencyStats, setLatencyStats] = useState(null);
  const [errorBuckets, setErrorBuckets] = useState({});
  const [totalErrors, setTotalErrors] = useState(0);
  const [hostStats, setHostStats] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const fetchAudit = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('http://localhost:8080/api/audit');
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!cancelled) {
          const {
            latencyStats: latency = null,
            errorBuckets: buckets = {},
            totalErrors: total = 0,
            hostStats: hosts = []
          } = data || {};
          setLatencyStats(latency);
          setErrorBuckets(buckets || {});
          setTotalErrors(typeof total === 'number' ? total : 0);
          setHostStats(Array.isArray(hosts) ? hosts : []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchAudit();

    return () => {
      cancelled = true;
    };
  }, []);

  const dashboardPerformance = performance || null;
  const dashboardPayloads = payloads || null;

  const dashboardRoutesByHandling = useMemo(() => {
    if (!routes || !routes.byHandling || typeof routes.byHandling !== 'object') {
      return null;
    }

    const normalizeList = (key) => {
      const list = routes.byHandling[key];
      return Array.isArray(list) ? list : [];
    };

    return {
      processed: normalizeList('processed'),
      redirected: normalizeList('redirected'),
      blocked: normalizeList('blocked'),
      served: normalizeList('served')
    };
  }, [routes]);

  const formatMs = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
    if (value < 1) return `${value.toFixed(2)} ms`;
    if (value < 100) return `${value.toFixed(1)} ms`;
    return `${Math.round(value)} ms`;
  };

  const formatBytes = (bytes) => {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '-';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    const value = bytes / Math.pow(k, i);
    const fixed =
      value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
    return `${fixed} ${sizes[i]}`;
  };

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
        <div className="border border-[#2a2a2a] rounded-xl bg-[#050505] p-3 text-[11px] text-slate-500">
          <div className="text-xs font-semibold text-slate-300 mb-1">{title}</div>
          <div>No routes observed for this flow yet.</div>
        </div>
      );
    }

    return (
      <div className="border border-[#2a2a2a] rounded-xl bg-[#050505] p-3">
        <div className="text-xs font-semibold text-slate-300 mb-2">{title}</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] text-left text-slate-300 border-collapse">
            <thead>
              <tr className="border-b border-[#2a2a2a] text-slate-400">
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
              {rows.map((entry) => (
                <tr
                  key={`${entry.handling || 'unknown'}:${entry.host || 'unknown'}${entry.path || '/'}`}
                  className="border-b border-[#161616] last:border-0"
                >
                  <td className="py-1 pr-2 font-mono text-[11px] truncate max-w-xs">
                    {entry.host || 'unknown'}
                  </td>
                  <td className="py-1 pr-2 font-mono text-[11px] truncate max-w-xs">
                    {entry.path || '/'}
                  </td>
                  <td className="py-1 pr-2 text-right">{entry.count ?? 0}</td>
                  <td className="py-1 pr-2 text-right text-slate-200">
                    {formatMs(entry.avgMs)}
                  </td>
                  <td className="py-1 pr-2 text-right text-slate-200">
                    {formatMs(entry.maxMs)}
                  </td>
                  <td className="py-1 pr-2 text-right text-slate-200">
                    {formatBytes(entry.avgBytes)}
                  </td>
                  <td className="py-1 pr-2 text-right text-slate-200">
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
    );
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="relative max-w-6xl w-full mx-4 max-h-[80vh] rounded-2xl border border-[#2a2a2a] bg-[#050505] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a2a] bg-[#0b0b0b]">
          <div className="flex items-center gap-2">
            <div className="bg-blue-500/20 p-1.5 rounded-lg">
              <Activity className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Proxy Audit Panel
              </div>
              <div className="text-[11px] text-slate-500">
                Detailed latency and error metrics (secret view)
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[#181818] text-slate-400 hover:text-slate-100 transition-colors"
            aria-label="Close audit panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto max-h-[calc(80vh-44px)]">
          {loading && (
            <div className="text-xs text-slate-400">Loading audit metrics…</div>
          )}
          {error && (
            <div className="text-xs text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-3 h-3" />
              <span>Failed to load logs: {error}</span>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="border border-[#2a2a2a] rounded-xl bg-[#0b0b0b] p-3 flex items-center gap-3">
              <div className="bg-blue-500/20 p-1.5 rounded-lg">
                <Clock className="w-4 h-4 text-blue-400" />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Measured calls</div>
                <div className="text-lg font-semibold text-slate-100">
                  {latencyStats ? latencyStats.count : 0}
                </div>
                <div className="text-[11px] text-slate-500">with upstreamDurationMs</div>
              </div>
            </div>

            <div className="border border-[#2a2a2a] rounded-xl bg-[#0b0b0b] p-3 flex items-center gap-3">
              <div className="bg-emerald-500/15 p-1.5 rounded-lg">
                <BarChart3 className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Latency (P50 / P90 / P99)</div>
                <div className="text-[13px] font-semibold text-slate-100">
                  {latencyStats
                    ? `${formatMs(latencyStats.median)} · ${formatMs(latencyStats.p90)} · ${formatMs(latencyStats.p99)}`
                    : 'n/a'}
                </div>
                {latencyStats && (
                  <div className="text-[11px] text-slate-500">
                    avg {formatMs(latencyStats.avg)}, range {formatMs(latencyStats.min)} – {formatMs(latencyStats.max)}
                  </div>
                )}
              </div>
            </div>

            <div className="border border-[#2a2a2a] rounded-xl bg-[#0b0b0b] p-3 flex items-center gap-3">
              <div className="bg-red-500/15 p-1.5 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-red-400" />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-400">Upstream errors</div>
                <div className="text-lg font-semibold text-slate-100">{totalErrors}</div>
                <div className="text-[11px] text-slate-500">categorised by error class</div>
              </div>
            </div>
          </div>

          {/* Error buckets */}
          <div className="border border-[#2a2a2a] rounded-xl bg-[#050505] p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                <AlertTriangle className="w-3 h-3 text-red-400" />
                <span>Upstream error categories</span>
              </div>
              <div className="text-[11px] text-slate-500">source: /api/logs.upstreamErrorCategory</div>
            </div>
            {totalErrors === 0 ? (
              <div className="text-[11px] text-slate-500">No upstream error entries in the current log window.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-left text-slate-300 border-collapse">
                  <thead>
                    <tr className="border-b border-[#2a2a2a] text-slate-400">
                      <th className="py-1 pr-2">Category</th>
                      <th className="py-1 pr-2 text-right">Count</th>
                      <th className="py-1 pr-2 text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(errorBuckets).map(([category, count]) => {
                      const pct = totalErrors > 0 ? (count / totalErrors) * 100 : 0;
                      return (
                        <tr key={category} className="border-b border-[#161616] last:border-0">
                          <td className="py-1 pr-2 font-mono text-[11px]">{category}</td>
                          <td className="py-1 pr-2 text-right">{count}</td>
                          <td className="py-1 pr-2 text-right text-slate-400">{pct.toFixed(1)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Per-flow slowest routes from /api/dashboard */}
          {dashboardRoutesByHandling && (
            <div className="border border-[#2a2a2a] rounded-xl bg-[#050505] p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                  <BarChart3 className="w-3 h-3 text-purple-400" />
                  <span>Top 10 routes per flow</span>
                </div>
                <div className="text-[11px] text-slate-500">
                  grouped by handling (processed, redirected, blocked, served)
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {renderFlowTable('Processed (proxy / MITM)', dashboardRoutesByHandling.processed)}
                {renderFlowTable('Redirected / bypassed upstream', dashboardRoutesByHandling.redirected)}
                {renderFlowTable('Blocked by rules', dashboardRoutesByHandling.blocked)}
                {renderFlowTable('Served from local resources', dashboardRoutesByHandling.served)}
              </div>
            </div>
          )}

          {/* Top hosts by average latency */}
          <div className="border border-[#2a2a2a] rounded-xl bg-[#050505] p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                <BarChart3 className="w-3 h-3 text-emerald-400" />
                <span>Top hosts by average upstream latency</span>
              </div>
              <div className="text-[11px] text-slate-500">limit: 20 hosts, last 1000 logs</div>
            </div>
            {hostStats.length === 0 ? (
              <div className="text-[11px] text-slate-500">No upstream latency data available yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-left text-slate-300 border-collapse">
                  <thead>
                    <tr className="border-b border-[#2a2a2a] text-slate-400">
                      <th className="py-1 pr-2">Host</th>
                      <th className="py-1 pr-2 text-right">Calls</th>
                      <th className="py-1 pr-2 text-right">Avg latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hostStats.map((entry) => (
                      <tr key={entry.host} className="border-b border-[#161616] last:border-0">
                        <td className="py-1 pr-2 font-mono text-[11px] truncate max-w-xs">{entry.host}</td>
                        <td className="py-1 pr-2 text-right">{entry.count}</td>
                        <td className="py-1 pr-2 text-right text-slate-200">{formatMs(entry.avgDuration)}</td>
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
  );
}

export default AuditPanel;
