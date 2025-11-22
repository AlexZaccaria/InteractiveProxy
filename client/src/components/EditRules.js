import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Edit3,
  Trash2,
  Plus,
  Save,
  X,
  Power,
  AlertCircle,
  Code,
  Type,
  Copy
} from 'lucide-react';
import axios from 'axios';
import Spinner from './Spinner';

function getRulePreviewText(rule) {
  if (!rule || typeof rule !== 'object') return '(empty)';

  let rawValue;
  if (rule.kind === 'jsonPath') {
    rawValue = Object.prototype.hasOwnProperty.call(rule, 'value') ? rule.value : '';
  } else {
    rawValue = Object.prototype.hasOwnProperty.call(rule, 'replacement') ? rule.replacement : '';
  }

  if (rawValue === null || rawValue === undefined) return '(empty)';
  const text = String(rawValue);
  if (!text) return '(empty)';
  if (text.length <= 300) return text;
  return text.slice(0, 300) + '…';
}

/**
 * Live edit rules configuration panel.
 *
 * This component lets the user view, create and edit both text-based and JSONPath-based
 * live edit rules. Text rules operate on raw text content (headers, bodies, frames), while
 * JSONPath rules target structured fields inside JSON/Protobuf payloads.
 *
 * @param {Object} props
 * @param {() => void} [props.onRulesChanged] Optional callback invoked after rules are created, updated or deleted.
 * @param {boolean} [props.editRulesEnabled] Global switch indicating whether live edit rules are applied.
 * @param {(enabled: boolean) => void} [props.onEditRulesModeChange] Called when the global live edit toggle is changed.
 * @param {(title: string, message: string, kind: string) => Promise<boolean>} [props.showConfirm] Optional async confirm dialog helper.
 * @param {(title: string, message: string, kind: string) => void} [props.showAlert] Optional alert helper for warning/error messages.
 * @param {{ name?: string, path?: string, value?: any, valueType?: string, url?: string, target?: 'request'|'response'|'both' }} [props.initialJsonPathSeed]
 *        Optional seed used to prefill a new JSONPath rule when invoked from the JSON tree view.
 * @param {() => void} [props.onConsumeJsonPathSeed] Callback invoked once the initialJsonPathSeed has been consumed.
 */
