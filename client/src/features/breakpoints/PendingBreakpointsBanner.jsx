import { Pause } from 'lucide-react'

/** @typedef {import('../../lib/types').PausedBreakpoint} PausedBreakpoint */

/**
 * The strip shown above the tabs while flows are held at a breakpoint and
 * no editor is open: the first paused flow and a button that opens it.
 *
 * @param {Object} props
 * @param {PausedBreakpoint[]} props.items
 * @param {(item: PausedBreakpoint) => void} props.onOpen
 */
export default function PendingBreakpointsBanner({ items, onOpen }) {
  const first = items[0]
  if (!first) return null
  return (
    <div
      role="status"
      className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-xs text-fg-base"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Pause className="w-4 h-4 text-amber-400 shrink-0" />
        <span className="min-w-0 truncate">
          {items.length === 1 ? 'A flow is' : `${items.length} flows are`} paused at a breakpoint:{' '}
          <span className="font-medium text-fg-strong">{first.method}</span>{' '}
          <span className="font-mono">{first.url}</span>{' '}
          <span className="text-fg-muted">({first.phase})</span>
        </span>
      </div>
      <button
        type="button"
        onClick={() => onOpen(first)}
        className="shrink-0 px-3 h-7 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-500 transition-colors"
      >
        Open
      </button>
    </div>
  )
}
