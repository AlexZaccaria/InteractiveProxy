import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import Modal from './Modal';
import Spinner from './Spinner';
import { useModal } from '../hooks/useModal';
import {
  Search,
  Filter,
  ChevronDown,
  Globe,
  HardDrive,
  AlertCircle,
  Clock,
  Link as LinkIcon,
  FileText,
  FileJson,
  FileCode,
  Image,
  Film,
  Music,
  File,
  Replace,
  ShieldAlert,
  HelpCircle,
  Info,
  Check
} from 'lucide-react';
import { JSONTree } from 'react-json-tree';

const PAGE_SIZE = 50;

// App-themed base16 palette for react-json-tree, tuned to match the proxy UI
// with enhanced contrast and distinct colors for better readability.
const jsonTreeTheme = {
  scheme: 'proxy-dark',
  author: 'interactive-proxy',
  // background + depth (aligned with bg-[#0f0f0f] / bg-[#050505])
  base00: '#0f0f0f', // main tree background
  base01: '#1a1a1a', // slightly lighter for depth
  base02: '#252525', // nested level background
  base03: '#64748b', // slate-500 — comments, less prominent
  // neutral text
  base04: '#94a3b8', // slate-400 — secondary text
  base05: '#cbd5e1', // slate-300 — primary text
  base06: '#e2e8f0', // slate-200 — bright text
  base07: '#f1f5f9', // slate-100 — brightest
  // accents (distinct colors for different data types)
  base08: '#ef4444', // red-500 — null, undefined, errors
  base09: '#2dd4bf', // teal-400 — numbers
  base0A: '#fbbf24', // amber-400 — booleans
  base0B: '#d4d4d4', // neutral-300 — strings (lighter gray for better readability)
  base0C: '#22d3ee', // cyan-400 — dates, special values
  base0D: '#facc15', // amber-300 — keys, property names (warm, clearly distinct from strings)
  base0E: '#c084fc', // purple-400 — functions, symbols
  base0F: '#fb923c'  // orange-400 — regex, special types
};

// Expand everything by default (used for all JSON views)
const shouldExpandJsonTreeAll = () => true;

// Shared value renderer for react-json-tree so that values keep their
// original representation (we don't alter fonts or wrap primitives).
const renderJsonValue = (raw /*, value */) => raw;

const isNumericJsonKey = (key) => {
  if (typeof key === 'number') {
    return Number.isInteger(key) && key >= 0;
  }
  if (typeof key === 'string') {
    const trimmed = key.trim();
    if (!trimmed) return false;
    return /^\d+$/.test(trimmed);
  }
  return false;
};

// Build a JSON path string compatible with the backend parseJsonPath helper.
// Examples:
//   keyPath = ['f1', 'root']        => "root.f1"
//   keyPath = ['0', 'items', 'root'] => "root.items[0]"
const buildJsonPathFromKeyPath = (keyPath) => {
  if (!Array.isArray(keyPath) || keyPath.length === 0) return 'root';

  const full = [...keyPath].reverse(); // [root, parent, ..., current]
  const segments = full.slice(1); // drop graphical root label, always prefix with "root"

  let path = 'root';
  for (const seg of segments) {
    if (isNumericJsonKey(seg)) {
      const index = typeof seg === 'number' ? seg : Number.parseInt(String(seg).trim(), 10);
      if (Number.isFinite(index) && index >= 0) {
        path += `[${index}]`;
      } else {
        path += `.${String(seg)}`;
      }
    } else {
      path += `.${String(seg)}`;
    }
  }

  return path;
};

