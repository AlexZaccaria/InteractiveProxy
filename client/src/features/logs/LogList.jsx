import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { AlertCircle } from 'lucide-react'
import Spinner from '../../components/Spinner'
import LogRow from './LogRow'

/** @typedef {import('../../lib/types').LogSummary} LogSummary */

/** Height of a collapsed card, used until the card is measured. */
const ESTIMATED_ROW_HEIGHT = 112

/** Vertical space between cards (Tailwind `space-y-2`). */
const ROW_GAP = 8

/** Distance kept between the top of the viewport and an expanded card (the sticky header). */
const EXPANDED_CARD_MARGIN_TOP = 80

/**
 * The cards, virtualised against the window: only the rows in and around
 * the viewport exist in the DOM, each measured once mounted so that
 * expanded cards and wrapped badge rows take their real height. The next
 * page is requested when the last row enters the viewport.
 *
 * @param {Object} props
 * @param {LogSummary[]} props.items
 * @param {boolean} props.showLoading The list is empty and loading.
 * @param {boolean} props.isFetching
 * @param {boolean} props.isFetchingNextPage
 * @param {boolean} props.hasMore
 * @param {() => void} props.loadMore
 * @param {string | null} props.expandedId
 * @param {Set<string>} props.exportSelection
 * @param {string | null} props.pinnedRewritesId
 * @param {(url: string) => boolean} props.isBlocked
 * @param {(id: string) => void} props.onToggleExpand
 * @param {(id: string) => void} props.onToggleExport
 * @param {(url: string) => void} props.onToggleBlock
 * @param {(id: string) => void} props.onToggleRewritesPin
 * @param {(log: LogSummary, file: File) => void} props.onReplaceResource
 * @param {(seed: import('./jsonPath').JsonPathRuleSeed) => void} [props.onCreateJsonPathRule]
 */
export default function LogList({
  items,
  showLoading,
  isFetching,
  isFetchingNextPage,
  hasMore,
  loadMore,
  expandedId,
  exportSelection,
  pinnedRewritesId,
  isBlocked,
  onToggleExpand,
  onToggleExport,
  onToggleBlock,
  onToggleRewritesPin,
  onReplaceResource,
  onCreateJsonPathRule
}) {
  const listRef = useRef(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const hasItems = items.length > 0

  // The list starts below the header, the tabs and the filters: the
  // virtualizer needs that offset to map window scroll positions to rows.
  useLayoutEffect(() => {
    const element = listRef.current
    if (!element) return undefined
    const measure = () => {
      setScrollMargin(element.getBoundingClientRect().top + window.scrollY)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [hasItems])

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 4,
    gap: ROW_GAP,
    scrollMargin,
    getItemKey: index => (items[index] ? items[index].id : index)
  })

  const virtualItems = virtualizer.getVirtualItems()
  const lastVisibleIndex = virtualizer.range ? virtualizer.range.endIndex : -1

  useEffect(() => {
    if (lastVisibleIndex < 0 || !hasMore || isFetching) return
    if (lastVisibleIndex >= items.length - 1) loadMore()
  }, [lastVisibleIndex, items.length, hasMore, isFetching, loadMore])

  // Bring the expanded card near the top of the viewport, so that it stays
  // in view when a card above it collapses at the same time.
  useEffect(() => {
    if (expandedId === null || !listRef.current) return
    const element = listRef.current.querySelector('[data-expanded="true"]')
    if (!element) return
    const rect = element.getBoundingClientRect()
    const targetY = rect.top + window.scrollY - EXPANDED_CARD_MARGIN_TOP
    window.scrollTo({ top: targetY >= 0 ? targetY : 0, behavior: 'smooth' })
  }, [expandedId])

  if (showLoading && !hasItems) {
    return (
      <div className="bg-surface-raised rounded-lg p-12 border border-edge flex flex-col items-center justify-center text-center">
        <Spinner size="md" color="blue" />
        <p className="mt-3 text-sm text-fg-muted">Loading requests...</p>
      </div>
    )
  }

  if (!hasItems) {
    return (
      <div className="bg-surface-raised rounded-lg p-8 border border-edge text-center">
        <AlertCircle className="w-12 h-12 text-fg-dim mx-auto mb-3" />
        <p className="text-fg-muted">No requests found</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map(virtualRow => {
          const log = items[virtualRow.index]
          if (!log) return null
          const expanded = expandedId !== null && String(expandedId) === String(log.id)
          return (
            // `top` rather than `transform`: a transformed row would start a
            // stacking context and trap the card's tooltips under the next row.
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              data-expanded={expanded ? 'true' : undefined}
              ref={virtualizer.measureElement}
              className="absolute left-0 w-full"
              style={{ top: virtualRow.start - virtualizer.options.scrollMargin }}
            >
              <LogRow
                log={log}
                expanded={expanded}
                selectedForExport={exportSelection.has(String(log.id))}
                blocked={isBlocked(log.fullUrl || log.url)}
                rewritesPinned={
                  pinnedRewritesId !== null && String(pinnedRewritesId) === String(log.id)
                }
                onToggleExpand={onToggleExpand}
                onToggleExport={onToggleExport}
                onToggleBlock={onToggleBlock}
                onToggleRewritesPin={onToggleRewritesPin}
                onReplaceResource={onReplaceResource}
                onCreateJsonPathRule={onCreateJsonPathRule}
              />
            </div>
          )
        })}
      </div>
      {isFetchingNextPage && (
        <div className="bg-surface-raised rounded-lg p-12 border border-edge flex flex-col items-center justify-center text-center mt-4">
          <Spinner size="md" color="blue" />
          <p className="mt-3 text-sm text-fg-muted">Loading more requests...</p>
        </div>
      )}
    </div>
  )
}
