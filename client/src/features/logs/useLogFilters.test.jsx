import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEYS } from './filters'
import { TEXT_FILTER_DEBOUNCE_MS, useLogFilters } from './useLogFilters'

describe('useLogFilters', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts from the defaults and persists them', () => {
    const { result } = renderHook(() => useLogFilters())
    expect(result.current.filters).toEqual({
      search: '',
      requestSearch: '',
      responseSearch: '',
      requestRewrittenOnly: false,
      responseRewrittenOnly: false,
      sources: ['proxied', 'mitm', 'websocket'],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      fileTypes: ['json', 'html', 'css', 'js', 'image', 'video', 'audio', 'font', 'other'],
      showWsConnections: false
    })
    expect(localStorage.getItem(STORAGE_KEYS.methods)).toBe('["GET","POST","PUT","DELETE","PATCH"]')
    expect(localStorage.getItem(STORAGE_KEYS.showWsConnections)).toBe('false')
  })

  it('restores the persisted filters', () => {
    localStorage.setItem(STORAGE_KEYS.searchTerm, 'api')
    localStorage.setItem(STORAGE_KEYS.sources, '["tunnel"]')
    localStorage.setItem(STORAGE_KEYS.requestRewrittenOnly, 'true')
    const { result } = renderHook(() => useLogFilters())
    expect(result.current.searchTerm).toBe('api')
    expect(result.current.filters.search).toBe('api')
    expect(result.current.filters.sources).toEqual(['websocket'])
    expect(result.current.filters.requestRewrittenOnly).toBe(true)
    expect(result.current.isDebouncing).toBe(false)
  })

  it('applies a text search after the debounce', () => {
    const { result } = renderHook(() => useLogFilters())
    const before = result.current.filters

    act(() => result.current.setSearchTerm('users'))
    expect(result.current.searchTerm).toBe('users')
    expect(result.current.isDebouncing).toBe(true)
    expect(result.current.filters).toBe(before)

    act(() => {
      vi.advanceTimersByTime(TEXT_FILTER_DEBOUNCE_MS - 1)
    })
    expect(result.current.filters).toBe(before)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.isDebouncing).toBe(false)
    expect(result.current.filters.search).toBe('users')
    expect(localStorage.getItem(STORAGE_KEYS.searchTerm)).toBe('users')
  })

  it('restarts the debounce on every keystroke', () => {
    const { result } = renderHook(() => useLogFilters())
    act(() => result.current.setRequestBodySearch('a'))
    act(() => {
      vi.advanceTimersByTime(TEXT_FILTER_DEBOUNCE_MS - 100)
    })
    act(() => result.current.setRequestBodySearch('ab'))
    act(() => {
      vi.advanceTimersByTime(TEXT_FILTER_DEBOUNCE_MS - 100)
    })
    expect(result.current.filters.requestSearch).toBe('')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current.filters.requestSearch).toBe('ab')
  })

  it('applies the other filters at once and persists them', () => {
    const { result } = renderHook(() => useLogFilters())
    act(() => result.current.toggleMethod('GET'))
    expect(result.current.filters.methods).toEqual(['POST', 'PUT', 'DELETE', 'PATCH'])
    act(() => result.current.toggleMethod('HEAD'))
    expect(result.current.filters.methods).toEqual(['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'])
    act(() => result.current.toggleSource('mitm'))
    expect(result.current.filters.sources).toEqual(['proxied', 'websocket'])
    act(() => result.current.toggleFileType('json'))
    expect(result.current.filters.fileTypes).not.toContain('json')
    act(() => result.current.toggleResponseRewrittenOnly())
    expect(result.current.filters.responseRewrittenOnly).toBe(true)
    act(() => result.current.setShowWsConnections(true))
    expect(result.current.filters.showWsConnections).toBe(true)
    expect(result.current.isDebouncing).toBe(false)
    expect(localStorage.getItem(STORAGE_KEYS.sources)).toBe('["proxied","websocket"]')
    expect(localStorage.getItem(STORAGE_KEYS.responseRewrittenOnly)).toBe('true')
  })
})
