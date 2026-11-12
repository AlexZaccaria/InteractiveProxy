import { useMemo } from 'react'
import { diffLines } from '../../lib/diff'

/** @typedef {import('../../lib/diff').DiffRow} DiffRow */

const ROW_CLASS = {
  equal: '',
  removed: 'bg-red-500/10',
  added: 'bg-emerald-500/10',
  changed: 'bg-amber-500/10'
}

const LEFT_CLASS = {
  equal: 'text-fg-body',
  removed: 'text-red-200 bg-red-500/10',
  added: 'bg-surface-sunken/60',
  changed: 'text-red-200 bg-red-500/10'
}

const RIGHT_CLASS = {
  equal: 'text-fg-body',
  removed: 'bg-surface-sunken/60',
  added: 'text-emerald-200 bg-emerald-500/10',
  changed: 'text-emerald-200 bg-emerald-500/10'
}

/**
 * @param {Object} props
 * @param {DiffRow} props.row
 */
function DiffRowView({ row }) {
  return (
    <div className={`grid grid-cols-2 ${ROW_CLASS[row.kind]}`} role="row">
      <div className={`flex min-w-0 ${LEFT_CLASS[row.kind]}`} role="cell">
        <span className="w-10 shrink-0 pr-2 text-right text-fg-faint select-none">
          {row.leftNumber ?? ''}
        </span>
        <span className="whitespace-pre-wrap break-all">{row.left ?? ''}</span>
      </div>
      <div className={`flex min-w-0 border-l border-edge ${RIGHT_CLASS[row.kind]}`} role="cell">
        <span className="w-10 shrink-0 pr-2 text-right text-fg-faint select-none">
          {row.rightNumber ?? ''}
        </span>
        <span className="whitespace-pre-wrap break-all">{row.right ?? ''}</span>
      </div>
    </div>
  )
}

/**
 * The side-by-side diff of a body before and after a rewrite: the lines
 * removed on the left, the lines added on the right, the unchanged ones on
 * both sides.
 *
 * @param {Object} props
 * @param {string} props.before
 * @param {string} props.after
 * @param {string} [props.leftLabel]
 * @param {string} [props.rightLabel]
 */
export default function DiffView({
  before,
  after,
  leftLabel = 'Before rewrite',
  rightLabel = 'After rewrite'
}) {
  const diff = useMemo(() => diffLines(before, after), [before, after])

  return (
    <div
      className="rounded border border-edge bg-surface-inset text-[11px] font-mono overflow-hidden"
      role="table"
      aria-label="Differences between the body before and after the rewrite"
    >
      <div className="grid grid-cols-2 border-b border-edge bg-surface-sunken text-[10px] uppercase tracking-wide text-fg-muted">
        <div className="px-2 py-1">{leftLabel}</div>
        <div className="px-2 py-1 border-l border-edge flex items-center justify-between gap-2">
          <span>{rightLabel}</span>
          {!diff.tooLarge && (
            <span className="normal-case tracking-normal">
              <span className="text-emerald-300">+{diff.added}</span>{' '}
              <span className="text-red-300">−{diff.removed}</span>
            </span>
          )}
        </div>
      </div>
      {diff.tooLarge ? (
        <p className="px-2 py-3 text-fg-muted">The body is too long to compare line by line.</p>
      ) : diff.added === 0 && diff.removed === 0 ? (
        <p className="px-2 py-3 text-fg-muted">No differences.</p>
      ) : (
        <div className="max-h-96 overflow-auto">
          {(diff.rows || []).map((row, index) => (
            <DiffRowView key={index} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}