// Small helper component for clickable JSON key labels with a custom tooltip.
// Used by createJsonTreeLabelRenderer so that each label can show an
// explanatory tooltip on hover without relying on the native title attribute.
const JsonTreeClickableLabel = ({ labelText, path, onActivate }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });
  const anchorRef = React.useRef(null);
  const hideTimeoutRef = React.useRef(null);

  const updateTooltipPosition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const tooltipWidth = 280; // similar to other tooltips
    const margin = 6;
    const top = rect.bottom + margin;
    const left = Math.max(8, rect.left - tooltipWidth / 2);
    setTooltipPosition({ top, left });
  }, []);

  const cancelHide = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimeoutRef.current = setTimeout(() => {
      setShowTooltip(false);
    }, 120);
  }, [cancelHide]);

  const handleClick = (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (typeof onActivate === 'function') {
      onActivate();
    }
  };

  const handleMouseEnter = () => {
    cancelHide();
    updateTooltipPosition();
    setShowTooltip(true);
  };

  const handleMouseLeave = () => {
    scheduleHide();
  };

  return (
    <>
      <span
        ref={anchorRef}
        className="cursor-pointer underline decoration-dotted decoration-slate-500/70 hover:decoration-slate-300"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {labelText}
      </span>
      {showTooltip && createPortal(
        <div
          className="fixed w-72 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-2 text-[11px] text-slate-300 shadow-2xl"
          style={{ zIndex: 99999, top: tooltipPosition.top, left: tooltipPosition.left }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <div className="space-y-0.5">
            <div>Click to create a rewrite rule for this field.</div>
            <div className="text-slate-500 truncate">
              Path: <code className="text-[10px] text-blue-300">{path}</code>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

// Resolve the JSON value at a given keyPath inside the provided root object.
const resolveJsonValueFromKeyPath = (root, keyPath = []) => {
  if (root === null || root === undefined) return undefined;
  if (!Array.isArray(keyPath) || keyPath.length === 0) return root;

  const full = [...keyPath].reverse(); // [rootLabel, parent, ..., currentKey]
  const segments = full.slice(1); // drop synthetic root label

  let current = root;
  for (const seg of segments) {
    if (current == null) return undefined;

    if (Array.isArray(current)) {
      let idx = null;
      if (isNumericJsonKey(seg)) {
        idx = typeof seg === 'number' ? seg : Number.parseInt(String(seg).trim(), 10);
      }
      if (!Number.isFinite(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      const key = String(seg);
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
      current = current[key];
    } else {
      return undefined;
    }
  }

  return current;
};

// Extract a human-friendly endpoint name from a URL pattern using the last
// non-empty path segment (e.g. ".../GetChatMessage" -> "GetChatMessage").
const extractEndpointNameFromUrlPattern = (pattern) => {
  if (!pattern || typeof pattern !== 'string') return '';
  let cleaned = pattern.trim();
  if (!cleaned) return '';

  // Drop query and hash
  cleaned = cleaned.split('#')[0];
  cleaned = cleaned.split('?')[0];

  // Remove trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');

  const parts = cleaned.split('/').filter(Boolean);
  if (!parts.length) return cleaned;
  return parts[parts.length - 1];
};

// Factory for react-json-tree labelRenderer that makes each key label
// clickable to seed a jsonPath rule. The handler receives a seed object for a
// new jsonPath rule and is responsible for navigating to the Edit Rules UI.
//
// The optional targetHint parameter lets the caller hint whether the rule
// should apply to the request body, the response body, or both. When omitted,
// rules default to targeting the request.
const createJsonTreeLabelRenderer = (
  onCreateJsonPathRule,
  contextLabel,
  urlPattern,
  rootData,
  targetHint = 'request'
) => {
  return (keyPath = []) => {
    const hasHandler = typeof onCreateJsonPathRule === 'function';
    const [currentKey] = keyPath;

    // react-json-tree uses a synthetic "root" label; avoid attaching an
    // edit button to that virtual node.
    const isRootNode =
      keyPath.length === 1 && (currentKey === 'root' || currentKey === 'ROOT' || currentKey === '$');

    const labelText = String(currentKey ?? '');

    if (!hasHandler || isRootNode) {
      return <span>{labelText}</span>;
    }

    const path = buildJsonPathFromKeyPath(keyPath);
    const resolvedValue = resolveJsonValueFromKeyPath(rootData, keyPath);

    const handleActivate = () => {
      let value = '';
      if (resolvedValue === null || resolvedValue === undefined) {
        value = '';
      } else if (
        typeof resolvedValue === 'string' ||
        typeof resolvedValue === 'number' ||
        typeof resolvedValue === 'boolean'
      ) {
        value = String(resolvedValue);
      } else {
        try {
          value = JSON.stringify(resolvedValue, null, 2);
        } catch {
          value = String(resolvedValue);
        }
      }

      const endpointName = extractEndpointNameFromUrlPattern(urlPattern);
      const namePrefix = endpointName || contextLabel || '';
      const ruleName = namePrefix ? `${namePrefix}: ${path}` : path;

      const normalizedTarget =
        targetHint === 'response' || targetHint === 'both' ? targetHint : 'request';

      const seed = {
        kind: 'jsonPath',
        path,
        valueType: 'string',
        value,
        name: ruleName,
        url: typeof urlPattern === 'string' ? urlPattern : '',
        target: normalizedTarget
      };

      onCreateJsonPathRule(seed);
    };

    return (
      <JsonTreeClickableLabel
        labelText={labelText}
        path={path}
        onActivate={handleActivate}
      />
    );
  };
};

const formatMetadataValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const extractBlockedPatterns = (payload) => {
  if (!payload) return [];
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.blockedRules)
      ? payload.blockedRules
      : Array.isArray(payload.blockedUrls)
        ? payload.blockedUrls
        : [];

  return list
    .map(entry => {
      if (!entry) return null;
      if (typeof entry === 'string') return entry;
      if (typeof entry === 'object' && typeof entry.url === 'string' && entry.url.trim()) {
        return entry.url.trim();
      }
      return null;
    })
    .filter((value, index, arr) => value && arr.indexOf(value) === index);
};

const HeaderList = ({ headers }) => {
  if (!headers || typeof headers !== 'object') {
    return (
      <div className="text-xs text-slate-400">No headers.</div>
    );
  }

  const entries = Object.entries(headers);
  if (!entries.length) {
    return (
      <div className="text-xs text-slate-400">No headers.</div>
    );
  }

  return (
    <div className="border border-[#2a2a2a] rounded bg-[#0f0f0f] divide-y divide-[#1e1e1e]">
      {entries.map(([key, rawValue]) => {
        const value = Array.isArray(rawValue)
          ? rawValue.join(', ')
          : String(rawValue);

        return (
          <div
            key={key}
            className="px-3 py-2 flex flex-col sm:flex-row sm:items-start gap-2"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 sm:w-48 flex-shrink-0">
              {key}
            </div>
            <div className="text-[11px] text-slate-200 font-mono break-all flex-1 leading-relaxed">
              {value}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const ConnectFramesSection = ({ title, frames, defaultCollapsed = true, log, onCreateJsonPathRule, phase = 'request' }) => {
  const frameList = useMemo(() => frames ?? [], [frames]);
  const frameCount = frameList.length;
  const [timelineView, setTimelineView] = useState('compact');
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [frameViewMode, setFrameViewMode] = useState('json'); // 'json' | 'raw'

  const informativeIndex = useMemo(() => {
    if (!frameList.length) return 0;

    return [...frameList]
      .map((frame, idx) => ({ frame, idx }))
      .reverse()
      .find(({ frame }) => {
        if (frame.json && Object.keys(frame.json).length > 0) return true;
        if (frame.preview && frame.preview.trim().length > 0) return true;
        if (frame.dataBase64 && frame.dataBase64.length > 0) return true;
        return false;
      })?.idx ?? (frameList.length - 1);
  }, [frameList]);

  const [selectedFrameIdx, setSelectedFrameIdx] = useState(() => informativeIndex);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [openFrameStates, setOpenFrameStates] = useState({});

  useEffect(() => {
    if (informativeIndex != null && informativeIndex >= 0 && informativeIndex < frameList.length) {
      setSelectedFrameIdx(informativeIndex);
    }
  }, [informativeIndex, frameList.length]);

  useEffect(() => {
    setOpenFrameStates({});
  }, [frameList]);

  const summarizeFrame = (frame) => {
    if (!frame) return '';

    if (frame.preview && frame.preview.trim()) {
      return frame.preview.trim();
    }
    if (frame.note) {
      return frame.note;
    }
    if (typeof frame.length === 'number') {
      return `Binary frame (${frame.length} bytes)`;
    }
    return '';
  };

  const toggleTimelineView = () => {
    setTimelineView(prev => {
      if (prev === 'compact') return 'expanded';
      if (prev === 'expanded') return 'full';
      return 'compact';
    });
  };

  const timelineButtonLabel = timelineView === 'compact'
    ? 'Expand'
    : timelineView === 'expanded'
      ? 'Show all'
      : 'Collapse';

  const timelineHeightClass = timelineView === 'compact'
    ? 'max-h-[1200px]'
    : timelineView === 'expanded'
      ? 'max-h-[4000px]'
      : 'max-h-none';

  const summaryHeightClass = timelineView === 'compact'
    ? 'max-h-[640px]'
    : timelineView === 'expanded'
      ? 'max-h-[1500px]'
      : 'max-h-none';

  if (!frameList.length) {
    return (
      <details className="bg-[#0f0f0f] border border-[#2a2a2a] rounded" open={!defaultCollapsed}>
        <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 flex items-center justify-between">
          <span>{title}</span>
          <span className="text-slate-600">(empty)</span>
        </summary>
      </details>
    );
  }

  const anyJsonFrames = frameList.some((frame) => frame && frame.json && Object.keys(frame.json).length > 0);

  const renderFrameCard = (frame, highlight = false, viewMode = 'json') => (
    <div
      key={`detail-${frame.index}-${frame.length}`}
      className={`rounded border border-[#2a2a2a] ${highlight ? 'bg-[#141414]' : 'bg-[#0f0f0f]'} p-2 text-xs text-slate-300 space-y-2`}
    >
      <div className="flex flex-wrap gap-3">
        <span><span className="text-slate-500">Index:</span> {frame.index}</span>
        <span><span className="text-slate-500">Length:</span> {frame.length}</span>
        <span><span className="text-slate-500">Compressed:</span> {frame.compressed ? 'Yes' : 'No'}</span>
        <span><span className="text-slate-500">End Stream:</span> {frame.endStream ? 'Yes' : 'No'}</span>
      </div>
      {frame.error && (
        <div className="text-red-400">Error: {frame.error}</div>
      )}
      {viewMode === 'json' && frame.json ? (
        <div className="bg-[#151515] rounded p-2 text-[11px] text-slate-200 overflow-x-auto">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
            JSON payload
          </div>
          <JSONTree
            data={frame.json}
            theme={jsonTreeTheme}
            invertTheme={false}
            hideRoot={false}
            shouldExpandNodeInitially={shouldExpandJsonTreeAll}
            valueRenderer={renderJsonValue}
            labelRenderer={createJsonTreeLabelRenderer(
              onCreateJsonPathRule,
              `${title || 'Connect'} frame #${frame.index}`,
              log?.fullUrl || log?.url || '',
              frame.json,
              phase
            )}
          />
        </div>
      ) : frame.preview ? (
        <pre className="bg-[#151515] rounded p-2 whitespace-pre-wrap break-words text-slate-200 overflow-x-auto">
          {frame.preview}
        </pre>
      ) : (
        <div className="text-slate-500">
          Preview unavailable.
          {typeof frame.length === 'number' && (
            <span>{` Binary frame (${frame.length} bytes).`}</span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <details
      className="bg-[#0f0f0f] border border-[#2a2a2a] rounded"
      open={!isCollapsed}
      onToggle={(event) => {
        if (event.currentTarget !== event.target) return;
        setIsCollapsed(!event.currentTarget.open);
      }}
    >
      <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200 flex items-center justify-between">
        <span>{title}</span>
        <span className="text-slate-500">{frameCount} frame{frameCount === 1 ? '' : 's'}</span>
      </summary>

      {!isCollapsed && (
        <div className="space-y-3 px-3 pb-3 pt-2">
          <div className={`space-y-1 overflow-y-auto ${timelineHeightClass}`}>
            {frameList.map((frame, idx) => {
              const summary = summarizeFrame(frame);
              const highlight = idx === informativeIndex;
              const isFirstVisibleFrame = idx === 0;
              const hasJson = frame && frame.json && Object.keys(frame.json).length > 0;
              const frameLabel = `Frame ${frame.index}${frame.endStream ? ' • End' : ''}${frame.compressed ? ' • Compressed' : ''}`;
              const manyFrames = frameCount > 3;
              const frameKey = `${frame.index}-${frame.length}-${idx}`;
              const isFrameOpen = !manyFrames || !!openFrameStates[frameKey];

              return (
                <div
                  key={`summary-${frame.index}-${frame.length}`}
                  className={`rounded border border-[#2a2a2a] ${highlight ? 'bg-[#141414]' : 'bg-[#0f0f0f]'} p-2 text-xs text-slate-300`}
                >
                  <details
                    open={isFrameOpen}
                    onToggle={manyFrames ? (event) => {
                      const isOpen = event.target.open;
                      setOpenFrameStates(prev => ({
                        ...prev,
                        [frameKey]: isOpen
                      }));
                    } : undefined}
                  >
                    <summary className="cursor-pointer list-none">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="font-semibold text-slate-200">{frameLabel}</span>
                        <div className="flex items-center gap-3 text-slate-500">
                          <span>{frame.length} bytes</span>
                          {isFirstVisibleFrame && (
                            <button
                              type="button"
                              onClick={toggleTimelineView}
                              className="text-blue-400 hover:text-blue-200 transition-colors"
                            >
                              {timelineButtonLabel}
                            </button>
                          )}
                        </div>
                      </div>
                    </summary>

                    {isFrameOpen && (
                      <div className="mt-1">
                        {hasJson ? (
                          <div className={`text-slate-200 overflow-y-auto ${summaryHeightClass}`}>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                              Decoded Protobuf JSON
                            </div>
                            <div className="bg-[#0f0f0f] rounded px-3 py-2 border border-[#2a2a2a]">
                              <JSONTree
                                data={frame.json}
                                theme={jsonTreeTheme}
                                invertTheme={false}
                                hideRoot={false}
                                shouldExpandNodeInitially={shouldExpandJsonTreeAll}
                                valueRenderer={renderJsonValue}
                                labelRenderer={createJsonTreeLabelRenderer(
                                  onCreateJsonPathRule,
                                  `${title || 'Connect'} frame #${frame.index}`,
                                  log?.fullUrl || log?.url || '',
                                  frame.json,
                                  phase
                                )}
                              />
                            </div>
                          </div>
                        ) : summary ? (
                          <div className={`text-slate-400 whitespace-pre-wrap break-words overflow-y-auto ${summaryHeightClass}`}>
                            {summary}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </details>
                </div>
              );
            })}
          </div>

          <details
            className="bg-[#0f0f0f] border border-[#2a2a2a] rounded"
            open={detailsOpen}
            onToggle={(event) => setDetailsOpen(event.target.open)}
          >
            <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
              Show full frame details
            </summary>
            {detailsOpen && (
              <div className="space-y-2 px-3 pb-3 pt-2">
                {anyJsonFrames && (
                  <div className="flex items-center justify-end gap-2 mb-2 text-[11px] text-slate-400">
                    <span className="uppercase tracking-wide text-slate-500">View:</span>
                    <button
                      type="button"
                      onClick={() => setFrameViewMode('json')}
                      className={`px-2 py-1 rounded border text-xs transition-colors ${
                        frameViewMode === 'json'
                          ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                          : 'border-[#2a2a2a] bg-[#0a0a0a] text-slate-400 hover:border-blue-500 hover:text-blue-300'
                      }`}
                    >
                      JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => setFrameViewMode('raw')}
                      className={`px-2 py-1 rounded border text-xs transition-colors ${
                        frameViewMode === 'raw'
                          ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                          : 'border-[#2a2a2a] bg-[#0a0a0a] text-slate-400 hover:border-blue-500 hover:text-blue-300'
                      }`}
                    >
                      Raw
                    </button>
                  </div>
                )}

                <div className="flex flex-col md:flex-row gap-2">
                  <div className="md:w-64 max-h-64 overflow-y-auto space-y-1 border-b md:border-b-0 md:border-r border-[#2a2a2a] pb-2 md:pb-0 md:pr-2">
                    {frameList.map((frame, idx) => {
                      const isSelected = idx === selectedFrameIdx;
                      const label = `#${frame.index} • ${frame.length} bytes${frame.endStream ? ' • End' : ''}${frame.compressed ? ' • Compressed' : ''}`;
                      const hasJson = frame && frame.json && Object.keys(frame.json).length > 0;

                      return (
                        <button
                          key={`selector-${frame.index}-${frame.length}`}
                          type="button"
                          onClick={() => setSelectedFrameIdx(idx)}
                          className={`w-full text-left px-2 py-1 rounded text-[11px] border transition-colors ${
                            isSelected
                              ? 'border-blue-500 bg-blue-600/20 text-blue-200'
                              : 'border-[#2a2a2a] bg-[#050505] text-slate-300 hover:border-blue-500 hover:text-blue-200'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">{label}</span>
                            {hasJson && (
                              <span className="ml-2 text-[9px] uppercase tracking-wide text-emerald-400">JSON</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex-1 min-w-0">
                    {selectedFrameIdx != null && selectedFrameIdx >= 0 && selectedFrameIdx < frameList.length ? (
                      renderFrameCard(frameList[selectedFrameIdx], selectedFrameIdx === informativeIndex, frameViewMode)
                    ) : (
                      <div className="text-[11px] text-slate-500">Select a frame to view its details.</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </details>
        </div>
      )}
    </details>
  );
};

/**
 * Request log viewer with filters, infinite scroll and rich request/response inspection.
 *
 * @param {Object} props
 * @param {(count: number) => void} [props.onFilteredCountChange] Called when the total filtered log count changes.
 * @param {(exportFn: () => Promise<void>) => void} [props.onExportLogs] Receives a function the parent can call to export logs.
 * @param {number|string} [props.refreshToken] Changing this value forces an immediate refetch of logs.
 * @param {(seed: Object) => void} [props.onCreateJsonPathRule] Invoked when the user creates a JSONPath edit rule from a JSON tree.
 */
function RequestLogs({ onFilteredCountChange, onExportLogs, refreshToken, onCreateJsonPathRule }) {
  const { modalState, closeModal, showPrompt, showAlert } = useModal();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [hasCompletedInitialFetch, setHasCompletedInitialFetch] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(0);
  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem('proxyFilters_searchTerm') || '');
  const [requestBodySearch, setRequestBodySearch] = useState('');
  const [responseSearchTerm, setResponseSearchTerm] = useState('');
  const [appliedSearchTerm, setAppliedSearchTerm] = useState(() => localStorage.getItem('proxyFilters_searchTerm') || '');
  const [appliedRequestBodySearch, setAppliedRequestBodySearch] = useState('');
  const [appliedResponseSearchTerm, setAppliedResponseSearchTerm] = useState('');

  const [requestRewrittenOnly, setRequestRewrittenOnly] = useState(() => {
    try {
      const saved = localStorage.getItem('proxyFilters_requestRewrittenOnly');
      return saved ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });

  const [responseRewrittenOnly, setResponseRewrittenOnly] = useState(() => {
    try {
      const saved = localStorage.getItem('proxyFilters_responseRewrittenOnly');
      return saved ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });
  
  // Load filters from localStorage or use defaults (only transport protocols)
  const [selectedSources, setSelectedSources] = useState(() => {
    const saved = localStorage.getItem('proxyFilters_sources');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Migrate old filters: replace 'tunnel' and 'direct' with 'websocket', keep only protocols
      const protocols = ['proxied', 'mitm', 'websocket'];
      const filtered = parsed.filter(s => protocols.includes(s));
      // Ensure websocket is included if tunnel or direct were present
      if ((parsed.includes('tunnel') || parsed.includes('direct')) && !filtered.includes('websocket')) {
        filtered.push('websocket');
      }
      // If empty after migration, use defaults
      return filtered.length > 0 ? filtered : ['proxied', 'mitm', 'websocket'];
    }
    return ['proxied', 'mitm', 'websocket'];
  });
  
  const [selectedMethods, setSelectedMethods] = useState(() => {
    const saved = localStorage.getItem('proxyFilters_methods');
    return saved ? JSON.parse(saved) : ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']; // OPTIONS, HEAD, and CONNECT disabled by default
  });
  
  const [selectedFileTypes, setSelectedFileTypes] = useState(() => {
    const saved = localStorage.getItem('proxyFilters_fileTypes');
    return saved ? JSON.parse(saved) : ['json', 'html', 'css', 'js', 'image', 'video', 'audio', 'font', 'other'];
  });
  
  const [expandedLog, setExpandedLog] = useState(null);
  const [showSourcesDropdown, setShowSourcesDropdown] = useState(false);
  const [showMethodsDropdown, setShowMethodsDropdown] = useState(false);
  const [showFileTypesDropdown, setShowFileTypesDropdown] = useState(false);
  const [blockedUrls, setBlockedUrls] = useState([]);
  const [showWsConnections, setShowWsConnections] = useState(() => {
    const saved = localStorage.getItem('proxyFilters_showWsConnections');
    return saved ? JSON.parse(saved) : false; // Default: hide connections
  });
  const observerTarget = React.useRef(null);
  const activeFetchControllerRef = useRef(null);
  const activeRequestIdRef = useRef(0);

  const [showSearchHelp, setShowSearchHelp] = useState(false);
  const [searchHelpPosition, setSearchHelpPosition] = useState({ top: 0, left: 0 });
  const searchHelpAnchorRef = React.useRef(null);
  const searchHelpHideTimeoutRef = React.useRef(null);

  const [isDebouncingFilters, setIsDebouncingFilters] = useState(false);
  const [isRefetchingFilters, setIsRefetchingFilters] = useState(false);

  const toggleMethod = (method) => {
    setSelectedMethods(prev => 
      prev.includes(method) 
        ? prev.filter(m => m !== method)
        : [...prev, method]
    );
  };

  const toggleSource = (source) => {
    setSelectedSources(prev => 
      prev.includes(source) 
        ? prev.filter(s => s !== source)
        : [...prev, source]
    );
  };

  const toggleFileType = (fileType) => {
    setSelectedFileTypes(prev => 
      prev.includes(fileType) 
        ? prev.filter(f => f !== fileType)
        : [...prev, fileType]
    );
  };

  const updateSearchHelpPosition = useCallback(() => {
    const el = searchHelpAnchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const tooltipWidth = 256; // w-64
    const margin = 8;
    const top = rect.bottom + margin;
    const left = Math.max(8, rect.right - tooltipWidth);
    setSearchHelpPosition({ top, left });
  }, []);

  const cancelHideSearchHelp = useCallback(() => {
    if (searchHelpHideTimeoutRef.current) {
      clearTimeout(searchHelpHideTimeoutRef.current);
      searchHelpHideTimeoutRef.current = null;
    }
  }, []);

  const scheduleHideSearchHelp = useCallback(() => {
    cancelHideSearchHelp();
    searchHelpHideTimeoutRef.current = setTimeout(() => {
      setShowSearchHelp(false);
    }, 150);
  }, [cancelHideSearchHelp]);

  const fetchLogs = useCallback(async (offset = 0, append = false) => {
    // Cancel any in-flight request before starting a new one
    if (activeFetchControllerRef.current) {
      activeFetchControllerRef.current.abort();
    }

    const controller = new AbortController();
    activeFetchControllerRef.current = controller;

    const requestId = ++activeRequestIdRef.current;
    setLoading(true);

    try {
      const params = new URLSearchParams();
      params.set('offset', String(offset));
      params.set('limit', String(PAGE_SIZE));

      if (searchTerm) params.set('search', searchTerm);
      if (requestBodySearch) params.set('requestSearch', requestBodySearch);
      if (responseSearchTerm) params.set('responseSearch', responseSearchTerm);
      if (requestRewrittenOnly) params.set('requestRewrittenOnly', 'true');
      if (responseRewrittenOnly) params.set('responseRewrittenOnly', 'true');
      if (selectedSources.length) params.set('sources', selectedSources.join(','));
      if (selectedMethods.length) params.set('methods', selectedMethods.join(','));
      if (selectedFileTypes.length) params.set('fileTypes', selectedFileTypes.join(','));
      params.set('showWsConnections', String(showWsConnections));

      const response = await fetch(`http://localhost:8080/api/logs?${params.toString()}` , {
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Ignore stale responses if a newer request has been issued
      if (requestId !== activeRequestIdRef.current) {
        return;
      }

      if (append) {
        setLogs(prev => [...prev, ...(data.items || [])]);
      } else {
        setLogs(data.items || []);
      }

      setTotal(data.total || 0);
      setHasMore(data.hasMore || false);

      if (!append && offset === 0) {
        setHasCompletedInitialFetch(true);
        setAppliedSearchTerm(searchTerm);
        setAppliedRequestBodySearch(requestBodySearch);
        setAppliedResponseSearchTerm(responseSearchTerm);
        setIsRefetchingFilters(false);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        // Previous request was cancelled in favour of a newer one
        return;
      }
      console.error('Error fetching logs:', error);
    } finally {
      // Only clear loading state if this is the latest controller
      if (activeFetchControllerRef.current === controller) {
        activeFetchControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [searchTerm, requestBodySearch, responseSearchTerm, selectedSources, selectedMethods, selectedFileTypes, showWsConnections, requestRewrittenOnly, responseRewrittenOnly]);

  const loadMore = useCallback(() => {
    if (loading) return;
    if (!hasMore) return;
    if (isDebouncingFilters || isRefetchingFilters) return;

    fetchLogs(logs.length, true);
  }, [logs.length, loading, hasMore, isDebouncingFilters, isRefetchingFilters, fetchLogs]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_sources', JSON.stringify(selectedSources));
  }, [selectedSources]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_searchTerm', searchTerm);
  }, [searchTerm]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_requestRewrittenOnly', JSON.stringify(requestRewrittenOnly));
  }, [requestRewrittenOnly]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_responseRewrittenOnly', JSON.stringify(responseRewrittenOnly));
  }, [responseRewrittenOnly]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_methods', JSON.stringify(selectedMethods));
  }, [selectedMethods]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_fileTypes', JSON.stringify(selectedFileTypes));
  }, [selectedFileTypes]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_showWsConnections', JSON.stringify(showWsConnections));
  }, [showWsConnections]);

  // Close dropdowns when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('.dropdown-container')) {
        setShowSourcesDropdown(false);
        setShowMethodsDropdown(false);
        setShowFileTypesDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load blocked URLs on mount
  useEffect(() => {
    fetch('http://localhost:8080/api/blocked')
      .then(res => res.json())
      .then(data => setBlockedUrls(extractBlockedPatterns(data)))
      .catch(err => console.error('Error loading blocked URLs:', err));
  }, []);

  // Initial fetch and refetch on TEXT search changes (debounced)
  useEffect(() => {
    setIsDebouncingFilters(true);
    setIsRefetchingFilters(true);
    setLogs([]);

    const timeoutId = setTimeout(() => {
      setIsDebouncingFilters(false);
      fetchLogs(0, false);
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [searchTerm, requestBodySearch, responseSearchTerm, fetchLogs]);

  // Refetch immediately on non-text filter changes (no debounce)
  useEffect(() => {
    setIsRefetchingFilters(true);
    setLogs([]);
    fetchLogs(0, false);
  }, [selectedSources, selectedMethods, selectedFileTypes, showWsConnections, requestRewrittenOnly, responseRewrittenOnly, fetchLogs]);

  // Refetch on explicit refreshToken changes (e.g. Clear logs) without debounce
  useEffect(() => {
    // Treat clear-logs as a hard reset of the current result set
    setIsRefetchingFilters(true);
    setLogs([]);
    fetchLogs(0, false);
  }, [refreshToken, fetchLogs]);

  // Infinite scroll observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );

    const currentTarget = observerTarget.current;
    if (currentTarget) {
      observer.observe(currentTarget);
    }

    return () => {
      if (currentTarget) {
        observer.unobserve(currentTarget);
      }
    };
  }, [hasMore, loading, loadMore]);

  const urlMatchesBlockedPattern = useCallback((targetUrl) => {
    if (!targetUrl) return false;
    return blockedUrls.some(pattern => typeof pattern === 'string' && targetUrl.includes(pattern));
  }, [blockedUrls]);

  const toggleBlockUrl = async (url) => {
    // Check if any blocked URL contains this URL (partial match)
    const matchingBlockedUrl = blockedUrls.find(blockedUrl => {
      if (typeof blockedUrl !== 'string') return false;
      return url.includes(blockedUrl) || blockedUrl.includes(url);
    });
    
    if (matchingBlockedUrl) {
      // URL is already blocked (or contains a blocked pattern) - unblock it
      const action = 'remove';
      try {
        const response = await fetch('http://localhost:8080/api/blocked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: matchingBlockedUrl, action })
        });
        
        if (response.ok) {
          const data = await response.json();
          setBlockedUrls(extractBlockedPatterns(data));
        }
      } catch (error) {
        console.error('Error unblocking URL:', error);
      }
    } else {
      // URL is not blocked - show modal to edit and make it more generic
      const editedUrl = await showPrompt(
        'Block URL Pattern',
        'Edit the URL pattern to block (you can make it more generic):',
        url,
        'Enter URL pattern...',
        [
          'Block domain: facebook.com',
          'Block path: /api/tracking',
          'Block specific: https://example.com/ads/banner.js'
        ]
      );
      
      if (editedUrl && editedUrl.trim()) {
        const action = 'add';
        try {
          const response = await fetch('http://localhost:8080/api/blocked', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              url: editedUrl.trim(), 
              action,
              name: '', // Nome vuoto, può essere modificato dopo
              enabled: true
            })
          });
          
          if (response.ok) {
            const data = await response.json();
            setBlockedUrls(extractBlockedPatterns(data));
          }
        } catch (error) {
          console.error('Error blocking URL:', error);
        }
      }
    }
  };

  // Logs are already filtered server-side, just use them directly
  const filteredLogs = logs;

  useEffect(() => {
    if (isDebouncingFilters) return;
    if (loading) return;
    if (filteredLogs.length >= PAGE_SIZE) return;

    const intervalId = setInterval(() => {
      if (!loading && !isDebouncingFilters) {
        fetchLogs(0, false);
      }
    }, 2000);

    return () => clearInterval(intervalId);
  }, [filteredLogs.length, loading, isDebouncingFilters, fetchLogs]);

  const exportLogs = useCallback(async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `proxy-logs-${timestamp}.json`;

    try {
      const params = new URLSearchParams();
      params.set('offset', '0');
      params.set('limit', String(5000)); // export up to MAX_LOG_ENTRIES

      if (searchTerm) params.set('search', searchTerm);
      if (requestBodySearch) params.set('requestSearch', requestBodySearch);
      if (responseSearchTerm) params.set('responseSearch', responseSearchTerm);
      if (requestRewrittenOnly) params.set('requestRewrittenOnly', 'true');
      if (responseRewrittenOnly) params.set('responseRewrittenOnly', 'true');
      if (selectedSources.length) params.set('sources', selectedSources.join(','));
      if (selectedMethods.length) params.set('methods', selectedMethods.join(','));
      if (selectedFileTypes.length) params.set('fileTypes', selectedFileTypes.join(','));
      params.set('showWsConnections', String(showWsConnections));

      const response = await fetch(`http://localhost:8080/api/logs/export?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Export failed with status ${response.status}`);
      }

      const data = await response.json();
      const items = data.items || [];

      const dataStr = JSON.stringify(items, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);

      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error exporting logs:', error);
    }
  }, [
    searchTerm,
    requestBodySearch,
    responseSearchTerm,
    selectedSources,
    selectedMethods,
    selectedFileTypes,
    showWsConnections
  ]);

  // Notify parent of filtered count (use total from server)
  useEffect(() => {
    if (onFilteredCountChange) {
      onFilteredCountChange(total);
    }
  }, [total, onFilteredCountChange]);

  // Provide export function to parent
  useEffect(() => {
    if (onExportLogs) {
      onExportLogs(() => exportLogs);
    }
  }, [onExportLogs, filteredLogs, exportLogs]);

  const getSourceIcon = (source) => {
    switch (source) {
      case 'local':
        return <HardDrive className="w-4 h-4 text-green-400" />;
      case 'proxied':
        return <Globe className="w-4 h-4 text-purple-400" />;
      case 'websocket':
        return <Globe className="w-4 h-4 text-yellow-400" />;
      case 'tunnel':
        return <Globe className="w-4 h-4 text-blue-400" />;
      case 'blocked':
        return <ShieldAlert className="w-4 h-4 text-orange-400" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-400" />;
      default:
        return <LinkIcon className="w-4 h-4 text-slate-400" />;
    }
  };

  const getSourceBadge = (source) => {
    const badges = {
      local: 'bg-green-500/20 text-green-400 border-green-500/30',
      proxied: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
      mitm: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
      tunnel: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
      blocked: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
      error: 'bg-red-500/20 text-red-400 border-red-500/30',
      websocket: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    };
    return badges[source] || badges.websocket;
  };

  const getMethodBadge = (method) => {
    const badges = {
      GET: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
      POST: 'bg-green-500/20 text-green-400 border-green-500/30',
      PUT: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
      DELETE: 'bg-red-500/20 text-red-400 border-red-500/30',
      PATCH: 'bg-orange-500/20 text-orange-400 border-orange-500/30'
    };
    return badges[method] || 'bg-slate-500/20 text-slate-400 border-slate-500/30';
  };

  const renderRawDataSection = (title, preview, base64, options = {}) => {
    const { collapsePreview = false } = options;
    if (!preview && !base64) return null;

    return (
      <div className="mt-3 space-y-2">
        <div className="text-xs font-semibold text-slate-400">{title}</div>
        {preview && (
          collapsePreview ? (
            <details className="bg-[#0f0f0f] rounded border border-[#2a2a2a] overflow-hidden">
              <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
                Show raw preview ({preview.length} characters)
              </summary>
              <pre className="px-3 pb-3 text-xs text-slate-200 overflow-x-auto max-h-60 whitespace-pre-wrap">
                {preview}
              </pre>
            </details>
          ) : (
            <pre className="bg-[#0f0f0f] border border-[#2a2a2a] p-3 rounded text-xs text-slate-200 overflow-x-auto max-h-60 whitespace-pre-wrap">
              {preview}
            </pre>
          )
        )}
        {base64 && (
          <details className="bg-[#0f0f0f] rounded border border-[#2a2a2a] overflow-hidden">
            <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
              Show Base64 ({Math.round(base64.length / 4)} bytes)
            </summary>
            <pre className="px-3 pb-3 text-xs text-slate-300 break-all whitespace-pre-wrap">
              {base64}
            </pre>
          </details>
        )}
      </div>
    );
  };

  const buildConnectReadablePreview = (connectData) => {
    if (!connectData || typeof connectData !== 'object') return '';

    const framesSource = Array.isArray(connectData.originalFrames) && connectData.originalFrames.length
      ? connectData.originalFrames
      : (Array.isArray(connectData.frames) ? connectData.frames : []);

    const frames = Array.isArray(framesSource) ? framesSource : [];
    if (!frames.length) return '';

    const jsonFrames = frames.filter((frame) => {
      if (!frame || !frame.json || typeof frame.json !== 'object') return false;
      try {
        return Object.keys(frame.json).length > 0;
      } catch {
        return false;
      }
    });

    // Prefer a single JSON frame as the most readable view
    if (jsonFrames.length === 1) {
      try {
        return JSON.stringify(jsonFrames[0].json, null, 2);
      } catch {
        // fall through
      }
    }

    // If there are a few JSON frames, aggregate them into a small object
    if (jsonFrames.length > 1 && jsonFrames.length <= 8) {
      const aggregate = {};
      for (const frame of jsonFrames) {
        const key = typeof frame.index === 'number' ? `frame ${frame.index}` : 'frame';
        aggregate[key] = frame.json;
      }
      try {
        return JSON.stringify(aggregate, null, 2);
      } catch {
        // fall through
      }
    }

    // Fallback: join textual previews for each frame
    const segments = [];

    for (const frame of frames) {
      if (!frame) continue;

      const parts = [];
      if (typeof frame.index === 'number') {
        parts.push(`frame ${frame.index}`);
      }
      if (typeof frame.length === 'number') {
        parts.push(`${frame.length} bytes`);
      }
      const header = parts.length ? `# ${parts.join('  b7 ')}` : '';

      const body =
        (typeof frame.preview === 'string' && frame.preview.trim()) ||
        (typeof frame.note === 'string' && frame.note.trim()) ||
        '';

      if (!body) continue;

      if (header) segments.push(header);
      segments.push(body);
    }

    return segments.join('\n\n');
  };

  const renderConnectFrames = (connectData, isResponse = false, log = null, onCreateJsonPathRule) => {
    if (!connectData) return null;
    const beforeFrames = connectData.originalFrames ?? [];
    const afterFrames = connectData.frames ?? [];

    return (
      <div className="space-y-2">
        <ConnectFramesSection
          title="Timeline (after rewrite)"
          frames={afterFrames}
          defaultCollapsed
          log={log}
          onCreateJsonPathRule={onCreateJsonPathRule}
          phase={isResponse ? 'response' : 'request'}
        />
        <ConnectFramesSection
          title="Timeline (before rewrite)"
          frames={beforeFrames}
          defaultCollapsed
          log={log}
          onCreateJsonPathRule={onCreateJsonPathRule}
          phase={isResponse ? 'response' : 'request'}
        />
      </div>
    );
  };

  const getContentTypeInfo = (log) => {
    const fileType = log.fileType || 'other';

    switch (fileType) {
      case 'json':
        return { icon: FileJson, label: 'JSON', color: 'text-yellow-400' };
      case 'html':
        return { icon: FileText, label: 'HTML', color: 'text-orange-400' };
      case 'css':
        return { icon: FileCode, label: 'CSS', color: 'text-blue-400' };
      case 'js':
        return { icon: FileCode, label: 'JS', color: 'text-amber-400' };
      case 'image':
        return { icon: Image, label: 'IMG', color: 'text-purple-400' };
      case 'video':
        return { icon: Film, label: 'VIDEO', color: 'text-pink-400' };
      case 'audio':
        return { icon: Music, label: 'AUDIO', color: 'text-green-400' };
      case 'font':
        return { icon: FileText, label: 'FONT', color: 'text-pink-400' };
      default:
        return { icon: File, label: 'FILE', color: 'text-slate-400' };
    }
  };

  const isSearchParamsDirty =
    searchTerm !== appliedSearchTerm ||
    requestBodySearch !== appliedRequestBodySearch ||
    responseSearchTerm !== appliedResponseSearchTerm;

  const hasPendingFilterChange = isSearchParamsDirty || isRefetchingFilters;

  const isSearching = isDebouncingFilters || (loading && hasPendingFilterChange);

  const showInitialLoading = !hasCompletedInitialFetch && (loading || isDebouncingFilters);
  const showSearchLoading = hasCompletedInitialFetch && isSearching;

  return (
    <>
      <Modal
        isOpen={modalState.isOpen}
        onClose={closeModal}
        title={modalState.title}
        message={modalState.message}
        type={modalState.type}
        onConfirm={modalState.onConfirm}
        showInput={modalState.showInput}
        inputValue={modalState.inputValue}
        inputPlaceholder={modalState.inputPlaceholder}
        examples={modalState.examples}
      />
      
      <div className="space-y-4">
      {/* Filters */}
      <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a] space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
          {/* Search URL/Request */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search URL..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-8 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div
              className="absolute right-2.5 top-1/2 transform -translate-y-1/2"
              ref={searchHelpAnchorRef}
              onMouseEnter={() => {
                cancelHideSearchHelp();
                updateSearchHelpPosition();
                setShowSearchHelp(true);
              }}
              onMouseLeave={scheduleHideSearchHelp}
            >
              <HelpCircle className="w-3.5 h-3.5 text-slate-500 cursor-help hover:text-slate-300" />
            </div>
          </div>
          {showSearchHelp && createPortal(
            <div
              className="fixed w-80 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-[11px] text-slate-300 shadow-2xl"
              style={{ zIndex: 99999, top: searchHelpPosition.top, left: searchHelpPosition.left }}
              onMouseEnter={cancelHideSearchHelp}
              onMouseLeave={scheduleHideSearchHelp}
            >
              <div className="font-semibold mb-2">Search syntax:</div>
              <div className="space-y-1">
                <div><code className="text-blue-400">;</code> - AND (all terms in a group)</div>
                <div><code className="text-red-400">!</code> - NOT (exclude term)</div>
                <div><code className="text-purple-400">||</code> - OR (between groups)</div>
              </div>
              <div className="mt-2 text-slate-400 space-y-1">
                <div className="whitespace-nowrap">
                  Eg (AND/NOT):{' '}
                  <code>
                    <span className="text-red-400">!</span>facebook
                    <span className="text-blue-400">;</span>{' '}
                    <span className="text-red-400">!</span>scontent
                    <span className="text-blue-400">;</span>{' '}
                    api
                  </code>
                </div>
                <div className="whitespace-nowrap">
                  Eg (OR):{' '}
                  <code>
                    api<span className="text-blue-400">;</span>{' '}
                    <span className="text-red-400">!</span>facebook{' '}
                    <span className="text-purple-400">||</span>{' '}
                    users<span className="text-blue-400">;</span>{' '}
                    <span className="text-red-400">!</span>tracking
                  </code>
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Search Request Body */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-yellow-400" />
              <input
                type="text"
                placeholder="Search in request..."
                value={requestBodySearch}
                onChange={(e) => setRequestBodySearch(e.target.value)}
                className="w-full pl-8 pr-2 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
              />
            </div>
            <div className="relative group/request-rewrites flex-shrink-0">
              <button
                type="button"
                onClick={() => setRequestRewrittenOnly(prev => !prev)}
                aria-pressed={requestRewrittenOnly}
                aria-label="Filter: only requests with rewrites"
                className={`inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                  requestRewrittenOnly
                    ? 'bg-yellow-600/20 border-yellow-500/60 text-yellow-300'
                    : 'bg-[#0a0a0a] border-[#2a2a2a] text-slate-400 hover:border-yellow-500 hover:text-yellow-300'
                }`}
              >
                <Info className="w-3.5 h-3.5" />
              </button>
              <div
                className="invisible group-hover/request-rewrites:visible absolute right-0 top-full mt-1 w-60 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-2 text-[11px] text-slate-300 shadow-2xl"
                style={{ zIndex: 99999 }}
              >
                <div className="text-[10px] font-semibold uppercase tracking-wide text-yellow-400 mb-1">
                  Request rewrites
                </div>
                <div>
                  Show only requests where rewrite rules were applied to the body or frames.
                </div>
              </div>
            </div>
          </div>

          {/* Search Response Body */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-green-400" />
              <input
                type="text"
                placeholder="Search in response..."
                value={responseSearchTerm}
                onChange={(e) => setResponseSearchTerm(e.target.value)}
                className="w-full pl-8 pr-2 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
            </div>
            <div className="relative group/response-rewrites flex-shrink-0">
              <button
                type="button"
                onClick={() => setResponseRewrittenOnly(prev => !prev)}
                aria-pressed={responseRewrittenOnly}
                aria-label="Filter: only responses with rewrites"
                className={`inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                  responseRewrittenOnly
                    ? 'bg-green-600/20 border-green-500/60 text-green-300'
                    : 'bg-[#0a0a0a] border-[#2a2a2a] text-slate-400 hover:border-green-500 hover:text-green-300'
                }`}
              >
                <Info className="w-3.5 h-3.5" />
              </button>
              <div
                className="invisible group-hover/response-rewrites:visible absolute right-0 top-full mt-1 w-60 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-2 text-[11px] text-slate-300 shadow-2xl"
                style={{ zIndex: 99999 }}
              >
                <div className="text-[10px] font-semibold uppercase tracking-wide text-green-400 mb-1">
                  Response rewrites
                </div>
                <div>
                  Show only responses where rewrite rules were applied to the body or frames.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Filter Dropdowns - Whitelist */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {/* Sources Dropdown */}
          <div className="relative dropdown-container">
            <button
              onClick={() => setShowSourcesDropdown(!showSourcesDropdown)}
              className="flex items-center gap-2 px-3 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-slate-400 hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-400 w-full"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>Sources ({selectedSources.length})</span>
              <ChevronDown className="w-3.5 h-3.5 ml-auto" />
            </button>
            
            {showSourcesDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl z-10 min-w-[160px]">
                {[
                  { key: 'proxied', label: 'HTTP' },
                  { key: 'mitm', label: 'HTTPS' },
                  { key: 'websocket', label: 'WebSocket' }
                ].map(source => {
                  const isSelected = selectedSources.includes(source.key);
                  return (
                    <label
                      key={source.key}
                      className="group flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] cursor-pointer text-sm text-slate-300 transition-colors"
                    >
                      <span
                        className={`w-4 h-4 rounded-md border flex items-center justify-center text-[10px] transition-colors ${
                          isSelected
                            ? 'bg-slate-100/10 border-slate-300 text-slate-100'
                            : 'bg-[#050508] border-[#2a2a2a] text-slate-500 group-hover:text-slate-200 group-hover:border-slate-400'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3" />}
                      </span>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSource(source.key)}
                        className="sr-only"
                      />
                      <span>{source.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Methods Dropdown */}
          <div className="relative dropdown-container">
            <button
              onClick={() => setShowMethodsDropdown(!showMethodsDropdown)}
              className="flex items-center gap-2 px-3 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-slate-400 hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-400 w-full"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>Methods ({selectedMethods.length})</span>
              <ChevronDown className="w-3.5 h-3.5 ml-auto" />
            </button>
            
            {showMethodsDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl z-10 min-w-[180px]">
                {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'CONNECT', 'OPTIONS', 'HEAD'].map(method => {
                  const isSelected = selectedMethods.includes(method);
                  return (
                    <label
                      key={method}
                      className="group flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] cursor-pointer text-sm text-slate-300 transition-colors"
                    >
                      <span
                        className={`w-4 h-4 rounded-md border flex items-center justify-center text-[10px] transition-colors ${
                          isSelected
                            ? 'bg-slate-100/10 border-slate-300 text-slate-100'
                            : 'bg-[#050508] border-[#2a2a2a] text-slate-500 group-hover:text-slate-200 group-hover:border-slate-400'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3" />}
                      </span>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleMethod(method)}
                        className="sr-only"
                      />
                      <span>{method}</span>
                    </label>
                  );
                })}
                <div className="border-t border-[#2a2a2a] my-1"></div>
                <label
                  className="group flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] cursor-pointer text-sm text-slate-300 transition-colors"
                >
                  <span
                    className={`w-4 h-4 rounded-md border flex items-center justify-center text-[10px] transition-colors ${
                      showWsConnections
                        ? 'bg-slate-100/10 border-slate-300 text-slate-100'
                        : 'bg-[#050508] border-[#2a2a2a] text-slate-500 group-hover:text-slate-200 group-hover:border-slate-400'
                    }`}
                  >
                    {showWsConnections && <Check className="w-3 h-3" />}
                  </span>
                  <input
                    type="checkbox"
                    checked={showWsConnections}
                    onChange={(e) => setShowWsConnections(e.target.checked)}
                    className="sr-only"
                  />
                  <span className="text-xs">WS Connection Status</span>
                </label>
              </div>
            )}
          </div>

          {/* File Types Dropdown */}
          <div className="relative dropdown-container">
            <button
              onClick={() => setShowFileTypesDropdown(!showFileTypesDropdown)}
              className="flex items-center gap-2 px-3 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-slate-400 hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-400 w-full"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>Types ({selectedFileTypes.length})</span>
              <ChevronDown className="w-3.5 h-3.5 ml-auto" />
            </button>
            
            {showFileTypesDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl z-10 min-w-[140px]">
                {[
                  { key: 'json', label: 'JSON' },
                  { key: 'html', label: 'HTML' },
                  { key: 'css', label: 'CSS' },
                  { key: 'js', label: 'JavaScript' },
                  { key: 'image', label: 'Images' },
                  { key: 'video', label: 'Video' },
                  { key: 'audio', label: 'Audio' },
                  { key: 'font', label: 'Font' },
                  { key: 'other', label: 'Other' }
                ].map(type => {
                  const isSelected = selectedFileTypes.includes(type.key);
                  return (
                    <label
                      key={type.key}
                      className="group flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] cursor-pointer text-sm text-slate-300 transition-colors"
                    >
                      <span
                        className={`w-4 h-4 rounded-md border flex items-center justify-center text-[10px] transition-colors ${
                          isSelected
                            ? 'bg-slate-100/10 border-slate-300 text-slate-100'
                            : 'bg-[#050508] border-[#2a2a2a] text-slate-500 group-hover:text-slate-200 group-hover:border-slate-400'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3" />}
                      </span>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleFileType(type.key)}
                        className="sr-only"
                      />
                      <span>{type.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Logs List */}
      <div className="space-y-2">
        {(showInitialLoading || showSearchLoading) && filteredLogs.length === 0 ? (
          <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] flex flex-col items-center justify-center text-center">
            <Spinner size="md" color="blue" />
            <p className="mt-3 text-sm text-slate-400">Loading requests...</p>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="bg-[#1a1a1a] rounded-lg p-8 border border-[#2a2a2a] text-center">
            <AlertCircle className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400">No requests found</p>
          </div>
        ) : (
          <>
          {filteredLogs.map((log) => (
            <div
              key={log.id}
              className="bg-[#1a1a1a] rounded-lg border border-[#2a2a2a] hover:border-slate-500/70 transition-colors"
            >
              <div
                className="p-4 cursor-pointer"
                onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-2 relative">
                      <div className="flex flex-wrap items-center gap-2">
                        {getSourceIcon(log.source)}
                        <span className={`px-2 py-1 rounded text-xs font-medium border ${getMethodBadge(log.method)}`}>
                          {log.method}
                        </span>
                        {log.direction && (() => {
                          // Extract domain from URL for WebSocket direction
                          let directionText = log.direction;
                          if (log.direction.includes('→')) {
                            try {
                              const url = new URL(log.fullUrl || log.url);
                              const domain = url.hostname;
                              directionText = log.direction.replace('server', domain).replace('client', 'client');
                            } catch {}
                          }
                          return (
                            <span className="px-2 py-1 rounded text-xs font-medium bg-slate-700/50 text-slate-300 border border-slate-600">
                              {directionText}
                            </span>
                          );
                        })()}
                        {/* Hide WEBSOCKET badge if method is WS */}
                        {log.method !== 'WS' && (
                          <span className={`px-2 py-1 rounded text-xs font-medium border ${getSourceBadge(log.source)}`}>
                            {log.source.toUpperCase()}
                          </span>
                        )}
                        {log.statusCode && (
                          <span className={`px-2 py-1 rounded text-xs font-medium border ${
                            log.statusCode >= 200 && log.statusCode < 300
                              ? 'bg-green-500/20 text-green-400 border-green-500/30'
                              : 'bg-red-500/20 text-red-400 border-red-500/30'
                          }`}>
                            {log.statusCode}
                          </span>
                        )}
                        {log.responseHeaders && (() => {
                          const contentInfo = getContentTypeInfo(log);
                          const ContentIcon = contentInfo.icon;
                          return (
                            <span className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border bg-slate-700/50 border-slate-600 ${contentInfo.color}`}>
                              <ContentIcon className="w-3 h-3" />
                              {contentInfo.label}
                            </span>
                          );
                        })()}
                        {Array.isArray(log.rewrites) && log.rewrites.length > 0 && (
                          <div className="relative inline-flex items-center group/rewrites">
                            <button
                              type="button"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400 hover:bg-emerald-500/20 focus:outline-none focus:ring-1 focus:ring-emerald-500/60"
                            >
                              <span className="text-[10px] uppercase tracking-wide text-emerald-400">Rewrites</span>
                              <span className="font-mono">{log.rewrites.length}</span>
                            </button>

                            <div
                              className="invisible group-hover/rewrites:visible absolute left-full top-1/2 transform -translate-y-1/2 ml-2 w-80 bg-[#050505] border border-[#2a2a2a] rounded-lg shadow-2xl p-3 text-[11px] text-slate-200"
                              style={{ zIndex: 99999 }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-2">
                                Applied rewrites
                              </div>

                              <ul className="space-y-1 max-h-48 overflow-y-auto">
                                {log.rewrites.map((entry) => {
                                  const displayName =
                                    (typeof entry.name === 'string' && entry.name.trim())
                                      ? entry.name.trim()
                                      : `Rule ${entry.id}`;

                                  const rawKind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
                                  const kindLabel =
                                    rawKind === 'jsonPath'
                                      ? 'JSONPath'
                                      : rawKind === 'text'
                                        ? 'Text'
                                        : rawKind || 'Rule';

                                  return (
                                    <li
                                      key={entry.id}
                                      className="border border-[#2a2a2a] rounded px-2 py-1"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="text-[11px] font-medium text-slate-100 truncate">
                                          {displayName}
                                        </span>
                                        <span className="text-[9px] uppercase tracking-wide text-slate-500">
                                          {kindLabel}
                                        </span>
                                      </div>
                                      {entry.url && (
                                        <div className="text-[10px] text-slate-500 truncate mt-0.5">
                                          {entry.url}
                                        </div>
                                      )}
                                      {entry.target && (
                                        <div className="text-[9px] text-slate-500 mt-0.5">
                                          Scope: {entry.target}
                                        </div>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <label
                          className="relative group/replace-action inline-flex items-center justify-center w-8 h-8 rounded-md bg-blue-600/15 border border-blue-500/60 text-blue-200 hover:bg-blue-600/30 hover:text-white cursor-pointer transition-colors"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="sr-only">Replace response with local file</span>
                          <input
                            type="file"
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files[0];
                              if (!file) return;

                              const formData = new FormData();
                              formData.append('file', file);
                              formData.append('url', log.fullUrl || log.url);

                              try {
                                const response = await fetch('http://localhost:8080/api/resources', {
                                  method: 'POST',
                                  body: formData
                                });

                                if (response.ok) {
                                  const message = `Ora ${log.fullUrl || log.url} will serve the local file.`;
                                  if (showAlert) {
                                    showAlert('Resource replaced successfully', message, 'info');
                                  } else {
                                    alert(`Resource replaced successfully!\n${message}`);
                                  }
                                } else {
                                  const message = 'Error uploading resource';
                                  if (showAlert) {
                                    showAlert('Upload failed', message, 'error');
                                  } else {
                                    alert(message);
                                  }
                                }
                              } catch (error) {
                                console.error('Error uploading resource:', error);
                                const message = 'Error during upload';
                                if (showAlert) {
                                  showAlert('Upload failed', message, 'error');
                                } else {
                                  alert(message);
                                }
                              }

                              e.target.value = '';
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
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleBlockUrl(log.fullUrl || log.url);
                          }}
                          className={`relative group/block-action inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                            urlMatchesBlockedPattern(log.fullUrl || log.url)
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
                              {urlMatchesBlockedPattern(log.fullUrl || log.url)
                                ? 'Unblock URL pattern'
                                : 'Block URL pattern'}
                            </div>
                            <p>
                              {urlMatchesBlockedPattern(log.fullUrl || log.url)
                                ? 'Remove this pattern from the blocked list.'
                                : 'Add a blocked URL pattern based on this request.'}
                            </p>
                          </div>
                        </button>
                        <button
                          type="button"
                          className={`relative group/log-expand inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
                            expandedLog === log.id
                              ? 'bg-[#111827] border-slate-300 text-slate-100 hover:bg-[#1f2937] hover:border-slate-200'
                              : 'bg-[#050508] border-slate-600/80 text-slate-300 hover:bg-[#111827] hover:border-slate-400 hover:text-slate-100'
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedLog(expandedLog === log.id ? null : log.id);
                          }}
                        >
                          <span className="sr-only">
                            {expandedLog === log.id ? 'Collapse request details' : 'Expand request details'}
                          </span>
                          <ChevronDown
                            className={`w-4 h-4 transition-transform duration-150 ${
                              expandedLog === log.id ? 'rotate-180' : ''
                            }`}
                          />
                          <div
                            className="invisible group-hover/log-expand:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                            style={{ zIndex: 99999 }}
                          >
                            <div className="font-semibold mb-1 text-slate-200">
                              {expandedLog === log.id ? 'Hide details' : 'Show details'}
                            </div>
                            <p>
                              {expandedLog === log.id
                                ? 'Collapse the full request and response details.'
                                : 'Expand to inspect the full request and response payloads.'}
                            </p>
                          </div>
                        </button>
                      </div>
                    </div>

                    <p className="text-white font-mono text-sm truncate mb-1">
                      {log.fullUrl || log.url}
                    </p>

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

              {expandedLog === log.id && (
                <div className="border-t border-[#2a2a2a] p-4 bg-[#0a0a0a]">
                  <div className="space-y-4">
                    {/* Request Section */}
                    <div className="border-b border-slate-700 pb-4">
                      <h3 className="text-base font-bold text-blue-400 mb-3">📤 Request</h3>
                      
                      <div className="space-y-3">
                        <div>
                          <h4 className="text-sm font-semibold text-slate-300 mb-2">Request Headers</h4>
                          <HeaderList headers={log.headers} />
                        </div>
                        
                        {(() => {
                          const isWebSocket = log.source === 'websocket';

                          // WebSocket message logs don't have a meaningful HTTP request body;
                          // their payload is shown in the Message section instead.
                          const hasConnectRequest = !isWebSocket && log.connectRequest?.frames?.length > 0;
                          const hasStandardBody = !isWebSocket && log.body && (
                            typeof log.body === 'string'
                              ? log.body.trim().length > 0
                              : typeof log.body === 'object' && Object.keys(log.body).length > 0
                          );

                          let standardContent = null;
                          if (!hasConnectRequest && hasStandardBody) {
                            const requestJson =
                              (log.requestBodyJson && typeof log.requestBodyJson === 'object')
                                ? log.requestBodyJson
                                : (typeof log.body === 'object' && log.body !== null
                                    ? log.body
                                    : null);

                            if (requestJson) {
                              standardContent = (
                                <div className="text-xs text-slate-200 overflow-y-auto max-h-96">
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                                    Decoded JSON
                                  </div>
                                  <div className="bg-[#0f0f0f] rounded px-3 py-2 border border-[#2a2a2a]">
                                    <JSONTree
                                      data={requestJson}
                                      theme={jsonTreeTheme}
                                      invertTheme={false}
                                      hideRoot={false}
                                      shouldExpandNodeInitially={shouldExpandJsonTreeAll}
                                      valueRenderer={renderJsonValue}
                                      labelRenderer={createJsonTreeLabelRenderer(
                                        onCreateJsonPathRule,
                                        'Request JSON body',
                                        log.fullUrl || log.url || '',
                                        requestJson,
                                        'request'
                                      )}
                                    />
                                  </div>
                                </div>
                              );
                            } else {
                              const bodyString = String(log.body ?? '');
                              standardContent = (
                                <pre className="bg-slate-950 p-3 rounded text-xs text-slate-300 overflow-x-auto max-h-60">
                                  {bodyString}
                                </pre>
                              );
                            }
                          }

                          const collapseRaw = hasConnectRequest || hasStandardBody || (
                            typeof log.body === 'string' &&
                            log.rawRequestBodyPreview &&
                            log.rawRequestBodyPreview.trim() === log.body.trim()
                          );
                          const rawRequestPreview = hasConnectRequest
                            ? buildConnectReadablePreview(log.connectRequest)
                            : (isWebSocket ? null : log.rawRequestBodyPreview);

                          const rawRequestSection = renderRawDataSection(
                            'Raw Request Body',
                            rawRequestPreview,
                            isWebSocket ? null : log.rawRequestBodyBase64,
                            { collapsePreview: collapseRaw }
                          );

                          if (!hasConnectRequest && !hasStandardBody && !rawRequestSection) {
                            return null;
                          }

                          return (
                            <div>
                              <h4 className="text-sm font-semibold text-slate-300 mb-2">Request Body</h4>
                              {log.requestBodySummary && (
                                <div className="text-xs text-slate-400 mb-2">{log.requestBodySummary}</div>
                              )}
                              {hasConnectRequest ? (
                                <>
                                  {renderConnectFrames(log.connectRequest, false, log, onCreateJsonPathRule)}
                                  {rawRequestSection}
                                </>
                              ) : hasStandardBody ? (
                                <>
                                  {standardContent}
                                  {rawRequestSection}
                                </>
                              ) : (
                                rawRequestSection || <div className="text-xs text-slate-500">No body captured.</div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Response Section or WebSocket Message */}
                    {(log.responseHeaders || log.responseBody || (log.source === 'websocket' && log.body)) && (
                      <div>
                        <h3 className="text-base font-bold text-green-400 mb-3">
                          {log.source === 'websocket' ? '💬 Message' : '📥 Response'}
                        </h3>

                        <div className="space-y-3">
                          {log.responseHeaders && (
                            <div>
                              <h4 className="text-sm font-semibold text-slate-300 mb-2">Response Headers</h4>
                              <HeaderList headers={log.responseHeaders} />
                            </div>
                          )}
                          
                          {/* Show responseBody OR body for WebSocket messages */}
                          {(() => {
                            const isWebSocket = log.source === 'websocket';
                            const hasConnectResponse = log.connectResponse?.frames?.length > 0 || Array.isArray(log.responseBody);
                            const bodyStringCandidate = (() => {
                              if (typeof log.responseBody === 'string') return log.responseBody;
                              if (isWebSocket && log.body && typeof log.body === 'string') return log.body;
                              return '';
                            })();
                            const collapseRaw =
                              hasConnectResponse ||
                              !!log.responseBody ||
                              (bodyStringCandidate &&
                                log.rawResponseBodyPreview &&
                                log.rawResponseBodyPreview.trim() === bodyStringCandidate.trim()) ||
                              (!hasConnectResponse &&
                                !log.responseBody &&
                                log.rawResponseBodyPreview &&
                                log.rawResponseBodyPreview.length > 2000) ||
                              (isWebSocket && bodyStringCandidate && bodyStringCandidate.length > 2000);

                            const rawResponsePreview = hasConnectResponse
                              ? buildConnectReadablePreview(log.connectResponse)
                              : (isWebSocket
                                  ? bodyStringCandidate || (log.body != null ? String(log.body) : '')
                                  : log.rawResponseBodyPreview);

                            const rawLabel = isWebSocket ? 'Raw Message' : 'Raw Response Body';

                            const rawResponseSection = renderRawDataSection(
                              rawLabel,
                              rawResponsePreview,
                              isWebSocket ? null : log.rawResponseBodyBase64,
                              { collapsePreview: collapseRaw }
                            );

                            if (!hasConnectResponse && !log.responseBody && log.source !== 'websocket' && !rawResponseSection) {
                              return null;
                            }

                            if (hasConnectResponse) {
                              return (
                                <div>
                                  <h4 className="text-sm font-semibold text-slate-300 mb-2">
                                    Response Body
                                    {log.responseSize && (
                                      <span className="ml-2 text-xs text-slate-500">
                                        ({(log.responseSize / 1024).toFixed(2)} KB)
                                      </span>
                                    )}
                                  </h4>
                                  {log.responseBodySummary && (
                                    <div className="text-xs text-slate-400 mb-2">{log.responseBodySummary}</div>
                                  )}
                                  {renderConnectFrames(log.connectResponse, true, log, onCreateJsonPathRule)}
                                  {rawResponseSection}
                                </div>
                              );
                            }

                            let bodyToShow = '';
                            if (log.responseBody) {
                              bodyToShow = typeof log.responseBody === 'string'
                                ? log.responseBody
                                : (() => {
                                    try {
                                      return JSON.stringify(log.responseBody, null, 2);
                                    } catch {
                                      return String(log.responseBody);
                                    }
                                  })();
                            } else if (log.source === 'websocket' && log.body) {
                              bodyToShow = typeof log.body === 'string' ? log.body : JSON.stringify(log.body);
                            }

                            if (!bodyToShow && rawResponseSection) {
                              return (
                                <div>
                                  <h4 className="text-sm font-semibold text-slate-300 mb-2">
                                    {isWebSocket ? 'Message' : 'Response Body'}
                                  </h4>
                                  {rawResponseSection}
                                </div>
                              );
                            }

                            const contentType = log.responseHeaders?.['content-type'] || '';
                            const url = (log.fullUrl || log.url).toLowerCase();
                            const trimmedBody = bodyToShow.trim();
                            const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif', '.tiff'];
                            const isImage = contentType.includes('image/') || imageExtensions.some(ext => url.endsWith(ext));

                            let isJSON = false;
                            let jsonData = null;

                            if (isWebSocket) {
                              if (log.wsBodyJsonAfter || log.wsBodyJsonBefore) {
                                isJSON = true;
                                jsonData = log.wsBodyJsonAfter || log.wsBodyJsonBefore;
                              }
                            } else {
                              // For HTTP responses, prefer backend-provided JSON snapshots
                              // or object bodies. We intentionally avoid JSON.parse here so
                              // that all heavy parsing happens on the server.
                              if (log.responseBodyJson && typeof log.responseBodyJson === 'object') {
                                isJSON = true;
                                jsonData = log.responseBodyJson;
                              } else if (typeof log.responseBody === 'object' && log.responseBody !== null) {
                                isJSON = true;
                                jsonData = log.responseBody;
                              } else {
                                isJSON = false;
                                jsonData = null;
                              }
                            }

                            const isHTML = !isWebSocket && (contentType.includes('html') || trimmedBody.startsWith('<!DOCTYPE') || trimmedBody.startsWith('<html'));

                            return (
                              <div>
                                <h4 className="text-sm font-semibold text-slate-300 mb-2">
                                  {isWebSocket ? 'Message Preview' : 'Response Body Preview'}
                                  {log.responseSize && (
                                    <span className="ml-2 text-xs text-slate-500">
                                      ({(log.responseSize / 1024).toFixed(2)} KB)
                                    </span>
                                  )}
                                </h4>

                                {isImage ? (
                                  <div className="bg-slate-950 p-3 rounded">
                                    {bodyToShow.includes('[Binary') ? (
                                      <>
                                        <img
                                          src={log.fullUrl || log.url}
                                          alt="Response preview"
                                          className="max-w-full max-h-96 rounded border border-slate-700"
                                          onError={(e) => {
                                            e.target.style.display = 'none';
                                            e.target.nextSibling.style.display = 'block';
                                          }}
                                        />
                                        <div style={{ display: 'none' }} className="text-slate-500 text-sm">
                                          Unable to load image. Try opening it in a new tab:
                                          <a href={log.fullUrl || log.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline ml-1">
                                            {log.fullUrl || log.url}
                                          </a>
                                        </div>
                                      </>
                                    ) : (
                                      <div className="text-slate-500 text-sm">
                                        Image detected but body is not available.
                                        <a href={log.fullUrl || log.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline ml-1">
                                          Open in new tab
                                        </a>
                                      </div>
                                    )}
                                  </div>
                                ) : isJSON && !bodyToShow.includes('[Binary') ? (
                                  <div className="text-xs text-slate-200 overflow-y-auto max-h-96">
                                    {log.source !== 'websocket' && (
                                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                                        Decoded JSON
                                      </div>
                                    )}
                                    <div className="bg-[#0f0f0f] rounded px-3 py-2 border border-[#2a2a2a]">
                                      {(() => {
                                        const data = jsonData;

                                        if (!data) {
                                          return (
                                            <pre className="text-xs text-slate-300 overflow-x-auto max-h-96">
                                              {bodyToShow}
                                            </pre>
                                          );
                                        }

                                        // For WebSocket messages, when the backend provides structured
                                        // before/after JSON and rewrites exist, render a compact side by
                                        // side preview similar to the Connect timeline.
                                        if (
                                          isWebSocket &&
                                          Array.isArray(log.rewrites) &&
                                          log.rewrites.length > 0 &&
                                          log.wsBodyJsonBefore
                                        ) {
                                          const afterJson = log.wsBodyJsonAfter || data;
                                          const beforeJson = log.wsBodyJsonBefore;

                                          if (afterJson && beforeJson) {
                                            return (
                                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                <div>
                                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                                                    After rewrite
                                                  </div>
                                                  <div className="border border-[#2a2a2a] rounded bg-[#050505] px-2 py-1">
                                                    <JSONTree
                                                      data={afterJson}
                                                      theme={jsonTreeTheme}
                                                      invertTheme={false}
                                                      hideRoot={false}
                                                      shouldExpandNodeInitially={shouldExpandJsonTreeAll}
                                                      valueRenderer={renderJsonValue}
                                                      labelRenderer={createJsonTreeLabelRenderer(
                                                        onCreateJsonPathRule,
                                                        'Response JSON body',
                                                        log.fullUrl || log.url || '',
                                                        afterJson,
                                                        'both'
                                                      )}
                                                    />
                                                  </div>
                                                </div>
                                                <div>
                                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                                                    Before rewrite
                                                  </div>
                                                  <div className="border border-[#2a2a2a] rounded bg-[#050505] px-2 py-1">
                                                    <JSONTree
                                                      data={beforeJson}
                                                      theme={jsonTreeTheme}
                                                      invertTheme={false}
                                                      hideRoot={false}
                                                      shouldExpandNodeInitially={shouldExpandJsonTreeAll}
                                                      valueRenderer={renderJsonValue}
                                                      labelRenderer={createJsonTreeLabelRenderer(
                                                        onCreateJsonPathRule,
                                                        'Response JSON body',
                                                        log.fullUrl || log.url || '',
                                                        beforeJson,
                                                        'both'
                                                      )}
                                                    />
                                                  </div>
                                                </div>
                                              </div>
                                            );
                                          }
                                        }

                                        // Fallback: single JSON view. For WebSocket messages this uses
                                        // the backend-provided JSON snapshot (wsBodyJsonAfter/before),
                                        // and for HTTP responses it falls back to parsing the body
                                        // locally when needed.
                                        if (!data) {
                                          return (
                                            <pre className="text-xs text-slate-300 overflow-x-auto max-h-96">
                                              {bodyToShow}
                                            </pre>
                                          );
                                        }

                                        return (
                                          <JSONTree
                                            data={data}
                                            theme={jsonTreeTheme}
                                            invertTheme={false}
                                            hideRoot={false}
                                            shouldExpandNodeInitially={shouldExpandJsonTreeAll}
                                            valueRenderer={renderJsonValue}
                                            labelRenderer={createJsonTreeLabelRenderer(
                                              onCreateJsonPathRule,
                                              'Response JSON body',
                                              log.fullUrl || log.url || '',
                                              data,
                                              isWebSocket ? 'both' : 'response'
                                            )}
                                          />
                                        );
                                      })()}
                                    </div>
                                  </div>
                                ) : isHTML && !bodyToShow.includes('[Binary') ? (
                                  <div className="space-y-2">
                                    <div className="bg-slate-950 border border-slate-700 rounded p-3 max-h-96 overflow-auto">
                                      <iframe
                                        srcDoc={bodyToShow}
                                        className="w-full h-96 bg-white rounded"
                                        sandbox="allow-same-origin"
                                        title="HTML Preview"
                                      />
                                    </div>
                                    <details className="bg-slate-950 rounded">
                                      <summary className="cursor-pointer p-3 text-xs text-slate-400 hover:text-slate-300">
                                        Show HTML source
                                      </summary>
                                      <pre className="p-3 text-xs text-slate-300 overflow-x-auto max-h-60 border-t border-slate-800">
                                        {bodyToShow}
                                      </pre>
                                    </details>
                                  </div>
                                ) : (
                                  <pre className="bg-[#0f0f0f] border border-[#2a2a2a] p-3 rounded text-xs text-slate-300 overflow-x-auto max-h-96">
                                    {bodyToShow || 'No content available'}
                                  </pre>
                                )}

                                {rawResponseSection}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                    
                    {/* Error Section */}
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
              )}
            </div>
          ))}
          {/* Infinite scroll trigger */}
          <div ref={observerTarget} style={{ height: '1px' }} />
          {loading && filteredLogs.length >= PAGE_SIZE && (
            <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] flex flex-col items-center justify-center text-center mt-4">
              <Spinner size="md" color="blue" />
              <p className="mt-3 text-sm text-slate-400">Loading more requests...</p>
            </div>
          )}
          </>
        )}
      </div>
    </div>
    </>
  );
}

export default RequestLogs;
