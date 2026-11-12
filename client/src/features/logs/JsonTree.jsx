import { useMemo, useState } from 'react'
import { JSONTree } from 'react-json-tree'
import { buildJsonPathFromKeyPath, buildJsonPathRuleSeed, isJsonTreeRootNode } from './jsonPath'
import { useProxyStore } from '../../store/useProxyStore'
import Tooltip from '../../components/Tooltip'
import DiffView from './DiffView'
import { stringifyForDiff } from '../../lib/diff'

/**
 * The JSON viewer of the log details: react-json-tree in the proxy's
 * palette, every key clickable to seed a rewrite rule, expanded to depth 2
 * by default with an "Expand all" switch per tree.
 */

// App-themed base16 palette for react-json-tree in the dark theme, tuned to
// match the proxy UI with enhanced contrast and distinct colors for better
// readability. The surface values are the dark tokens of index.css.
export const jsonTreeTheme = {
  scheme: 'proxy-dark',
  author: 'interactive-proxy',
  // background + depth (aligned with bg-surface-inset / bg-surface-sunken)
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

// The same roles in the light theme: the surfaces are the light tokens of
// index.css, the accents the 600/700 shades of the same hues.
export const jsonTreeLightTheme = {
  scheme: 'proxy-light',
  author: 'interactive-proxy',
  base00: '#fafafa',
  base01: '#f4f4f5',
  base02: '#e4e4e7',
  base03: '#71717a',
  base04: '#52525b',
  base05: '#3f3f46',
  base06: '#27272a',
  base07: '#18181b',
  base08: '#dc2626', // red-600 — null, undefined, errors
  base09: '#0d9488', // teal-600 — numbers
  base0A: '#b45309', // amber-700 — booleans
  base0B: '#3f3f46', // zinc-700 — strings
  base0C: '#0891b2', // cyan-600 — dates, special values
  base0D: '#b45309', // amber-700 — keys
  base0E: '#9333ea', // purple-600 — functions, symbols
  base0F: '#ea580c' // orange-600 — regex, special types
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
 * A key label that seeds a rewrite rule when clicked or activated with
 * Enter or Space, with a tooltip that shows the path.
 *
 * @param {{ labelText: string, path: string, onActivate: () => void }} props
 */
export function JsonTreeClickableLabel({ labelText, path, onActivate }) {
  /** @param {import('react').SyntheticEvent} event */
  const activate = event => {
    event.stopPropagation()
    event.preventDefault()
    if (typeof onActivate === 'function') onActivate()
  }

  return (
    <Tooltip
      title="Create a rewrite rule"
      description={
        <>
          <p>Click to create a rewrite rule for this field.</p>
          <div className="text-fg-faint truncate mt-0.5">
            Path: <code className="text-[10px] text-blue-300">{path}</code>
          </div>
        </>
      }
      placement="bottom-start"
      panelClassName="max-w-72"
      inline
    >
      <span
        role="button"
        tabIndex={0}
        className="cursor-pointer underline decoration-dotted decoration-slate-500/70 hover:decoration-slate-300 focus:outline-hidden focus-visible:decoration-slate-300"
        onClick={activate}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') activate(event)
        }}
      >
        {labelText}
      </span>
    </Tooltip>
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
  const theme = useProxyStore(state => state.theme)
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
            <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
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
        theme={theme === 'dark' ? jsonTreeTheme : jsonTreeLightTheme}
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
    <div className="bg-surface-inset rounded px-3 py-2 border border-edge max-h-96 overflow-y-auto">
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
  const [view, setView] = useState(/** @type {'trees' | 'diff'} */ ('trees'))

  return (
    <div className="text-xs text-fg-base space-y-2">
      <div
        role="group"
        aria-label="Before and after view"
        className="flex items-center justify-end gap-1"
      >
        {[
          ['trees', 'Trees'],
          ['diff', 'Diff']
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(/** @type {'trees' | 'diff'} */ (key))}
            className={`px-2 h-6 rounded text-[11px] border transition-colors ${
              view === key
                ? 'bg-surface-active border-fg-faint/70 text-fg-strong'
                : 'border-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-base'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'diff' ? (
        <DiffView before={stringifyForDiff(before)} after={stringifyForDiff(after)} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <JsonPanel title="After rewrite" data={after} {...shared} />
          <JsonPanel title="Before rewrite" data={before} {...shared} />
        </div>
      )}
    </div>
  )
}
