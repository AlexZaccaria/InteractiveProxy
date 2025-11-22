import React, { useState, useEffect, useCallback } from 'react';
import { Trash2, Power, ShieldAlert, AlertCircle } from 'lucide-react';
import Spinner from './Spinner';

/**
 * Panel for viewing and managing blocked URL rules.
 *
 * The backend normalises each rule with a stable id, url, enabled flag and a
 * human-friendly name, so the UI only needs to render rule.name and rule.url
 * without performing its own domain parsing.
 *
 * @param {Object} props
 * @param {boolean} [props.enabled]
 * @param {(enabled: boolean) => void} [props.onModeChange]
 * @param {(title: string, message: string, kind: string) => Promise<boolean>} [props.showConfirm]
 */
function BlockedResources({ enabled = true, onModeChange, showConfirm }) {
  const [blockedRules, setBlockedRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const normalizeBlockedRules = (payload) => {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.blockedRules)) return payload.blockedRules;
    return [];
  };

  const fetchBlockedUrls = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('http://localhost:8080/api/blocked');
      const data = await response.json();
      setBlockedRules(normalizeBlockedRules(data));
    } catch (error) {
      console.error('Error fetching blocked URLs:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBlockedUrls();
  }, [fetchBlockedUrls]);

  const unblockRule = useCallback(async (rule) => {
    if (!rule) return;

    let confirmed = true;

    if (showConfirm) {
      try {
        confirmed = await showConfirm(
          'Remove blocked URL',
          `Allow requests matching ${rule.url} to proceed? They will no longer be blocked.`
        );
      } catch (error) {
        console.error('Error showing confirmation modal:', error);
        confirmed = false;
      }
    }

    if (!confirmed) return;

    try {
      setDeletingId(rule.id || rule.url);
      const response = await fetch('http://localhost:8080/api/blocked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rule.id, url: rule.url, action: 'remove' })
      });

      if (response.ok) {
        await fetchBlockedUrls();
      }
    } catch (error) {
      console.error('Error unblocking URL:', error);
    } finally {
      setDeletingId(null);
    }
  }, [fetchBlockedUrls, showConfirm]);

  const toggleRuleEnabled = useCallback(async (rule) => {
    if (!rule) return;
    try {
      const response = await fetch('http://localhost:8080/api/blocked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: rule.id, action: 'update', enabled: !rule.enabled })
      });

      if (response.ok) {
        await fetchBlockedUrls();
      }
    } catch (error) {
      console.error('Error updating blocked rule:', error);
    }
  }, [fetchBlockedUrls]);

  return (
    <div className="space-y-4">
      <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="relative group/blocked-mode">
              <button
                type="button"
                onClick={() => onModeChange && onModeChange(!enabled)}
                className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border transition-colors ${
                  enabled
                    ? 'bg-orange-600/20 border-orange-500/40 text-orange-200'
                    : 'bg-slate-700/40 border-slate-600/50 text-slate-400'
                }`}
                aria-pressed={!!enabled}
              >
                <ShieldAlert className="w-4 h-4" />
                <span className="text-xs font-medium tracking-wide">{enabled ? 'ON' : 'OFF'}</span>
              </button>
              <div
                className="invisible group-hover/blocked-mode:visible absolute left-full bottom-full ml-2 mb-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                style={{ zIndex: 99999 }}
              >
                <div className="font-semibold mb-1 text-slate-200">Blocked requests</div>
                <p>
                  {enabled
                    ? 'Blocking rules are active and matching requests will be stopped.'
                    : 'Blocking rules are disabled. Requests will not be blocked even if a pattern matches.'}
                </p>
              </div>
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Blocked Resources</h3>
              <p className="text-xs text-slate-400">
                {blockedRules.length} {blockedRules.length === 1 ? 'blocked resource' : 'blocked resources'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
          <div className="text-sm text-slate-200">
            <p className="font-medium text-orange-300 mb-1">How blocking works</p>
            <p>
              Requests whose URL contains one of the patterns below will be stopped before reaching the remote server.
              Use this to silence noisy trackers, disable unwanted assets, or temporarily block flaky backends while debugging.
            </p>
          </div>
        </div>
      </div>

      <div>
        {loading && blockedRules.length === 0 ? (
          <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] flex flex-col items-center justify-center text-center">
            <Spinner size="md" />
            <p className="mt-3 text-sm text-slate-400">Loading blocked resources...</p>
          </div>
        ) : blockedRules.length === 0 ? (
          <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] text-center">
            <ShieldAlert className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-white mb-2">No blocked resources</h3>
            <p className="text-slate-400 mb-6">
              Block URLs from logs to prevent them from loading
            </p>
          </div>
        ) : (
          <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a] space-y-3">
            {blockedRules.map((rule) => {
              const displayName =
                typeof rule.name === 'string' && rule.name.trim() ? rule.name.trim() : '';

              return (
                <div
                  key={rule.id || rule.url}
                  className="bg-[#0a0a0a] rounded-lg border border-[#2a2a2a] p-4 hover:border-orange-500/60 transition-colors"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      {displayName && (
                        <p className="text-xs text-slate-500 mb-1">
                          {displayName}
                        </p>
                      )}
                      <p className="text-sm text-slate-200 font-mono truncate" title={rule.url}>
                        {rule.url}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => toggleRuleEnabled(rule)}
                        className={`flex items-center space-x-2 px-3 py-2 rounded-lg transition-colors ${
                          rule.enabled
                            ? 'bg-orange-500/20 border border-orange-500/60 text-orange-200 hover:bg-orange-500/30'
                            : 'bg-slate-700/20 border border-slate-600/50 text-slate-400 hover:bg-slate-700/30'
                        }`}
                        title={rule.enabled ? 'Disable' : 'Enable'}
                      >
                        <Power className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => unblockRule(rule)}
                        disabled={deletingId === (rule.id || rule.url)}
                        className="flex items-center gap-2 px-3 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Remove"
                      >
                        {deletingId === (rule.id || rule.url) ? (
                          <Spinner size="sm" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default BlockedResources;
