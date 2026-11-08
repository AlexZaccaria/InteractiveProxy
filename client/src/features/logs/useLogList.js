import { useCallback, useEffect, useMemo, useRef } from 'react'
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet } from '../../lib/api'
import { queryKeys } from '../../lib/queries'
import { PAGE_SIZE, buildLogsQuery } from './filters'

/** @typedef {import('./filters').LogFilters} LogFilters */
/** @typedef {import('../../lib/types').LogSummary} LogSummary */
/** @typedef {import('../../lib/types').LogsPage} LogsPage */
/** @typedef {import('@tanstack/react-query').InfiniteData<LogsPage, number>} LogsData */

/** Quiet time after a burst of `log` events before the held window is refetched. */
export const LOG_EVENT_REFETCH_DEBOUNCE_MS = 250

/** Period of the first-page poll while the event stream is not open. */
export const FIRST_PAGE_POLL_MS = 2000

/**
 * @typedef {Object} LogListOptions
 * @property {LogFilters} filters
 * @property {boolean} isDebouncing True while a text search is waiting to be applied.
 * @property {number | string} [refreshToken] Changing it discards the list and reloads the first page.
 * @property {number} [logsVersion] Bumped on every `log` event; the held window is refetched, debounced.
 * @property {boolean} [eventsConnected] True while the event stream is open; the poll is then off.
 * @property {string | number | null} [expandedId] The expanded card, kept in the list when a refetch drops it.
 */

/**
 * @typedef {Object} LogListState
 * @property {LogSummary[]} items Every page in order (oldest entry first, as the server lists them).
 * @property {number} total Entries matching the filters on the server.
 * @property {boolean} hasMore
 * @property {() => void} loadMore Fetch the next page, unless one is already in flight.
 * @property {boolean} showLoading The list is empty and its content is being (re)computed.
 * @property {boolean} isFetching
 * @property {boolean} isFetchingNextPage
 */

/**
 * @param {LogFilters} filters
 * @param {number} offset
 * @param {number} limit
 * @param {AbortSignal} [signal]
 * @returns {Promise<LogsPage>}
 */
