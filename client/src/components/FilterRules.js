import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { SkipForward, Trash2, PlusCircle, Lightbulb, AlertCircle, Power, CircuitBoard, CornerDownRight } from 'lucide-react';
import Spinner from './Spinner';

/**
 * Filter rules configuration panel (Redirect/Process modes).
 *
 * Lets the user define URL patterns that determine which traffic is fully processed
 * by the proxy pipeline and which traffic is bypassed. Also surfaces suggestions
 * based on recent traffic.
 *
 * @param {Object} props
 * @param {() => void} [props.onRulesChanged] Optional callback invoked when rules change.
 * @param {('ignore'|'focus')} [props.filterMode] Current filter mode (Redirect vs Process).
 * @param {(mode: 'ignore'|'focus') => void} [props.onFilterModeChange] Called when the mode selector is changed.
 * @param {boolean} [props.filterRulesEnabled] Whether filter rules are globally enabled.
 * @param {(enabled: boolean) => void} [props.onFilterRulesModeChange] Called when the global toggle is changed.
 * @param {(title: string, message: string, kind: string) => Promise<boolean>} [props.showConfirm] Optional confirm helper.
 */
function FilterRules({ onRulesChanged, filterMode = 'ignore', onFilterModeChange, filterRulesEnabled = true, onFilterRulesModeChange, showConfirm }) {
  const bypassMode = filterMode;
  const [patterns, setPatterns] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [newPattern, setNewPattern] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  const fetchBypassPatterns = useCallback(async () => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams();
      if (bypassMode === 'focus' || bypassMode === 'ignore') {
        params.set('mode', bypassMode);
      }
      const response = await fetch(`http://localhost:8080/api/filters?${params.toString()}`);
      const data = await response.json();
      setPatterns(Array.isArray(data) ? data : []);
      if (onRulesChanged) {
        onRulesChanged();
      }
    } catch (err) {
      console.error('Error fetching filter patterns:', err);
      setError('Failed to load filter rules.');
    } finally {
      setIsLoading(false);
    }
  }, [onRulesChanged, bypassMode]);

  const fetchSuggestions = useCallback(async () => {
    try {
      setSuggestionsLoading(true);
      const response = await fetch('http://localhost:8080/api/filters/suggestions');
      const data = await response.json();
      if (Array.isArray(data.suggestions)) {
        setSuggestions(data.suggestions);
      } else {
        setSuggestions([]);
      }
    } catch (err) {
      console.error('Error fetching filter suggestions:', err);
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBypassPatterns();
    if (bypassMode !== 'focus') {
      fetchSuggestions();
    } else {
      setSuggestions([]);
    }
  }, [fetchBypassPatterns, fetchSuggestions, bypassMode]);

  useEffect(() => {
    if (bypassMode === 'focus') return;

    const interval = setInterval(() => {
      fetchSuggestions();
    }, 1000);

    return () => clearInterval(interval);
  }, [fetchSuggestions, bypassMode]);

  const submitPattern = useCallback(async (pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) return false;

    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch('http://localhost:8080/api/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          url: trimmed, 
          action: 'add',
          name: newName.trim() || '',
          enabled: true,
          mode: bypassMode
        })
      });

      if (!response.ok) {
        throw new Error('Failed to add filter pattern');
      }

      await fetchBypassPatterns();
      return true;
    } catch (err) {
      console.error('Error adding filter pattern:', err);
      setError('Failed to add filter pattern.');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [fetchBypassPatterns, newName, bypassMode]);

  const addPattern = useCallback(async (event) => {
    event.preventDefault();
    const success = await submitPattern(newPattern);
    if (success) {
      setNewPattern('');
      setNewName('');
    }
  }, [newPattern, submitPattern]);

  const removePattern = async (id) => {
    let confirmed = true;

    if (showConfirm) {
      try {
        confirmed = await showConfirm(
          'Remove filter rule',
          'Are you sure you want to remove this filter rule? This may change which requests are redirected or processed.'
        );
      } catch (err) {
        console.error('Error showing confirmation modal:', err);
        confirmed = false;
      }
    }

    if (!confirmed) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch('http://localhost:8080/api/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'remove' })
      });

      if (!response.ok) {
        throw new Error('Failed to remove filter pattern');
      }

      await fetchBypassPatterns();
    } catch (err) {
      console.error('Error removing filter pattern:', err);
      setError('Failed to remove filter pattern.');
    } finally {
      setIsLoading(false);
    }
  };

  const togglePattern = async (id, enabled) => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch('http://localhost:8080/api/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled: !enabled, action: 'update' })
      });

      if (!response.ok) {
        throw new Error('Failed to toggle filter pattern');
      }

      await fetchBypassPatterns();
    } catch (err) {
      console.error('Error toggling filter pattern:', err);
      setError('Failed to toggle filter pattern.');
    } finally {
      setIsLoading(false);
    }
  };

  const generateNameFromPattern = (pattern) => {
    // Extract domain from pattern
    // Examples: "facebook.com" -> "Facebook.com", "api.example.com" -> "Example.com"
    try {
      // Remove protocol if present
      let domain = pattern.replace(/^https?:\/\//, '');
      // Remove path if present
      domain = domain.split('/')[0];
      // Remove port if present
      domain = domain.split(':')[0];
      
      // Split by dots and get the main domain (last 2 parts for .com, .org, etc.)
      const parts = domain.split('.');
      if (parts.length >= 2) {
        // Get last 2 parts (e.g., "facebook.com" from "api.facebook.com")
        const mainDomain = parts.slice(-2).join('.');
        // Capitalize first letter
        return mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1);
      }
      
      // Fallback: capitalize first letter of the whole thing
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    } catch (e) {
      return pattern;
    }
  };

  const addSuggestion = useCallback(async (pattern) => {
    const generatedName = generateNameFromPattern(pattern);
    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch('http://localhost:8080/api/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          url: pattern, 
          action: 'add',
          name: generatedName,
          enabled: true,
          mode: bypassMode
        })
      });

      if (!response.ok) {
        throw new Error('Failed to add filter suggestion');
      }

      await fetchBypassPatterns();
    } catch (err) {
      console.error('Error adding filter suggestion:', err);
      setError('Failed to add filter suggestion.');
    } finally {
      setIsLoading(false);
    }
  }, [fetchBypassPatterns, bypassMode]);

  const suggestionRows = useMemo(() => {
    // Only show suggestions that are not already covered by an existing rule
    const filteredSuggestions = suggestions.filter((suggestion) => {
      const pattern = suggestion.pattern || '';
      return !patterns.some((existing) => existing.url.toLowerCase() === pattern.toLowerCase());
    });

    return filteredSuggestions.map((suggestion) => {
      const { pattern, count, samplePaths } = suggestion;
      const pathSummary = samplePaths && samplePaths.length
        ? samplePaths.map(({ path, count: pathCount }) => `${path} (${pathCount})`).join(', ')
        : '—';

      return (
        <div
          key={pattern}
          className={`flex flex-row items-center justify-between gap-3 p-4 bg-[#0a0a0a] rounded-lg border transition-colors ${
            bypassMode === 'focus'
              ? 'border-[#2a2a2a] hover:border-purple-500/70'
              : 'border-[#2a2a2a] hover:border-blue-500/70'
          }`}
        >
          <div className="flex-1 min-w-0 flex flex-col gap-1 text-sm text-slate-300">
            <div className="flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-300" />
              <span className="font-mono">{pattern}</span>
              <span className="text-xs text-slate-500">{count} hits</span>
            </div>
            <div className="text-xs text-slate-500 break-all whitespace-normal" title={pathSummary}>
              Hot paths: {pathSummary}
            </div>
          </div>
          <button
            onClick={() => addSuggestion(pattern)}
            disabled={isLoading}
            className={`inline-flex items-center justify-center px-3 h-8 rounded-lg border transition-colors text-xs font-medium ${
              bypassMode === 'focus'
                ? 'bg-purple-600/20 border-purple-500/50 text-purple-200 hover:bg-purple-600/30 hover:text-white'
                : 'bg-blue-600/20 border-blue-500/50 text-blue-200 hover:bg-blue-600/30 hover:text-white'
            } disabled:bg-slate-700 disabled:text-slate-500 disabled:border-slate-600/50`}
            title="Add rule from suggestion"
          >
            <PlusCircle className="w-4 h-4" />
            <span className="ml-1">Add</span>
          </button>
        </div>
      );
    });
  }, [suggestions, patterns, addSuggestion, isLoading, bypassMode]);

  return (
    <div className="space-y-4">
      <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="relative group/filter-rules">
              <button
                type="button"
                onClick={() => onFilterRulesModeChange && onFilterRulesModeChange(!filterRulesEnabled)}
                className={`inline-flex items-center gap-1.5 px-3 h-8 text-xs font-medium rounded-lg border transition-colors ${
                  filterRulesEnabled
                    ? bypassMode === 'focus'
                      ? 'bg-purple-600/20 border-purple-600/30 text-purple-300'
                      : 'bg-blue-600/20 border-blue-500/40 text-blue-200'
                    : 'bg-slate-700/40 border-slate-600/50 text-slate-400'
                }`}
                aria-pressed={!!filterRulesEnabled}
              >
                {bypassMode === 'focus' ? (
                  <CircuitBoard className="w-4 h-4" />
                ) : (
                  <CornerDownRight className="w-4 h-4" />
                )}
                <span className="text-xs font-medium tracking-wide">{filterRulesEnabled ? 'ON' : 'OFF'}</span>
              </button>
              <div
                className="invisible group-hover/filter-rules:visible absolute left-full bottom-full ml-2 mb-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                style={{ zIndex: 99999 }}
              >
                <div className="font-semibold mb-1 text-slate-200">Filter rules</div>
                <p>
                  {filterRulesEnabled
                    ? 'Filter rules are active and control which requests are bypassed or focused through the proxy pipeline.'
                    : 'Filter rules are disabled. All requests go through the proxy pipeline without automatic bypass based on filter rules.'}
                </p>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white">Filter Rules</h3>
              </div>
              <p className="text-xs text-slate-400">
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

          {onFilterModeChange && (
            <div className="inline-flex items-center rounded-full bg-[#050508] border border-[#252525] p-0.5">
              <button
                type="button"
                onClick={() => onFilterModeChange('ignore')}
                className={`px-3 h-8 text-xs font-medium tracking-wide rounded-full transform transition-all duration-150 ${
                  bypassMode !== 'focus'
                    ? 'bg-blue-600/20 border border-blue-500/60 text-blue-200 scale-100'
                    : 'bg-transparent text-slate-400 hover:bg-[#161616] hover:text-slate-100 scale-95'
                }`}
              >
                Redirect
              </button>
              <button
                type="button"
                onClick={() => onFilterModeChange('focus')}
                className={`px-3 h-8 text-xs font-medium tracking-wide rounded-full transform transition-all duration-150 ml-0.5 ${
                  bypassMode === 'focus'
                    ? 'bg-purple-600/20 border border-purple-500/60 text-purple-200 scale-100'
                    : 'bg-transparent text-slate-400 hover:bg-[#161616] hover:text-slate-100 scale-95'
                }`}
              >
                Process
              </button>
            </div>
          )}
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
          <div className="text-sm text-slate-300">
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
                  In <span className="font-semibold">Process</span> mode, only matching requests pass through the full
                  proxy pipeline (logging, decoding, edit rules); all other traffic is forwarded directly.{' '}
                  In <span className="font-semibold">Redirect</span> mode, requests matching these patterns are
                  completely bypassed by the proxy logic and forwarded directly to the destination (no MITM, no logging,
                  no edits).
                </>
              ) : (
                <>
                  In <span className="font-semibold">Redirect</span> mode, requests matching these patterns are
                  completely bypassed by the proxy logic and forwarded directly to the destination (no MITM, no logging,
                  no edits).{' '}
                  In <span className="font-semibold">Process</span> mode, only matching requests pass through the full
                  proxy pipeline (logging, decoding, edit rules); all other traffic is forwarded directly.
                </>
              )}{' '}
              Matching is case-sensitive and applies to both the raw request path and the resolved absolute URL.
              Suggestions are generated from recent traffic that is not yet covered by an active rule.
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={addPattern} className="bg-[#1a1a1a] rounded-lg p-5 border border-[#2a2a2a] space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-white">Add filter rule</p>
            <p className="text-xs text-slate-400">
              Applies while in {bypassMode === 'focus' ? 'Process' : 'Redirect'} mode.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
              Name (optional)
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Analytics, CDN, Third-party scripts"
              className="w-full px-3 h-8 rounded-lg bg-[#0a0a0a] border border-[#2a2a2a] text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
              Match pattern
            </label>
            <div className="flex flex-row items-center gap-2">
              <input
                type="text"
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                placeholder="Enter partial URL (e.g. /metrics, anthropic.com/api)"
                className="flex-1 px-3 h-8 rounded-lg bg-[#0a0a0a] border border-[#2a2a2a] text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={isLoading || !newPattern.trim()}
                className={`inline-flex items-center justify-center px-4 h-8 rounded-lg transition-colors text-xs font-medium border ${
                  bypassMode === 'focus'
                    ? 'bg-purple-600/20 border-purple-500/40 text-purple-200 hover:bg-purple-600/30 hover:text-white'
                    : 'bg-blue-600/20 border-blue-500/40 text-blue-300 hover:bg-blue-600/30 hover:text-white'
                } disabled:bg-slate-700 disabled:text-slate-500 disabled:border-slate-600/50`}
                title="Add rule"
              >
                <PlusCircle className="w-4 h-4" />
                <span className="ml-1">Add</span>
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
        <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a] space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-white flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-300" />
              Suggested rules
            </h4>
            <span className="text-xs text-slate-500">Top {suggestions.length} frequent domains</span>
          </div>
          {suggestionsLoading && suggestions.length === 0 ? (
            <p className="text-sm text-slate-400 flex items-center gap-2">
              <Spinner size="sm" color="blue" />
              Loading suggestions...
            </p>
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-slate-500">No suggestions available yet. Generate traffic to see recommendations.</p>
          ) : (
            <div className="space-y-2">
              {suggestionRows}
            </div>
          )}
        </div>
      )}

      <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a]">
        {isLoading && patterns.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-slate-400">
            <Spinner size="md" color="blue" />
            <span>Loading rules...</span>
          </div>
        ) : patterns.length === 0 ? (
          <div className="text-center py-8">
            <SkipForward className="w-10 h-10 text-slate-600 mx-auto mb-3" />
            <p className="text-sm text-slate-400">
              {bypassMode === 'focus' ? 'No Process rules configured.' : 'No Redirect rules configured.'}
            </p>
            <p className="text-xs text-slate-500 mt-2">
              {bypassMode === 'focus'
                ? 'Add patterns to inspect only specific domains through the proxy pipeline.'
                : 'Add patterns to skip decoding and logging for high-volume or low-value traffic.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {patterns.map((rule) => (
              <div
                key={rule.id}
                className={`flex items-center justify-between p-4 bg-[#0a0a0a] rounded-lg border transition-colors ${
                  rule.enabled
                    ? bypassMode === 'focus'
                      ? 'border-[#2a2a2a] hover:border-purple-500/70'
                      : 'border-[#2a2a2a] hover:border-blue-500/70'
                    : 'border-slate-700/30 opacity-60'
                }`}
              >
                <div className="flex-1 min-w-0 mr-4">
                  {rule.name && (
                    <p className="text-xs text-slate-500 mb-1">{rule.name}</p>
                  )}
                  <p className={`text-sm font-mono truncate ${
                    rule.enabled ? 'text-slate-300' : 'text-slate-500'
                  }`} title={rule.url}>{rule.url}</p>
                </div>
                <div className="flex items-center space-x-2 flex-shrink-0">
                  <button
                    onClick={() => togglePattern(rule.id, rule.enabled)}
                    className={`inline-flex items-center justify-center gap-2 px-3 h-8 rounded-lg transition-colors text-xs font-medium ${
                      rule.enabled
                        ? bypassMode === 'focus'
                          ? 'bg-purple-600/20 border border-purple-500/60 text-purple-200 hover:bg-purple-600/30'
                          : 'bg-blue-600/20 border border-blue-500/60 text-blue-200 hover:bg-blue-600/30'
                        : 'bg-slate-700/20 border border-slate-600/50 text-slate-400 hover:bg-slate-700/30'
                    }`}
                    title={rule.enabled ? 'Disable' : 'Enable'}
                  >
                    <Power className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => removePattern(rule.id)}
                    className="inline-flex items-center justify-center gap-2 px-3 h-8 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors text-xs font-medium"
                    title="Remove"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default FilterRules;
