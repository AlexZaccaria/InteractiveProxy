import React, { useState, useCallback, useMemo } from 'react'
import {
  SkipForward,
  Trash2,
  PlusCircle,
  Lightbulb,
  AlertCircle,
  Power,
  CircuitBoard,
  CornerDownRight
} from 'lucide-react'
import Spinner from './Spinner'
import {
  useFilterRuleMutation,
  useFilterRules,
  useFilterSuggestions,
  useSetFilterMode,
  useSetFlag
} from '../lib/queries'
import { useProxyStore } from '../store/useProxyStore'
import Tooltip from './Tooltip'

/** Suggestions polling period while the event stream is not open (Redirect mode only). */
const SUGGESTIONS_POLL_MS = 1000

/**
 * Filter rules configuration panel (Redirect/Process modes).
 *
 * Lets the user define URL patterns that determine which traffic is fully processed
 * by the proxy pipeline and which traffic is bypassed. Also surfaces suggestions
 * based on recent traffic.
 *
 * The rules of the current mode and the suggestions come from the
 * `['filters', mode]` and `filter-suggestions` queries; the mode and the
 * global toggle are the `filterMode` and `filterRulesEnabled` fields of the
 * store. Rule changes made elsewhere arrive through the `rules` events and
 * new traffic refreshes the suggestions (both handled in App.jsx).
 *
 * @param {Object} props
 * @param {(title: string, message: string) => Promise<boolean>} [props.showConfirm] Optional confirm helper.
 */