function EditRules({
  onRulesChanged,
  editRulesEnabled,
  onEditRulesModeChange,
  showConfirm,
  showAlert,
  initialJsonPathSeed,
  onConsumeJsonPathSeed
}) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingRule, setEditingRule] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [formData, setFormData] = useState({
    kind: 'text',
    name: '',
    start: '',
    end: '',
    replacement: '',
    enabled: true,
    useRegex: false,
    caseSensitive: false,
    path: '',
    value: '',
    valueType: 'string',
    url: '',
    target: 'request'
  });

  const formRef = useRef(null);

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      const response = await axios.get('/api/edit-rules');
      setRules(response.data.rules || []);
    } catch (error) {
      console.error('Error fetching edit rules:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  // When coming from the JSONTree edit icon, prefill a new jsonPath rule
  useEffect(() => {
    if (!initialJsonPathSeed) return;

    setIsCreating(true);
    setEditingRule(null);
    setFormData(prev => ({
      ...prev,
      kind: 'jsonPath',
      name: initialJsonPathSeed.name || '',
      path: initialJsonPathSeed.path || '',
      value: initialJsonPathSeed.value ?? '',
      valueType: initialJsonPathSeed.valueType || 'string',
      url: initialJsonPathSeed.url || '',
      target:
        initialJsonPathSeed.target === 'response' || initialJsonPathSeed.target === 'both'
          ? initialJsonPathSeed.target
          : 'request',
      enabled: true,
      start: '',
      end: '',
      replacement: '',
      useRegex: false,
      caseSensitive: false
    }));

    if (onConsumeJsonPathSeed) {
      onConsumeJsonPathSeed();
    }
  }, [initialJsonPathSeed, onConsumeJsonPathSeed]);

  const handleToggleEnabled = async (rule) => {
    try {
      await axios.put(`/api/edit-rules/${rule.id}`, {
        ...rule,
        enabled: !rule.enabled
      });
      await fetchRules();
      if (onRulesChanged) onRulesChanged();
    } catch (error) {
      console.error('Error toggling rule:', error);
      if (showAlert) {
        showAlert(
          'Failed to toggle rule',
          'An error occurred while toggling this edit rule. Please try again.',
          'error'
        );
      } else {
        alert('Failed to toggle rule');
      }
    }
  };

  const handleCopyJsonValue = useCallback(() => {
    if (!formData.value || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      navigator.clipboard.writeText(formData.value);
    } catch (error) {
      console.error('Failed to copy value to clipboard:', error);
    }
  }, [formData.value]);

  const handleDelete = async (ruleId) => {
    let confirmed = true;

    if (showConfirm) {
      try {
        confirmed = await showConfirm(
          'Delete edit rule',
          'Are you sure you want to delete this rule? This action cannot be undone.'
        );
      } catch (error) {
        console.error('Error showing confirmation modal:', error);
        confirmed = false;
      }
    }

    if (!confirmed) return;

    try {
      setDeletingId(ruleId);
      await axios.delete(`/api/edit-rules/${ruleId}`);
      await fetchRules();
      if (onRulesChanged) onRulesChanged();
    } catch (error) {
      console.error('Error deleting rule:', error);
    } finally {
      setDeletingId(null);
    }
  };

  const handleEdit = (rule) => {
    setEditingRule(rule.id);
    if (rule.kind === 'jsonPath') {
      setIsCreating(false);
      setFormData({
        kind: 'jsonPath',
        name: rule.name || '',
        start: '',
        end: '',
        replacement: '',
        enabled: rule.enabled !== false,
        useRegex: false,
        caseSensitive: false,
        path: rule.path || '',
        value: Object.prototype.hasOwnProperty.call(rule, 'value') ? rule.value : '',
        valueType: rule.valueType || 'string',
        url: rule.url || '',
        target:
          rule.target === 'response' || rule.target === 'both'
            ? rule.target
            : 'request'
      });
    } else {
      setIsCreating(false);
      setFormData({
        kind: 'text',
        name: rule.name || '',
        start: rule.start || '',
        end: rule.end || '',
        replacement: rule.replacement || '',
        enabled: rule.enabled !== false,
        useRegex: rule.useRegex === true,
        caseSensitive: rule.caseSensitive === true,
        path: '',
        value: '',
        valueType: 'string',
        // For text rules, URL/target are optional; when missing, they are
        // treated as global and "both" respectively.
        url: rule.url || '',
        target:
          rule.target === 'request' || rule.target === 'response' || rule.target === 'both'
            ? rule.target
            : 'both'
      });
    }
  };

  const handleCreate = () => {
    setIsCreating(true);
    setFormData({
      kind: 'text',
      name: '',
      start: '',
      end: '',
      replacement: '',
      enabled: true,
      useRegex: false,
      caseSensitive: false,
      path: '',
      value: '',
      valueType: 'string',
      url: '',
      // For new text rules, default to both request and response to preserve
      // the legacy behaviour where text rules applied in all phases.
      target: 'both'
    });
  };

  const handleCancel = () => {
    setEditingRule(null);
    setIsCreating(false);
    setFormData({
      kind: 'text',
      name: '',
      start: '',
      end: '',
      replacement: '',
      enabled: true,
      useRegex: false,
      caseSensitive: false,
      path: '',
      value: '',
      valueType: 'string',
      url: '',
      target: 'request'
    });
  };

  const handleSave = async () => {
    if (formData.kind === 'jsonPath') {
      if (!formData.url.trim() || !formData.path.trim()) {
        const msg = 'For a JSONPath rule you must specify both the URL and the JSON path.';
        if (showAlert) {
          showAlert('Missing fields', msg, 'warning');
        } else {
          alert(msg);
        }
        return;
      }
    } else {
      if (!formData.start && !formData.end) {
        if (showAlert) {
          showAlert(
            'Missing match boundaries',
            'Please provide at least a start or end string so the proxy knows which part of the content to replace.',
            'warning'
          );
        } else {
          alert('Please provide at least a start or end string');
        }
        return;
      }
    }

    const payload =
      formData.kind === 'jsonPath'
        ? {
            kind: 'jsonPath',
            name: formData.name,
            path: formData.path,
            value: formData.value,
            valueType: formData.valueType || 'string',
            url: formData.url,
            target: formData.target || 'request',
            enabled: formData.enabled !== false
          }
        : {
            kind: 'text',
            name: formData.name,
            start: formData.start,
            end: formData.end,
            replacement: formData.replacement,
            enabled: formData.enabled !== false,
            useRegex: formData.useRegex === true,
            caseSensitive: formData.caseSensitive === true,
            // Optional URL/target fields for text rules; when url is empty the
            // rule is global, and when target is omitted it defaults to both.
            url: formData.url || '',
            target:
              formData.target === 'request' || formData.target === 'response' || formData.target === 'both'
                ? formData.target
                : 'both'
          };

    try {
      if (isCreating) {
        await axios.post('/api/edit-rules', payload);
      } else if (editingRule) {
        await axios.put(`/api/edit-rules/${editingRule}`, payload);
      }

      await fetchRules();
      if (onRulesChanged) onRulesChanged();
      handleCancel();
    } catch (error) {
      console.error('Error saving rule:', error);
      const message = error.response?.data?.error || error.message || 'Unknown error';
      if (showAlert) {
        showAlert('Failed to save rule', String(message), 'error');
      } else {
        alert('Failed to save rule: ' + message);
      }
    }
  };

  useEffect(() => {
    if ((isCreating || editingRule) && formRef.current && typeof window !== 'undefined') {
      const headerOffset = 96;
      const rect = formRef.current.getBoundingClientRect();
      const targetY = window.scrollY + rect.top - headerOffset - 16;

      try {
        window.scrollTo({
          top: Math.max(targetY, 0),
          behavior: 'smooth'
        });
      } catch (error) {
        window.scrollTo(0, Math.max(targetY, 0));
      }
    }
  }, [isCreating, editingRule]);


  return (
    <div className="space-y-4">
      <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="relative group/live-edit">
              <button
                type="button"
                onClick={() => onEditRulesModeChange && onEditRulesModeChange(!editRulesEnabled)}
                className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border transition-colors ${
                  editRulesEnabled
                    ? 'bg-cyan-600/20 border-cyan-600/30 text-cyan-300'
                    : 'bg-slate-700/40 border-slate-600/50 text-slate-400'
                }`}
                aria-pressed={!!editRulesEnabled}
              >
                <Edit3 className="w-4 h-4" />
                <span className="text-xs font-medium tracking-wide">{editRulesEnabled ? 'ON' : 'OFF'}</span>
              </button>
              <div className="invisible group-hover/live-edit:visible absolute left-full bottom-full ml-2 mb-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl" style={{ zIndex: 99999 }}>
                <div className="font-semibold mb-1 text-slate-200">Live edit rules</div>
                <p>{editRulesEnabled ? 'Live edit rules are active and may modify matching traffic.' : 'Live edit rules are disabled. All rules are ignored without changing their individual switches.'}</p>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white">Live Editing Rules</h3>
              </div>
              <p className="text-xs text-slate-400">
                {rules.length} {rules.length === 1 ? 'rule' : 'rules'} configured
              </p>
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={isCreating || editingRule}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg bg-cyan-600/20 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-600/30 hover:text-white disabled:bg-slate-700 disabled:text-slate-500 disabled:border-slate-600/50 transition-colors text-xs font-medium"
          >
            <Plus className="w-4 h-4" />
            <span>Add Rule</span>
          </button>
        </div>
      </div>

      <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
          <div className="text-sm text-slate-300">
            <p className="font-medium text-cyan-400 mb-1">How it works</p>
            <p>
              Rules are applied universally across all contexts (headers, bodies, Connect frames, WebSocket messages).
              Text rules use start/end strings to match text patterns: everything from the start marker through the end marker (inclusive) is replaced with your value.
              JSON Path rules let you target structured fields (for example in JSON or protobuf payloads) and overwrite them using a path and value type.
              Only traffic that passes through the proxy pipeline is affected.
            </p>
            <p className="mt-2 text-xs text-slate-400">
              <strong>Note:</strong> If you provide only a start string without an end string, the replacement will continue to the end of the content.
              This allows you to replace everything from a marker onwards without needing to specify where to stop.
            </p>
          </div>
        </div>
      </div>

      {(isCreating || editingRule) && (
        <div ref={formRef} className="bg-[#1a1a1a] rounded-lg p-5 border border-[#2a2a2a]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h4 className="text-sm font-semibold text-white">
                {isCreating ? 'Create rule' : 'Edit rule'}
              </h4>
              <p className="text-xs text-slate-400">
                Applied to all traffic that passes through the proxy pipeline.
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs sm:text-sm">
              {formData.kind === 'text' && (
                <>
                  {/* Regex toggle */}
                  <div className="relative group/regex">
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, useRegex: !formData.useRegex })}
                      className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
                        formData.useRegex
                          ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                          : 'border-[#2a2a2a] bg-[#0a0a0a] text-slate-400 hover:border-blue-500 hover:text-blue-300'
                      }`}
                      aria-pressed={formData.useRegex}
                      aria-label="Toggle regex mode"
                    >
                      <Code className="w-4 h-4" />
                    </button>
                    <div className="invisible group-hover/regex:visible absolute right-0 bottom-full mb-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl" style={{ zIndex: 99999 }}>
                      <div className="font-semibold mb-1 text-slate-200">Regex mode</div>
                      <p>Use regular expressions to match patterns across headers, bodies, and frames.</p>
                    </div>
                  </div>

                  {/* Case sensitivity toggle */}
                  <div className="relative group/case">
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, caseSensitive: !formData.caseSensitive })}
                      className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
                        formData.caseSensitive
                          ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                          : 'border-[#2a2a2a] bg-[#0a0a0a] text-slate-400 hover:border-blue-500 hover:text-blue-300'
                      }`}
                      aria-pressed={formData.caseSensitive}
                      aria-label="Toggle case sensitivity"
                    >
                      <Type className="w-4 h-4" />
                    </button>
                    <div className="invisible group-hover/case:visible absolute right-0 bottom-full mb-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl" style={{ zIndex: 99999 }}>
                      <div className="font-semibold mb-1 text-slate-200">Case sensitive</div>
                      <p>When enabled, matches will respect letter casing. Otherwise, matching is case-insensitive.</p>
                    </div>
                  </div>
                </>
              )}

              {/* Enabled toggle */}
              <div className="relative group/enabled">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, enabled: !formData.enabled })}
                  className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
                    formData.enabled
                      ? 'border-emerald-500 bg-emerald-600/20 text-emerald-300'
                      : 'border-[#2a2a2a] bg-[#0a0a0a] text-slate-400 hover:border-emerald-500 hover:text-emerald-300'
                  }`}
                  aria-pressed={formData.enabled}
                  aria-label="Toggle rule enabled"
                >
                  <Power className="w-4 h-4" />
                </button>
                <div className="invisible group-hover/enabled:visible absolute right-0 bottom-full mb-2 w-56 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl" style={{ zIndex: 99999 }}>
                  <div className="font-semibold mb-1 text-slate-200">Rule enabled</div>
                  <p>Toggle whether this rule is active. Disabled rules are ignored but kept for later.</p>
                </div>
              </div>
            </div>
          </div>

            <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                Rule name
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Replace API Key"
                className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {formData.kind === 'jsonPath' && (
              <>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                    URL pattern
                  </label>
                  <input
                    type="text"
                    value={formData.url}
                    onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                    placeholder="es: /api/v1/users oppure https://example.com/api"
                    className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                </div>

                <div className="flex flex-col sm:flex-row gap-4 items-end">
                  <div className="sm:w-auto">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                      Apply to
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {[{ key: 'request', label: 'Request' }, { key: 'response', label: 'Response' }, { key: 'both', label: 'Both' }].map(option => {
                        const isActive = formData.target === option.key;

                        let activeClasses = '';
                        let hoverClasses = '';
                        if (option.key === 'request') {
                          activeClasses = 'bg-blue-600/20 border-blue-500/60 text-blue-300';
                          hoverClasses = 'hover:border-blue-500 hover:text-blue-300';
                        } else if (option.key === 'response') {
                          activeClasses = 'bg-green-600/20 border-green-500/60 text-green-300';
                          hoverClasses = 'hover:border-green-500 hover:text-green-300';
                        } else {
                          // both
                          activeClasses = 'bg-yellow-500/20 border-yellow-400/60 text-yellow-300';
                          hoverClasses = 'hover:border-yellow-400 hover:text-yellow-300';
                        }

                        return (
                          <button
                            key={option.key}
                            type="button"
                            onClick={() => setFormData({ ...formData, target: option.key })}
                            className={`inline-flex items-center justify-center px-3 h-8 rounded-md border text-xs font-medium transition-colors ${
                              isActive
                                ? activeClasses
                                : `bg-[#0a0a0a] border-[#2a2a2a] text-slate-300 ${hoverClasses}`
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex-1">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                      JSON path
                    </label>
                    <input
                      type="text"
                      value={formData.path}
                      onChange={(e) => setFormData({ ...formData, path: e.target.value })}
                      placeholder="es: root.data[0].user.name"
                      className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-4 items-end">
                  <div className="sm:w-auto">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                      Value type
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {[{ key: 'string', label: 'String' }, { key: 'number', label: 'Number' }, { key: 'boolean', label: 'Boolean' }].map(option => {
                        const isActive = formData.valueType === option.key;
                        return (
                          <button
                            key={option.key}
                            type="button"
                            onClick={() => setFormData({ ...formData, valueType: option.key })}
                            className={`inline-flex items-center justify-center px-3 h-8 rounded-md border text-xs font-medium transition-colors ${
                              isActive
                                ? 'bg-amber-600/20 border-amber-500/60 text-amber-200'
                                : 'bg-[#0a0a0a] border-[#2a2a2a] text-slate-300 hover:border-amber-500 hover:text-amber-200'
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex-1">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                      Value
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={formData.value}
                        onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                        placeholder={formData.valueType === 'string' ? 'Nuovo valore stringa' : 'Valore letterale'}
                        disabled={formData.valueType === 'null'}
                        className="flex-1 px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:text-slate-500"
                      />
                      <button
                        type="button"
                        onClick={handleCopyJsonValue}
                        disabled={!formData.value}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-[#2a2a2a] bg-[#0a0a0a] text-slate-400 hover:border-amber-500 hover:text-amber-300 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Copy current value"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {formData.kind === 'text' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                      Start string
                    </label>
                    <input
                      type="text"
                      value={formData.start}
                      onChange={(e) => setFormData({ ...formData, start: e.target.value })}
                      placeholder="Text before replacement"
                      className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                      End string
                    </label>
                    <input
                      type="text"
                      value={formData.end}
                      onChange={(e) => setFormData({ ...formData, end: e.target.value })}
                      placeholder="Text after replacement"
                      className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-4 items-end mt-2">
                  <div className="sm:w-auto">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                      Apply to
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {[{ key: 'request', label: 'Request' }, { key: 'response', label: 'Response' }, { key: 'both', label: 'Both' }].map(option => {
                        const isActive = formData.target === option.key;

                        let activeClasses = '';
                        let hoverClasses = '';
                        if (option.key === 'request') {
                          activeClasses = 'bg-blue-600/20 border-blue-500/60 text-blue-300';
                          hoverClasses = 'hover:border-blue-500 hover:text-blue-300';
                        } else if (option.key === 'response') {
                          activeClasses = 'bg-green-600/20 border-green-500/60 text-green-300';
                          hoverClasses = 'hover:border-green-500 hover:text-green-300';
                        } else {
                          // both
                          activeClasses = 'bg-yellow-500/20 border-yellow-400/60 text-yellow-300';
                          hoverClasses = 'hover:border-yellow-400 hover:text-yellow-300';
                        }

                        return (
                          <button
                            key={option.key}
                            type="button"
                            onClick={() => setFormData({ ...formData, target: option.key })}
                            className={`inline-flex items-center justify-center px-3 h-8 rounded-md border text-xs font-medium transition-colors ${
                              isActive
                                ? activeClasses
                                : `bg-[#0a0a0a] border-[#2a2a2a] text-slate-300 ${hoverClasses}`
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex-1">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                      URL pattern (optional)
                    </label>
                    <input
                      type="text"
                      value={formData.url}
                      onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                      placeholder="es: /api/v1/users oppure https://example.com/api"
                      className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                    Replacement text
                  </label>
                  <textarea
                    value={formData.replacement}
                    onChange={(e) => setFormData({ ...formData, replacement: e.target.value })}
                    placeholder="New text to insert"
                    rows={3}
                    className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                  />
                </div>
              </>
            )}

            <div className="flex items-center gap-3 pt-4 border-t border-[#2a2a2a]">
              <button
                onClick={handleSave}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-300 hover:bg-blue-600/30 hover:text-white disabled:bg-slate-700 disabled:text-slate-500 disabled:border-slate-600/50 transition-colors text-xs font-medium"
              >
                <Save className="w-4 h-4" />
                <span>Save</span>
              </button>
              <button
                onClick={handleCancel}
                className="inline-flex items-center justify-center px-4 h-8 rounded-lg bg-[#0a0a0a] border border-[#2a2a2a] text-xs font-medium text-slate-300 hover:bg-[#1a1a1a] hover:text-white transition-colors flex items-center gap-2"
              >
                <X className="w-4 h-4" />
                <span>Cancel</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {loading && rules.length === 0 ? (
        <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] flex flex-col items-center justify-center text-center">
          <Spinner size="md" color="blue" />
          <p className="mt-3 text-sm text-slate-400">Loading edit rules...</p>
        </div>
      ) : rules.length === 0 && !isCreating ? (
        <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] text-center">
          <Edit3 className="w-16 h-16 text-slate-600 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-white mb-2">No editing rules</h3>
          <p className="text-slate-400 mb-6">
            Create rules to modify intercepted requests and responses in real-time
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className={`bg-[#0a0a0a] rounded-lg border p-4 transition-colors ${
                editingRule === rule.id
                  ? 'border-cyan-500/70'
                  : 'border-[#2a2a2a] hover:border-cyan-500/60'
              }`}
            >
              <div className="space-y-2">
                {/* Header row: title + badges + actions */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <h4 className="text-white font-medium truncate">
                      {rule.name || 'Unnamed Rule'}
                    </h4>
                    {rule.kind === 'jsonPath' && (
                      <div className="flex items-center gap-1">
                        {(!rule.target || rule.target === 'request') && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-blue-500/20 border border-blue-500/40 text-blue-300">
                            Request
                          </span>
                        )}
                        {rule.target === 'response' && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-green-500/20 border border-green-500/40 text-green-300">
                            Response
                          </span>
                        )}
                        {rule.target === 'both' && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-yellow-500/20 border border-yellow-500/40 text-yellow-300">
                            Both
                          </span>
                        )}
                      </div>
                    )}
                    {!rule.enabled && (
                      <span className="px-2 py-1 rounded text-xs font-medium border bg-slate-500/20 text-slate-400 border-slate-500/30 whitespace-nowrap">
                        Disabled
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleToggleEnabled(rule)}
                      className={`inline-flex items-center justify-center gap-2 px-3 h-8 rounded-lg transition-colors text-xs font-medium ${
                        rule.enabled
                          ? 'bg-cyan-600/20 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-600/30'
                          : 'bg-slate-700/20 border border-slate-600/50 text-slate-400 hover:bg-slate-700/30'
                      }`}
                      title={rule.enabled ? 'Disable' : 'Enable'}
                    >
                      <Power className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleEdit(rule)}
                      disabled={isCreating || (editingRule && editingRule !== rule.id)}
                      className="inline-flex items-center justify-center gap-2 px-3 h-8 bg-blue-600/20 hover:bg-blue-600/30 disabled:bg-slate-700/20 disabled:text-slate-600 text-blue-400 border border-blue-600/30 disabled:border-slate-600/30 rounded-lg transition-colors disabled:cursor-not-allowed text-xs font-medium"
                      title="Edit"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(rule.id)}
                      disabled={isCreating || deletingId === rule.id}
                      className="inline-flex items-center justify-center gap-2 px-3 h-8 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium"
                      title="Remove"
                    >
                      {deletingId === rule.id ? (
                        <Spinner size="sm" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Full-width description content */}
                <div className="space-y-1 text-sm text-slate-400">
                  {rule.start && (
                    <div className="flex items-start gap-2">
                      <span className="text-slate-500 shrink-0">Start:</span>
                      <code className="text-slate-300 break-all">{rule.start}</code>
                    </div>
                  )}
                  {rule.end && (
                    <div className="flex items-start gap-2">
                      <span className="text-slate-500 shrink-0">End:</span>
                      <code className="text-slate-300 break-all">{rule.end}</code>
                    </div>
                  )}
                  {rule.kind === 'jsonPath' && rule.path && (
                    <div className="flex items-start gap-2">
                      <span className="text-slate-500 shrink-0">Path:</span>
                      <code className="text-slate-300 break-all">{rule.path}</code>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <span className="text-slate-500 shrink-0">Replace:</span>
                    <code className="text-cyan-300 break-all">{getRulePreviewText(rule)}</code>
                  </div>
                  {(rule.useRegex || rule.caseSensitive) && (
                    <div className="flex items-center gap-3 mt-2">
                      {rule.useRegex && (
                        <span className="text-xs text-blue-400">Regex</span>
                      )}
                      {rule.caseSensitive && (
                        <span className="text-xs text-purple-400">Case Sensitive</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

export default EditRules;
