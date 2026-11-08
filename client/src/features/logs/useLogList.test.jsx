import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_SIZE, DEFAULT_FILE_TYPES, DEFAULT_METHODS, DEFAULT_SOURCES } from './filters'
import { LOG_EVENT_REFETCH_DEBOUNCE_MS, keepExpandedEntry, useLogList } from './useLogList'

vi.mock('../../lib/api', () => ({ apiGet: vi.fn() }))

const { apiGet } = await import('../../lib/api')

/** @type {import('./filters').LogFilters} */
const filters = {
  search: '',
  requestSearch: '',
  responseSearch: '',
  requestRewrittenOnly: false,
  responseRewrittenOnly: false,
  sources: DEFAULT_SOURCES,
  methods: DEFAULT_METHODS,
  fileTypes: DEFAULT_FILE_TYPES,
  showWsConnections: false
}

/** A fake log window of `total` entries, oldest first. */
function serverWith(total) {
  return (path, options) => {
    const offset = Number(options.query.offset)
    const limit = Number(options.query.limit)
    const items = []
    for (let i = offset; i < Math.min(offset + limit, total); i += 1) {
      items.push({ id: `log-${i}`, method: 'GET', source: 'proxied', url: `http://h/${i}` })
    }
    return Promise.resolve({ items, total, hasMore: offset + limit < total, offset, limit })
  }
}

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('keepExpandedEntry', () => {
  const page = { items: [{ id: 'b' }, { id: 'c' }], total: 2, hasMore: false, offset: 0, limit: 2 }
  const previous = {
    pages: [{ ...page, items: [{ id: 'a', url: 'kept' }, { id: 'b' }] }],
    pageParams: [0]
  }

  it('puts the expanded entry first when the fresh page dropped it, within the window', () => {
    const merged = keepExpandedEntry(page, previous, 'a', 2)
    expect(merged.items.map(item => item.id)).toEqual(['a', 'b'])
    expect(merged.items[0].url).toBe('kept')
  })

  it('leaves the page alone when nothing is expanded, or the entry is present or unknown', () => {
    expect(keepExpandedEntry(page, previous, null, 2)).toBe(page)
    expect(keepExpandedEntry(page, previous, 'b', 2)).toBe(page)
    expect(keepExpandedEntry(page, previous, 'zzz', 2)).toBe(page)
    expect(keepExpandedEntry(page, undefined, 'a', 2)).toBe(page)
  })
})

describe('useLogList', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the first page in the summary view and pages by offset', async () => {
    apiGet.mockImplementation(serverWith(40))
    const { result } = renderHook(() => useLogList({ filters, isDebouncing: false }), {
      wrapper: createWrapper()
    })

    expect(result.current.showLoading).toBe(true)
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE))
    expect(result.current.total).toBe(40)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.showLoading).toBe(false)
    expect(apiGet).toHaveBeenCalledWith(
      '/api/logs',
      expect.objectContaining({
        query: expect.objectContaining({ offset: '0', limit: String(PAGE_SIZE), view: 'summary' })
      })
    )

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE * 2))
    expect(apiGet).toHaveBeenLastCalledWith(
      '/api/logs',
      expect.objectContaining({ query: expect.objectContaining({ offset: String(PAGE_SIZE) }) })
    )
    expect(result.current.items[PAGE_SIZE].id).toBe(`log-${PAGE_SIZE}`)
  })

  it('refetches the whole held window in one request on a log event, debounced', async () => {
    apiGet.mockImplementation(serverWith(40))
    const wrapper = createWrapper()
    const { result, rerender } = renderHook(
      ({ logsVersion }) =>
        useLogList({ filters, isDebouncing: false, logsVersion, eventsConnected: true }),
      { wrapper, initialProps: { logsVersion: 0 } }
    )
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE * 2))
    apiGet.mockClear()

    apiGet.mockImplementation(serverWith(45))
    rerender({ logsVersion: 1 })
    rerender({ logsVersion: 2 })
    await new Promise(resolve => setTimeout(resolve, LOG_EVENT_REFETCH_DEBOUNCE_MS + 50))

    await waitFor(() => expect(result.current.total).toBe(45))
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith(
      '/api/logs',
      expect.objectContaining({
        query: expect.objectContaining({ offset: '0', limit: String(PAGE_SIZE * 2) })
      })
    )
    expect(result.current.items).toHaveLength(PAGE_SIZE * 2)
    expect(result.current.hasMore).toBe(true)

    // The next page continues after the refetched window.
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE * 3))
    expect(apiGet).toHaveBeenLastCalledWith(
      '/api/logs',
      expect.objectContaining({ query: expect.objectContaining({ offset: String(PAGE_SIZE * 2) }) })
    )
  })

  it('keeps the expanded entry when the refetched window no longer has it', async () => {
    apiGet.mockImplementation(serverWith(3))
    const { result, rerender } = renderHook(
      ({ logsVersion }) =>
        useLogList({
          filters,
          isDebouncing: false,
          logsVersion,
          eventsConnected: true,
          expandedId: 'log-0'
        }),
      { wrapper: createWrapper(), initialProps: { logsVersion: 0 } }
    )
    await waitFor(() => expect(result.current.items).toHaveLength(3))

    // The ring buffer evicted log-0: the server now starts at log-1.
    apiGet.mockImplementation((path, options) =>
      serverWith(4)(path, { query: { ...options.query, offset: '1' } })
    )
    rerender({ logsVersion: 1 })
    await waitFor(() => expect(result.current.items).toHaveLength(4))
    expect(result.current.items.map(item => item.id)).toEqual(['log-0', 'log-1', 'log-2', 'log-3'])
  })

  it('resets the list on a new refresh token', async () => {
    apiGet.mockImplementation(serverWith(20))
    const { result, rerender } = renderHook(
      ({ refreshToken }) => useLogList({ filters, isDebouncing: false, refreshToken }),
      { wrapper: createWrapper(), initialProps: { refreshToken: 0 } }
    )
    await waitFor(() => expect(result.current.items).toHaveLength(PAGE_SIZE))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(20))

    apiGet.mockImplementation(serverWith(0))
    rerender({ refreshToken: 1 })
    await waitFor(() => expect(result.current.items).toHaveLength(0))
    expect(result.current.total).toBe(0)
    expect(result.current.hasMore).toBe(false)
  })

  it('polls the first page only while the stream is closed and the page is not full', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiGet.mockImplementation(serverWith(2))
    const { result, rerender } = renderHook(
      ({ eventsConnected }) => useLogList({ filters, isDebouncing: false, eventsConnected }),
      { wrapper: createWrapper(), initialProps: { eventsConnected: false } }
    )
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(apiGet).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(apiGet).toHaveBeenCalledTimes(2)

    rerender({ eventsConnected: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500)
    })
    expect(apiGet).toHaveBeenCalledTimes(2)
  })
})