function FilterRules({ showConfirm }) {
  const bypassMode = useProxyStore(state => state.filterMode)
  const filterRulesEnabled = useProxyStore(state => state.filterRulesEnabled)
  const eventsConnected = useProxyStore(state => state.eventsConnected)
  const setFilterMode = useSetFilterMode()
  const setFilterRulesMode = useSetFlag('filter-rules-mode')

  const rulesQuery = useFilterRules(bypassMode)
  const suggestionsEnabled = bypassMode !== 'focus'
  const suggestionsQuery = useFilterSuggestions({
    enabled: suggestionsEnabled,
    refetchInterval: suggestionsEnabled && !eventsConnected ? SUGGESTIONS_POLL_MS : false
  })
  const ruleMutation = useFilterRuleMutation()
  const { mutateAsync: mutateRule } = ruleMutation

  const patterns = useMemo(() => rulesQuery.data || [], [rulesQuery.data])
  const suggestions = useMemo(
    () => (suggestionsEnabled ? suggestionsQuery.data || [] : []),
    [suggestionsEnabled, suggestionsQuery.data]
  )
  const suggestionsLoading = suggestionsQuery.isLoading
  const [activeRuleId, setActiveRuleId] = useState(null)
  const [newPattern, setNewPattern] = useState('')
  const [newName, setNewName] = useState('')
  const [actionError, setActionError] = useState(null)
  const isLoading = rulesQuery.isLoading || ruleMutation.isPending
  const error = actionError || (rulesQuery.isError ? 'Failed to load filter rules.' : null)

  const submitPattern = useCallback(
    async pattern => {
      const trimmed = pattern.trim()
      if (!trimmed) return false

      try {
        setActionError(null)
        await mutateRule({
          url: trimmed,
          action: 'add',
          name: newName.trim() || '',
          enabled: true,
          mode: bypassMode
        })
        return true
      } catch (err) {
        console.error('Error adding filter pattern:', err)
        setActionError('Failed to add filter pattern.')
        return false
      }
    },
    [mutateRule, newName, bypassMode]
  )

  const addPattern = useCallback(
    async event => {
      event.preventDefault()
      const success = await submitPattern(newPattern)
      if (success) {
        setNewPattern('')
        setNewName('')
      }
    },
    [newPattern, submitPattern]
  )

  const removePattern = async id => {
    let confirmed = true

    if (showConfirm) {
      try {
        confirmed = await showConfirm(
          'Remove filter rule',
          'Are you sure you want to remove this filter rule? This may change which requests are redirected or processed.'
        )
      } catch (err) {
        console.error('Error showing confirmation modal:', err)
        confirmed = false
      }
    }

    if (!confirmed) return

    try {
      setActiveRuleId(id)
      setActionError(null)
      await mutateRule({ id, action: 'remove' })
    } catch (err) {
      console.error('Error removing filter pattern:', err)
      setActionError('Failed to remove filter pattern.')
    } finally {
      setActiveRuleId(null)
    }
  }

  const togglePattern = async (id, enabled) => {
    try {
      setActiveRuleId(id)
      setActionError(null)
      await mutateRule({ id, enabled: !enabled, action: 'update' })
    } catch (err) {
      console.error('Error toggling filter pattern:', err)
      setActionError('Failed to toggle filter pattern.')
    } finally {
      setActiveRuleId(null)
    }
  }

  const generateNameFromPattern = pattern => {
    // Extract domain from pattern
    // Examples: "facebook.com" -> "Facebook.com", "api.example.com" -> "Example.com"
    try {
      // Remove protocol if present
      let domain = pattern.replace(/^https?:\/\//, '')
      // Remove path if present
      domain = domain.split('/')[0]
      // Remove port if present
      domain = domain.split(':')[0]

      // Split by dots and get the main domain (last 2 parts for .com, .org, etc.)
      const parts = domain.split('.')
      if (parts.length >= 2) {
        // Get last 2 parts (e.g., "facebook.com" from "api.facebook.com")
        const mainDomain = parts.slice(-2).join('.')
        // Capitalize first letter
        return mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1)
      }

      // Fallback: capitalize first letter of the whole thing
      return domain.charAt(0).toUpperCase() + domain.slice(1)
    } catch (e) {
      return pattern
    }
  }

  const addSuggestion = useCallback(
    async pattern => {
      const generatedName = generateNameFromPattern(pattern)
      try {
        setActionError(null)
        await mutateRule({
          url: pattern,
          action: 'add',
          name: generatedName,
          enabled: true,
          mode: bypassMode
        })
      } catch (err) {
        console.error('Error adding filter suggestion:', err)
        setActionError('Failed to add filter suggestion.')
      }
    },
    [mutateRule, bypassMode]
  )

  const suggestionRows = useMemo(() => {
    // Only show suggestions that are not already covered by an existing rule
    const filteredSuggestions = suggestions.filter(suggestion => {
      const pattern = suggestion.pattern || ''
      return !patterns.some(existing => existing.url.toLowerCase() === pattern.toLowerCase())
    })

    return filteredSuggestions.map(suggestion => {
      const { pattern, count, samplePaths } = suggestion
      const pathSummary =
        samplePaths && samplePaths.length
          ? samplePaths.map(({ path, count: pathCount }) => `${path} (${pathCount})`).join(', ')
          : '—'

      return (
        <div
          key={pattern}
          className={`flex flex-row items-center justify-between gap-3 p-4 bg-surface rounded-lg border transition-colors ${
            bypassMode === 'focus'
              ? 'border-edge hover:border-purple-500/70'
              : 'border-edge hover:border-blue-500/70'
          }`}
        >
          <div className="flex-1 min-w-0 flex flex-col gap-1 text-sm text-fg-body">
            <div className="flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-300" />
              <span className="font-mono">{pattern}</span>
              <span className="text-xs text-fg-faint">{count} hits</span>
            </div>
            <div className="text-xs text-fg-faint break-all whitespace-normal">
              Hot paths: {pathSummary}
            </div>
          </div>
          <button
            onClick={() => addSuggestion(pattern)}
            disabled={isLoading}
            className={`inline-flex items-center justify-center px-3 h-8 rounded-lg border transition-colors text-xs font-medium ${
              bypassMode === 'focus'
                ? 'bg-purple-600/20 border-purple-500/50 text-purple-200 hover:bg-purple-600/30 hover:text-fg'
                : 'bg-blue-600/20 border-blue-500/50 text-blue-200 hover:bg-blue-600/30 hover:text-fg'
            } disabled:bg-surface-highlight disabled:text-fg-faint disabled:border-fg-dim/50`}
            aria-label="Add rule from suggestion"
          >
            {isLoading ? (
              <>
                <Spinner size="sm" />
                <span className="ml-1">Saving...</span>
              </>
            ) : (
              <>
                <PlusCircle className="w-4 h-4" />
                <span className="ml-1">Add</span>
              </>
            )}
          </button>
        </div>
      )
    })
  }, [suggestions, patterns, addSuggestion, isLoading, bypassMode])

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-lg p-4 border border-edge">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <Tooltip
              title="Filter rules"
              description={
                filterRulesEnabled
                  ? 'Filter rules are active and control which requests are bypassed or focused through the proxy pipeline.'
                  : 'Filter rules are disabled. All requests go through the proxy pipeline without automatic bypass based on filter rules.'
              }
              placement="bottom-start"
            >
              <button
                type="button"
                onClick={() => setFilterRulesMode.mutate(!filterRulesEnabled)}
                className={`inline-flex items-center gap-1.5 px-3 h-8 text-xs font-medium rounded-lg border transition-colors ${
                  filterRulesEnabled
                    ? bypassMode === 'focus'
                      ? 'bg-purple-600/20 border-purple-600/30 text-purple-300'
                      : 'bg-blue-600/20 border-blue-500/40 text-blue-200'
                    : 'bg-accent-neutral/40 border-fg-dim/50 text-fg-muted'
                }`}
                aria-pressed={!!filterRulesEnabled}
              >
                {bypassMode === 'focus' ? (
                  <CircuitBoard className="w-4 h-4" />
                ) : (
                  <CornerDownRight className="w-4 h-4" />
                )}
                <span className="text-xs font-medium tracking-wide">
                  {filterRulesEnabled ? 'ON' : 'OFF'}
                </span>
              </button>
            </Tooltip>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-fg">Filter Rules</h3>
              </div>
              <p className="text-xs text-fg-muted">
                {patterns.length} {patterns.length === 1 ? 'active rule' : 'active rules'} · Mode{' '}
                <span
                  className={`font-semibold ${
                    bypassMode === 'focus' ? 'text-purple-300' : 'text-blue-300'
                  }`}
                >
                  {bypassMode === 'focus' ? 'Process' : 'Redirect'}
                </span>
              </p>
            </div>
          </div>

          <div
            role="group"
            aria-label="Filter mode"
            className="inline-flex items-center rounded-full bg-surface-sunken border border-edge-subtle p-0.5"
          >
            <button
              type="button"
              onClick={() => setFilterMode.mutate('ignore')}
              className={`px-3 h-8 text-xs font-medium tracking-wide rounded-full transform transition-all duration-150 ${
                bypassMode !== 'focus'
                  ? 'bg-blue-600/20 border border-blue-500/60 text-blue-200 scale-100'
                  : 'bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-strong scale-95'
              }`}
            >
              Redirect
            </button>
            <button
              type="button"
              onClick={() => setFilterMode.mutate('focus')}
              className={`px-3 h-8 text-xs font-medium tracking-wide rounded-full transform transition-all duration-150 ml-0.5 ${
                bypassMode === 'focus'
                  ? 'bg-purple-600/20 border border-purple-500/60 text-purple-200 scale-100'
                  : 'bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-strong scale-95'
              }`}
            >
              Process
            </button>
          </div>
        </div>
      </div>

      <div
        className={`rounded-lg p-4 border ${
          bypassMode === 'focus'
            ? 'bg-purple-500/10 border-purple-500/30'
            : 'bg-blue-500/10 border-blue-500/30'
        }`}
      >
        <div className="flex items-start gap-3">
          <AlertCircle
            className={`w-5 h-5 shrink-0 mt-0.5 ${
              bypassMode === 'focus' ? 'text-purple-400' : 'text-blue-400'
            }`}
          />
          <div className="text-sm text-fg-body">
            <p
              className={`font-medium mb-1 ${
                bypassMode === 'focus' ? 'text-purple-400' : 'text-blue-400'
              }`}
            >
              How it works
            </p>
            <p>
              {bypassMode === 'focus' ? (
                <>
                  In <span className="font-semibold">Process</span> mode, only matching requests
                  pass through the full proxy pipeline (logging, decoding, edit rules); all other
                  traffic is forwarded directly. In <span className="font-semibold">Redirect</span>{' '}
                  mode, requests matching these patterns are completely bypassed by the proxy logic
                  and forwarded directly to the destination (no MITM, no logging, no edits).
                </>
              ) : (
                <>
                  In <span className="font-semibold">Redirect</span> mode, requests matching these
                  patterns are completely bypassed by the proxy logic and forwarded directly to the
                  destination (no MITM, no logging, no edits). In{' '}
                  <span className="font-semibold">Process</span> mode, only matching requests pass
                  through the full proxy pipeline (logging, decoding, edit rules); all other traffic
                  is forwarded directly.
                </>
              )}{' '}
              Matching is case-sensitive and applies to both the raw request path and the resolved
              absolute URL. Suggestions are generated from recent traffic that is not yet covered by
              an active rule.
            </p>
          </div>
        </div>
      </div>

      <form
        onSubmit={addPattern}
        className="bg-surface-raised rounded-lg p-5 border border-edge space-y-4"
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-fg">Add filter rule</p>
            <p className="text-xs text-fg-muted">
              Applies while in {bypassMode === 'focus' ? 'Process' : 'Redirect'} mode.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="filter-rule-name"
              className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2"
            >
              Name (optional)
            </label>
            <input
              type="text"
              id="filter-rule-name"
              name="filter-rule-name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. Analytics, CDN, Third-party scripts"
              className="w-full px-3 h-8 rounded-lg bg-surface border border-edge text-xs text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label
              htmlFor="filter-rule-pattern"
              className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2"
            >
              Match pattern
            </label>
            <div className="flex flex-row items-center gap-2">
              <input
                type="text"
                id="filter-rule-pattern"
                name="filter-rule-pattern"
                value={newPattern}
                onChange={e => setNewPattern(e.target.value)}
                placeholder="Enter partial URL (e.g. /metrics, anthropic.com/api)"
                className="flex-1 px-3 h-8 rounded-lg bg-surface border border-edge text-xs text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={isLoading || !newPattern.trim()}
                className={`inline-flex items-center justify-center px-4 h-8 rounded-lg transition-colors text-xs font-medium border ${
                  bypassMode === 'focus'
                    ? 'bg-purple-600/20 border-purple-500/40 text-purple-200 hover:bg-purple-600/30 hover:text-fg'
                    : 'bg-blue-600/20 border-blue-500/40 text-blue-300 hover:bg-blue-600/30 hover:text-fg'
                } disabled:bg-surface-highlight disabled:text-fg-faint disabled:border-fg-dim/50`}
                aria-label="Add rule"
              >
                {isLoading ? (
                  <>
                    <Spinner size="sm" />
                    <span className="ml-1">Saving...</span>
                  </>
                ) : (
                  <>
                    <PlusCircle className="w-4 h-4" />
                    <span className="ml-1">Add</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </form>

      {error && (
        <div className="bg-red-900/40 border border-red-800 text-red-200 text-sm rounded p-3">
          {error}
        </div>
      )}

      {bypassMode !== 'focus' && (
        <div className="bg-surface-raised rounded-lg p-4 border border-edge space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-fg flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-300" />
              Suggested rules
            </h4>
            <span className="text-xs text-fg-faint">Top {suggestions.length} frequent domains</span>
          </div>
          {suggestionsLoading && suggestions.length === 0 ? (
            <p className="text-sm text-fg-muted flex items-center gap-2">
              <Spinner size="sm" color="blue" />
              Loading suggestions...
            </p>
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-fg-faint">
              No suggestions available yet. Generate traffic to see recommendations.
            </p>
          ) : (
            <div className="space-y-2">{suggestionRows}</div>
          )}
        </div>
      )}

      <div className="bg-surface-raised rounded-lg p-4 border border-edge">
        {isLoading && patterns.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-fg-muted">
            <Spinner size="md" color="blue" />
            <span>Loading rules...</span>
          </div>
        ) : patterns.length === 0 ? (
          <div className="text-center py-8">
            <SkipForward className="w-10 h-10 text-fg-dim mx-auto mb-3" />
            <p className="text-sm text-fg-muted">
              {bypassMode === 'focus'
                ? 'No Process rules configured.'
                : 'No Redirect rules configured.'}
            </p>
            <p className="text-xs text-fg-faint mt-2">
              {bypassMode === 'focus'
                ? 'Add patterns to inspect only specific domains through the proxy pipeline.'
                : 'Add patterns to skip decoding and logging for high-volume or low-value traffic.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {patterns.map(rule => (
              <div
                key={rule.id}
                className={`flex items-center justify-between p-4 bg-surface rounded-lg border transition-colors ${
                  rule.enabled
                    ? bypassMode === 'focus'
                      ? 'border-edge hover:border-purple-500/70'
                      : 'border-edge hover:border-blue-500/70'
                    : 'border-edge/30 opacity-60'
                }`}
              >
                <div className="flex-1 min-w-0 mr-4">
                  {rule.name && <p className="text-xs text-fg-faint mb-1">{rule.name}</p>}
                  <p
                    className={`text-sm font-mono break-all ${
                      rule.enabled ? 'text-fg-body' : 'text-fg-faint'
                    }`}
                  >
                    {rule.url}
                  </p>
                </div>
                <div className="flex items-center space-x-2 shrink-0">
                  <Tooltip title={rule.enabled ? 'Disable' : 'Enable'}>
                    <button
                      onClick={() => togglePattern(rule.id, rule.enabled)}
                      disabled={activeRuleId === rule.id && isLoading}
                      className={`inline-flex items-center justify-center gap-2 px-3 h-8 rounded-lg transition-colors text-xs font-medium ${
                        rule.enabled
                          ? bypassMode === 'focus'
                            ? 'bg-purple-600/20 border border-purple-500/60 text-purple-200 hover:bg-purple-600/30'
                            : 'bg-blue-600/20 border border-blue-500/60 text-blue-200 hover:bg-blue-600/30'
                          : 'bg-accent-neutral/20 border border-fg-dim/50 text-fg-muted hover:bg-accent-neutral/30'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                      aria-label={rule.enabled ? 'Disable' : 'Enable'}
                    >
                      {activeRuleId === rule.id && isLoading ? (
                        <Spinner size="sm" />
                      ) : (
                        <Power className="w-4 h-4" />
                      )}
                    </button>
                  </Tooltip>
                  <Tooltip title="Remove">
                    <button
                      onClick={() => removePattern(rule.id)}
                      disabled={activeRuleId === rule.id && isLoading}
                      className="inline-flex items-center justify-center gap-2 px-3 h-8 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Remove"
                    >
                      {activeRuleId === rule.id && isLoading ? (
                        <Spinner size="sm" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default FilterRules
