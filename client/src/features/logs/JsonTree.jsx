import { useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { JSONTree } from 'react-json-tree'
import { buildJsonPathFromKeyPath, buildJsonPathRuleSeed, isJsonTreeRootNode } from './jsonPath'

/**
 * The JSON viewer of the log details: react-json-tree in the proxy's
 * palette, every key clickable to seed a rewrite rule, expanded to depth 2
 * by default with an "Expand all" switch per tree.
 */

// App-themed base16 palette for react-json-tree, tuned to match the proxy UI
// with enhanced contrast and distinct colors for better readability.
export const jsonTreeTheme = {
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
  base0F: '#fb923c' // orange-400 — regex, special types
}

/**
 * Levels expanded when a tree mounts: the root (level 0) and its children.
 * Deeper containers are drawn collapsed with their item count.
 */
export const JSON_TREE_DEFAULT_DEPTH = 2

/** @type {(keyPath: unknown, data: unknown, level: number) => boolean} */
const expandToDefaultDepth = (_keyPath, _data, level) => level < JSON_TREE_DEFAULT_DEPTH

const expandEverything = () => true

// Values keep their original representation (no font or wrapping changes).
const renderJsonValue = raw => raw

/**
 * True when `data` holds a non-empty object or array at `depth` or deeper
 * (the root is depth 0), i.e. when the default expansion leaves something
 * collapsed. Stops at the first such node.
 *
 * @param {unknown} data
 * @param {number} depth
 * @returns {boolean}
 */
export function hasCollapsedNodes(data, depth) {
  const stack = [{ value: data, level: 0 }]
  while (stack.length) {
    const next = stack.pop()
    if (!next) break
    const { value, level } = next
    if (!value || typeof value !== 'object') continue
    const entries = Array.isArray(value) ? value : Object.values(value)
    if (!entries.length) continue
    if (level >= depth) return true
    for (const entry of entries) {
      if (entry && typeof entry === 'object') stack.push({ value: entry, level: level + 1 })
    }
  }
  return false
}

/**
 * A key label that seeds a rewrite rule when clicked, with a tooltip
 * (rendered in a portal) that shows the path.
 *
 * @param {{ labelText: string, path: string, onActivate: () => void }} props
 */
export function JsonTreeClickableLabel({ labelText, path, onActivate }) {
  const [showTooltip, setShowTooltip] = useState(false)
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 })
  const anchorRef = useRef(null)
  const hideTimeoutRef = useRef(null)

  const updateTooltipPosition = useCallback(() => {
    const element = anchorRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const tooltipWidth = 280 // similar to other tooltips
    const margin = 6
    setTooltipPosition({
      top: rect.bottom + margin,
      left: Math.max(8, rect.left - tooltipWidth / 2)
    })
  }, [])

  const cancelHide = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
  }, [])

  const scheduleHide = useCallback(() => {
    cancelHide()
    hideTimeoutRef.current = setTimeout(() => setShowTooltip(false), 120)
  }, [cancelHide])

  const handleClick = event => {
    event.stopPropagation()
    event.preventDefault()
    if (typeof onActivate === 'function') onActivate()
  }

  const handleMouseEnter = () => {
    cancelHide()
    updateTooltipPosition()
    setShowTooltip(true)
  }

  return (
    <>
      <span
        ref={anchorRef}
        className="cursor-pointer underline decoration-dotted decoration-slate-500/70 hover:decoration-slate-300"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={scheduleHide}
      >
        {labelText}
      </span>
      {showTooltip &&
        createPortal(
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
  )
}

/**
 * A react-json-tree `labelRenderer` whose labels seed a JSONPath rule for
 * the clicked node. The synthetic root node keeps a plain label.
 *
 * @param {((seed: import('./jsonPath').JsonPathRuleSeed) => void) | undefined} onCreateJsonPathRule
 * @param {string} contextLabel Used in the rule name when the URL has no endpoint segment.
 * @param {string} urlPattern The entry's URL, proposed as the rule's URL pattern.
 * @param {unknown} rootData The tree's data, to read the clicked value.
 * @param {'request' | 'response' | 'both'} target The phase the rule should apply to.
 */
export function createJsonTreeLabelRenderer(
  onCreateJsonPathRule,
  contextLabel,
  urlPattern,
  rootData,
  target = 'request'
) {
  return (keyPath = []) => {
    const hasHandler = typeof onCreateJsonPathRule === 'function'
    const [currentKey] = keyPath
    const labelText = String(currentKey ?? '')

    if (!hasHandler || isJsonTreeRootNode(keyPath)) {
      return <span>{labelText}</span>
    }

    const path = buildJsonPathFromKeyPath(keyPath)
    const handleActivate = () => {
      onCreateJsonPathRule(
        buildJsonPathRuleSeed({ keyPath, rootData, urlPattern, contextLabel, target })
      )
    }

    return <JsonTreeClickableLabel labelText={labelText} path={path} onActivate={handleActivate} />
  }
}

/**
 * One tree with its expansion switch. The switch is shown only when the
 * default depth leaves something collapsed; toggling it remounts the tree,
 * because react-json-tree reads `shouldExpandNodeInitially` once.
 *
 * @param {Object} props
 * @param {unknown} props.data
 * @param {string} [props.title] Small caption at the left of the switch.
 * @param {string} props.contextLabel
 * @param {string} props.urlPattern
 * @param {'request' | 'response' | 'both'} props.target
 * @param {(seed: import('./jsonPath').JsonPathRuleSeed) => void} [props.onCreateJsonPathRule]
 */
export function JsonTree({ data, title, contextLabel, urlPattern, target, onCreateJsonPathRule }) {
  const [expandAll, setExpandAll] = useState(false)
  const canExpandMore = useMemo(() => hasCollapsedNodes(data, JSON_TREE_DEFAULT_DEPTH), [data])

  const labelRenderer = useMemo(
    () => createJsonTreeLabelRenderer(onCreateJsonPathRule, contextLabel, urlPattern, data, target),
    [onCreateJsonPathRule, contextLabel, urlPattern, data, target]
  )

  const showSwitch = canExpandMore || expandAll

  return (
    <>
      {(title || showSwitch) && (
        <div className="flex items-center justify-between gap-2 mb-1">
          {title ? (
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {title}
            </div>
          ) : (
            <span />
          )}
          {showSwitch && (
            <button
              type="button"
              onClick={() => setExpandAll(previous => !previous)}
              className="text-[10px] text-blue-400 hover:text-blue-200 transition-colors"
            >
              {expandAll ? `Collapse to depth ${JSON_TREE_DEFAULT_DEPTH}` : 'Expand all'}
            </button>
          )}
        </div>
      )}
      <JSONTree
        key={expandAll ? 'all' : 'depth'}
        data={data}
        theme={jsonTreeTheme}
        invertTheme={false}
        hideRoot={false}
        shouldExpandNodeInitially={expandAll ? expandEverything : expandToDefaultDepth}
        valueRenderer={renderJsonValue}
        labelRenderer={labelRenderer}
      />
    </>
  )
}

/**
 * A tree in the dark panel the details use (scrollable, 24rem tall at most).
 *
 * @param {Parameters<typeof JsonTree>[0]} props
 */
export function JsonPanel(props) {
  return (
    <div className="bg-[#0f0f0f] rounded px-3 py-2 border border-[#2a2a2a] max-h-96 overflow-y-auto">
      <JsonTree {...props} />
    </div>
  )
}

/**
 * The after/before pair shown when rewrite rules changed a JSON body.
 *
 * @param {Object} props
 * @param {unknown} props.after
 * @param {unknown} props.before
 * @param {string} props.contextLabel
 * @param {string} props.urlPattern
 * @param {'request' | 'response' | 'both'} props.target
 * @param {(seed: import('./jsonPath').JsonPathRuleSeed) => void} [props.onCreateJsonPathRule]
 */
export function JsonBeforeAfter({
  after,
  before,
  contextLabel,
  urlPattern,
  target,
  onCreateJsonPathRule
}) {
  const shared = { contextLabel, urlPattern, target, onCreateJsonPathRule }
  return (
    <div className="text-xs text-slate-200 grid grid-cols-1 md:grid-cols-2 gap-3">
      <JsonPanel title="After rewrite" data={after} {...shared} />
      <JsonPanel title="Before rewrite" data={before} {...shared} />
    </div>
  )
}
