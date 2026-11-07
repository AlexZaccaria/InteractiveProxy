import React, { useState, useCallback } from 'react'
import { Trash2, Power, ShieldAlert, AlertCircle } from 'lucide-react'
import Spinner from './Spinner'
import { useBlockedRuleMutation, useBlockedRules, useSetFlag } from '../lib/queries'
import { useProxyStore } from '../store/useProxyStore'
import Tooltip from './Tooltip'

/**
 * Panel for viewing and managing blocked URL rules.
 *
 * The backend normalises each rule with a stable id, url, enabled flag and a
 * human-friendly name, so the UI only needs to render rule.name and rule.url
 * without performing its own domain parsing.
 *
 * The list comes from the `blocked` query; the global toggle is the
 * `blockedRulesEnabled` flag of the store.
 *
 * @param {Object} props
 * @param {(title: string, message: string) => Promise<boolean>} [props.showConfirm]
 */
function BlockedResources({ showConfirm }) {
  const enabled = useProxyStore(state => state.blockedRulesEnabled)
  const setBlockedRulesMode = useSetFlag('blocked-rules-mode')
  const blockedQuery = useBlockedRules()
  const { mutateAsync: mutateBlockedRule } = useBlockedRuleMutation()
  const blockedRules = blockedQuery.data || []
  const loading = blockedQuery.isLoading
  const [deletingId, setDeletingId] = useState(null)
  const [togglingId, setTogglingId] = useState(null)

  const unblockRule = useCallback(
    async rule => {
      if (!rule) return

      let confirmed = true

      if (showConfirm) {
        try {
          confirmed = await showConfirm(
            'Remove blocked URL',
            `Allow requests matching ${rule.url} to proceed? They will no longer be blocked.`
          )
        } catch (error) {
          console.error('Error showing confirmation modal:', error)
          confirmed = false
        }
      }

      if (!confirmed) return

      try {
        setDeletingId(rule.id || rule.url)
        await mutateBlockedRule({ id: rule.id, url: rule.url, action: 'remove' })
      } catch (error) {
        console.error('Error unblocking URL:', error)
      } finally {
        setDeletingId(null)
      }
    },
    [mutateBlockedRule, showConfirm]
  )

  const toggleRuleEnabled = useCallback(
    async rule => {
      if (!rule) return
      try {
        setTogglingId(rule.id || rule.url)
        await mutateBlockedRule({ id: rule.id, action: 'update', enabled: !rule.enabled })
      } catch (error) {
        console.error('Error updating blocked rule:', error)
      } finally {
        setTogglingId(null)
      }
    },
    [mutateBlockedRule]
  )

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-lg p-4 border border-edge">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <Tooltip
              title="Blocked requests"
              description={
                enabled
                  ? 'Blocking rules are active and matching requests will be stopped.'
                  : 'Blocking rules are disabled. Requests will not be blocked even if a pattern matches.'
              }
              placement="bottom-start"
            >
              <button
                type="button"
                onClick={() => setBlockedRulesMode.mutate(!enabled)}
                className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border transition-colors ${
                  enabled
                    ? 'bg-orange-600/20 border-orange-500/40 text-orange-200'
                    : 'bg-accent-neutral/40 border-fg-dim/50 text-fg-muted'
                }`}
                aria-pressed={!!enabled}
              >
                <ShieldAlert className="w-4 h-4" />
                <span className="text-xs font-medium tracking-wide">{enabled ? 'ON' : 'OFF'}</span>
              </button>
            </Tooltip>
            <div>
              <h3 className="text-base font-semibold text-fg">Blocked Resources</h3>
              <p className="text-xs text-fg-muted">
                {blockedRules.length}{' '}
                {blockedRules.length === 1 ? 'blocked resource' : 'blocked resources'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
          <div className="text-sm text-fg-base">
            <p className="font-medium text-orange-300 mb-1">How blocking works</p>
            <p>
              Requests whose URL contains one of the patterns below will be stopped before reaching
              the remote server. Use this to silence noisy trackers, disable unwanted assets, or
              temporarily block flaky backends while debugging.
            </p>
          </div>
        </div>
      </div>

      <div>
        {loading && blockedRules.length === 0 ? (
          <div className="bg-surface-raised rounded-lg p-12 border border-edge flex flex-col items-center justify-center text-center">
            <Spinner size="md" />
            <p className="mt-3 text-sm text-fg-muted">Loading blocked resources...</p>
          </div>
        ) : blockedRules.length === 0 ? (
          <div className="bg-surface-raised rounded-lg p-12 border border-edge text-center">
            <ShieldAlert className="w-16 h-16 text-fg-dim mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-fg mb-2">No blocked resources</h3>
            <p className="text-fg-muted mb-6">Block URLs from logs to prevent them from loading</p>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-edge space-y-3">
            {blockedRules.map(rule => {
              const displayName =
                typeof rule.name === 'string' && rule.name.trim() ? rule.name.trim() : ''

              return (
                <div
                  key={rule.id || rule.url}
                  className="bg-surface rounded-lg border border-edge p-4 hover:border-orange-500/60 transition-colors"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      {displayName && <p className="text-xs text-fg-faint mb-1">{displayName}</p>}
                      <p className="text-sm text-fg-base font-mono break-all">{rule.url}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Tooltip title={rule.enabled ? 'Disable' : 'Enable'}>
                        <button
                          onClick={() => toggleRuleEnabled(rule)}
                          disabled={togglingId === (rule.id || rule.url)}
                          className={`flex items-center space-x-2 px-3 py-2 rounded-lg transition-colors ${
                            rule.enabled
                              ? 'bg-orange-500/20 border border-orange-500/60 text-orange-200 hover:bg-orange-500/30'
                              : 'bg-accent-neutral/20 border border-fg-dim/50 text-fg-muted hover:bg-accent-neutral/30'
                          } disabled:opacity-50 disabled:cursor-not-allowed`}
                          aria-label={rule.enabled ? 'Disable' : 'Enable'}
                        >
                          {togglingId === (rule.id || rule.url) ? (
                            <Spinner size="sm" />
                          ) : (
                            <Power className="w-4 h-4" />
                          )}
                        </button>
                      </Tooltip>
                      <Tooltip title="Remove">
                        <button
                          onClick={() => unblockRule(rule)}
                          disabled={deletingId === (rule.id || rule.url)}
                          className="flex items-center gap-2 px-3 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          aria-label="Remove"
                        >
                          {deletingId === (rule.id || rule.url) ? (
                            <Spinner size="sm" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default BlockedResources