export async function fetchLogsPage(filters, offset, limit, signal) {
  const data = await apiGet('/api/logs', { query: buildLogsQuery(filters, offset, limit), signal })
  return {
    items: data && Array.isArray(data.items) ? data.items : [],
    total: data && typeof data.total === 'number' ? data.total : 0,
    hasMore: Boolean(data && data.hasMore),
    offset: data && typeof data.offset === 'number' ? data.offset : offset,
    limit: data && typeof data.limit === 'number' ? data.limit : limit
  }
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameId(a, b) {
  return String(a) === String(b)
}

/**
 * The refreshed window with the expanded entry kept: when the fresh page no
 * longer contains it (newer traffic pushed it out or the ring buffer evicted
 * it), the copy the client holds is put first so the open card does not
 * vanish under the user.
 *
 * @param {LogsPage} page
 * @param {LogsData | undefined} previous
 * @param {string | number | null | undefined} expandedId
 * @param {number} limit
 * @returns {LogsPage}
 */
export function keepExpandedEntry(page, previous, expandedId, limit) {
  if (expandedId === null || expandedId === undefined || !previous) return page
  if (page.items.some(item => item && sameId(item.id, expandedId))) return page

  const held = previous.pages.flatMap(previousPage => previousPage.items)
  const expanded = held.find(item => item && sameId(item.id, expandedId))
  if (!expanded) return page

  return { ...page, items: [expanded, ...page.items].slice(0, limit) }
}

/**
 * The paged list of `GET /api/logs` for a filter set, as a TanStack
 * infinite query keyed on the filters (page param = offset). On a `log`
 * event the whole window the client holds is refetched in one request and
 * written back as a single page; on `refreshToken` the list is reset; while
 * the stream is closed and the first page is not full, the first page is
 * polled every two seconds so that the list fills up on its own.
 *
 * @param {LogListOptions} options
 * @returns {LogListState}
 */
export function useLogList({
  filters,
  isDebouncing,
  refreshToken = 0,
  logsVersion = 0,
  eventsConnected = false,
  expandedId = null
}) {
  const queryClient = useQueryClient()
  const queryKey = useMemo(() => queryKeys.logs(filters), [filters])

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => fetchLogsPage(filters, pageParam, PAGE_SIZE, signal),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastOffset) =>
      lastPage.hasMore ? lastOffset + lastPage.items.length : undefined,
    placeholderData: keepPreviousData,
    refetchInterval: query => {
      if (eventsConnected || isDebouncing) return false
      const data = query.state.data
      const held = data ? data.pages.reduce((count, page) => count + page.items.length, 0) : 0
      return held < PAGE_SIZE ? FIRST_PAGE_POLL_MS : false
    }
  })

  const items = useMemo(
    () => (query.data ? query.data.pages.flatMap(page => page.items) : []),
    [query.data]
  )
  const lastPage = query.data ? query.data.pages[query.data.pages.length - 1] : undefined
  const total = lastPage ? lastPage.total : 0

  // Values the debounced handlers read without re-arming their timers.
  const itemsCountRef = useRef(0)
  itemsCountRef.current = items.length
  const expandedIdRef = useRef(expandedId)
  expandedIdRef.current = expandedId

  /** @type {import('react').RefObject<AbortController | null>} */
  const windowControllerRef = useRef(null)

  const refetchWindow = useCallback(async () => {
    if (windowControllerRef.current) windowControllerRef.current.abort()
    const controller = new AbortController()
    windowControllerRef.current = controller

    const limit = Math.max(PAGE_SIZE, itemsCountRef.current)
    await queryClient.cancelQueries({ queryKey })
    if (controller.signal.aborted) return

    /** @type {LogsPage} */
    let page
    try {
      page = await fetchLogsPage(filters, 0, limit, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      console.error('Error refreshing logs:', error)
      return
    }
    if (controller.signal.aborted) return

    queryClient.setQueryData(
      queryKey,
      /** @param {LogsData | undefined} previous */
      previous => ({
        pages: [keepExpandedEntry(page, previous, expandedIdRef.current, limit)],
        pageParams: [0]
      })
    )
  }, [filters, queryClient, queryKey])

  // A filter change makes any window fetch in flight stale.
  useEffect(
    () => () => {
      if (windowControllerRef.current) windowControllerRef.current.abort()
      windowControllerRef.current = null
    },
    [queryKey]
  )

  const handledVersionRef = useRef(0)
  useEffect(() => {
    if (!eventsConnected || logsVersion === 0 || logsVersion === handledVersionRef.current) {
      return undefined
    }
    const timer = setTimeout(() => {
      handledVersionRef.current = logsVersion
      refetchWindow()
    }, LOG_EVENT_REFETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [logsVersion, eventsConnected, refetchWindow])

  const handledRefreshRef = useRef(refreshToken)
  useEffect(() => {
    if (refreshToken === handledRefreshRef.current) return
    handledRefreshRef.current = refreshToken
    if (windowControllerRef.current) windowControllerRef.current.abort()
    queryClient.resetQueries({ queryKey: queryKeys.logsRoot })
  }, [refreshToken, queryClient])

  const { hasNextPage, isFetching, isFetchingNextPage, isPlaceholderData, isPending } = query
  const fetchNextPage = query.fetchNextPage

  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetching || isPlaceholderData || isDebouncing) return
    fetchNextPage()
  }, [hasNextPage, isFetching, isPlaceholderData, isDebouncing, fetchNextPage])

  const showLoading =
    items.length === 0 && (isDebouncing || isPending || (isFetching && isPlaceholderData))

  return {
    items,
    total,
    hasMore: Boolean(hasNextPage) && !isPlaceholderData,
    loadMore,
    showLoading,
    isFetching,
    isFetchingNextPage
  }
}
