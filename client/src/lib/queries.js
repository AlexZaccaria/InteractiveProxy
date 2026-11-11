import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiGet, apiPost, apiPut, apiUpload } from './api'
import { useProxyStore } from '../store/useProxyStore'

/**
 * Query and mutation hooks over the management API. Every key is listed in
 * `queryKeys`; mutations invalidate what they change (and resolve once the
 * active queries have been refetched), App.jsx invalidates from the event
 * stream.
 */

/** @typedef {import('./types').FilterMode} FilterMode */
/** @typedef {import('./types').ConfigSnapshot} ConfigSnapshot */
/** @typedef {import('./types').DashboardPayload} DashboardPayload */
/** @typedef {import('./types').EditRule} EditRule */
/** @typedef {import('./types').EditRulePreset} EditRulePreset */
/** @typedef {import('./types').EditRuleUsage} EditRuleUsage */
/** @typedef {import('./types').BlockedRule} BlockedRule */
/** @typedef {import('./types').FilterRule} FilterRule */
/** @typedef {import('./types').FilterSuggestion} FilterSuggestion */
/** @typedef {import('./types').LocalResource} LocalResource */
/** @typedef {import('./types').AuditSnapshot} AuditSnapshot */

export const queryKeys = {
  config: ['config'],
  dashboard: ['dashboard'],
  editRules: ['edit-rules'],
  editRulePresets: ['edit-rule-presets'],
  editRuleUsage: ['edit-rules-usage'],
  blocked: ['blocked'],
  /** Root of every `['filters', mode]` key, for invalidation. */
  filtersRoot: ['filters'],
  /** @param {FilterMode} mode */
  filters: mode => ['filters', mode],
  filterSuggestions: ['filter-suggestions'],
  filterMetrics: ['filter-metrics'],
  resources: ['resources'],
  audit: ['audit'],
  /** The breakpoint rules; also the prefix of the pending key. */
  breakpoints: ['breakpoints'],
  /** The flows held at a breakpoint (`{ items }`). */
  breakpointsPending: ['breakpoints', 'pending'],
  /** The network-condition rules (latency, bandwidth cap). */
  throttle: ['throttle'],
  /** Root of the log list and detail keys, for the reset when the logs are cleared. */
  logsRoot: ['logs'],
  /**
   * The paged list for a filter set (`features/logs/useLogList.js`).
   * @param {import('../features/logs/filters').LogFilters} filters
   */
  logs: filters => ['logs', 'list', filters],
  /**
   * The full view of one entry (`features/logs/useLogDetail.js`).
   * @param {string | number} id
   */
  logDetail: id => ['logs', 'detail', String(id)],
  /**
   * The replay form of one entry (`features/logs/ReplayDialog.jsx`).
   * @param {string | number} id
   */
  logReplay: id => ['logs', 'replay', String(id)]
}

/**
 * @typedef {Object} PollingOptions
 * @property {boolean} [enabled]
 * @property {number | false} [refetchInterval] Polling period while the event stream is not open.
 */

/** @returns {import('@tanstack/react-query').UseQueryResult<ConfigSnapshot>} */
export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: ({ signal }) => apiGet('/api/config', { signal })
  })
}

/**
 * @param {PollingOptions} [options]
 * @returns {import('@tanstack/react-query').UseQueryResult<DashboardPayload>}
 */
export function useDashboard(options = {}) {
  const { enabled = true, refetchInterval = false } = options
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: ({ signal }) => apiGet('/api/dashboard', { signal }),
    enabled,
    refetchInterval
  })
}

/** @returns {import('@tanstack/react-query').UseQueryResult<EditRule[]>} */
export function useEditRules() {
  return useQuery({
    queryKey: queryKeys.editRules,
    queryFn: ({ signal }) => apiGet('/api/edit-rules', { signal }),
    select: data => (data && Array.isArray(data.rules) ? data.rules : [])
  })
}

/** @returns {import('@tanstack/react-query').UseQueryResult<EditRulePreset[]>} */
export function useEditRulePresets() {
  return useQuery({
    queryKey: queryKeys.editRulePresets,
    queryFn: ({ signal }) => apiGet('/api/edit-rule-presets', { signal }),
    select: data => (data && Array.isArray(data.presets) ? data.presets : [])
  })
}

/** @returns {import('@tanstack/react-query').UseQueryResult<EditRuleUsage>} */
export function useEditRuleUsage() {
  return useQuery({
    queryKey: queryKeys.editRuleUsage,
    queryFn: ({ signal }) => apiGet('/api/edit-rules/usage', { signal }),
    select: data => ({
      usage: data && typeof data === 'object' && data.usage ? data.usage : {},
      totalRulesWithUsage:
        data && typeof data.totalRulesWithUsage === 'number' ? data.totalRulesWithUsage : 0
    })
  })
}

/**
 * The blocked endpoint answers an array on GET and `{ blockedRules }` on POST.
 *
 * @param {any} payload
 * @returns {BlockedRule[]}
 */
export function normalizeBlockedRules(payload) {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.blockedRules)) return payload.blockedRules
  return []
}

/** @returns {import('@tanstack/react-query').UseQueryResult<BlockedRule[]>} */
export function useBlockedRules() {
  return useQuery({
    queryKey: queryKeys.blocked,
    queryFn: ({ signal }) => apiGet('/api/blocked', { signal }),
    select: normalizeBlockedRules
  })
}

/**
 * @param {FilterMode} mode
 * @returns {import('@tanstack/react-query').UseQueryResult<FilterRule[]>}
 */
export function useFilterRules(mode) {
  return useQuery({
    queryKey: queryKeys.filters(mode),
    queryFn: ({ signal }) => apiGet('/api/filters', { signal, query: { mode } }),
    select: data => (Array.isArray(data) ? data : [])
  })
}

/**
 * @param {PollingOptions} [options]
 * @returns {import('@tanstack/react-query').UseQueryResult<FilterSuggestion[]>}
 */
export function useFilterSuggestions(options = {}) {
  const { enabled = true, refetchInterval = false } = options
  return useQuery({
    queryKey: queryKeys.filterSuggestions,
    queryFn: ({ signal }) => apiGet('/api/filters/suggestions', { signal }),
    select: data => (data && Array.isArray(data.suggestions) ? data.suggestions : []),
    enabled,
    refetchInterval
  })
}

/** @returns {import('@tanstack/react-query').UseQueryResult<{ totalFiltered: number, activeRules: number }>} */
export function useFilterMetrics() {
  return useQuery({
    queryKey: queryKeys.filterMetrics,
    queryFn: ({ signal }) => apiGet('/api/filters/metrics', { signal })
  })
}

/** @returns {import('@tanstack/react-query').UseQueryResult<LocalResource[]>} */
export function useResources() {
  return useQuery({
    queryKey: queryKeys.resources,
    queryFn: ({ signal }) => apiGet('/api/resources', { signal }),
    select: data => (Array.isArray(data) ? data : [])
  })
}

/**
 * @param {PollingOptions} [options]
 * @returns {import('@tanstack/react-query').UseQueryResult<AuditSnapshot>}
 */
export function useAudit(options = {}) {
  const { enabled = true, refetchInterval = false } = options
  return useQuery({
    queryKey: queryKeys.audit,
    queryFn: ({ signal }) => apiGet('/api/audit', { signal }),
    enabled,
    refetchInterval
  })
}

/**
 * Toggle one of the proxy's flags (`interactive-mode`, `edit-rules-mode`, ...);
 * the store mirrors the server's answer.
 *
 * @param {import('../store/useProxyStore').FlagName} flag
 */
export function useSetFlag(flag) {
  const setFlagOnServer = useProxyStore(state => state.setFlagOnServer)
  return useMutation({
    /** @param {boolean} enabled */
    mutationFn: enabled => setFlagOnServer(flag, enabled),
    onError: error => console.error(`Failed to set ${flag}:`, error)
  })
}

export function useSetFilterMode() {
  const setFilterModeOnServer = useProxyStore(state => state.setFilterModeOnServer)
  return useMutation({
    /** @param {FilterMode} mode */
    mutationFn: mode => setFilterModeOnServer(mode),
    onError: error => console.error('Failed to set filter mode:', error)
  })
}

/**
 * Add, update or remove a blocked rule (`POST /api/blocked`).
 */
export function useBlockedRuleMutation() {
  const client = useQueryClient()
  return useMutation({
    /** @param {{ action: 'add' | 'update' | 'remove', id?: string, url?: string, name?: string, enabled?: boolean }} payload */
    mutationFn: payload => apiPost('/api/blocked', payload),
    onSuccess: data => {
      client.setQueryData(queryKeys.blocked, normalizeBlockedRules(data))
      return Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.blocked }),
        client.invalidateQueries({ queryKey: queryKeys.dashboard })
      ])
    }
  })
}

/**
 * Add, update or remove a filter rule (`POST /api/filters`).
 */
export function useFilterRuleMutation() {
  const client = useQueryClient()
  return useMutation({
    /** @param {{ action: 'add' | 'update' | 'remove', id?: string, url?: string, name?: string, enabled?: boolean, mode?: FilterMode }} payload */
    mutationFn: payload => apiPost('/api/filters', payload),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.filtersRoot }),
        client.invalidateQueries({ queryKey: queryKeys.filterMetrics }),
        client.invalidateQueries({ queryKey: queryKeys.filterSuggestions }),
        client.invalidateQueries({ queryKey: queryKeys.dashboard })
      ])
  })
}

export function useEditRuleMutations() {
  const client = useQueryClient()
  const invalidate = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.editRules }),
      client.invalidateQueries({ queryKey: queryKeys.editRuleUsage })
    ])
  const create = useMutation({
    /** @param {Partial<EditRule>} payload */
    mutationFn: payload => apiPost('/api/edit-rules', payload),
    onSuccess: invalidate
  })
  const update = useMutation({
    /** @param {{ id: string, patch: Partial<EditRule> }} input */
    mutationFn: ({ id, patch }) => apiPut(`/api/edit-rules/${encodeURIComponent(id)}`, patch),
    onSuccess: invalidate
  })
  const remove = useMutation({
    /** @param {string} id */
    mutationFn: id => apiDelete(`/api/edit-rules/${encodeURIComponent(id)}`),
    onSuccess: invalidate
  })
  return { create, update, remove }
}

export function usePresetMutations() {
  const client = useQueryClient()
  const invalidate = () => client.invalidateQueries({ queryKey: queryKeys.editRulePresets })
  const create = useMutation({
    /** @param {{ name: string, kind: 'text' | 'jsonPath', rule: Partial<EditRule> }} payload */
    mutationFn: payload => apiPost('/api/edit-rule-presets', payload),
    onSuccess: invalidate
  })
  const remove = useMutation({
    /** @param {string} id */
    mutationFn: id => apiDelete(`/api/edit-rule-presets/${encodeURIComponent(id)}`),
    onSuccess: invalidate
  })
  return { create, remove }
}

/**
 * Open the native file picker on the proxy's host (`POST /api/system/file-picker`,
 * Windows only, 501 elsewhere). Resolves with the chosen absolute path, or
 * `null` when the dialog was canceled.
 */
export function useFilePicker() {
  return useMutation({
    /**
     * @param {{ title?: string, filter?: string, kind?: 'file' | 'folder' }} [options]
     * @returns {Promise<string | null>}
     */
    mutationFn: async options => {
      const result = await apiPost('/api/system/file-picker', options || {})
      if (!result || result.canceled) return null
      return typeof result.path === 'string' && result.path ? result.path : null
    }
  })
}

/**
 * Upload a file whose content becomes the value of a JSONPath rule
 * (`POST /api/edit-rules/value-file`, multipart field `file`). Resolves with
 * the stored filename, the original name and the detected value type.
 */
export function useValueFileUpload() {
  return useMutation({
    /**
     * @param {File} file
     * @returns {Promise<{ filename: string, originalName: string, valueType: string }>}
     */
    mutationFn: file => {
      const formData = new FormData()
      formData.append('file', file)
      return apiUpload('/api/edit-rules/value-file', formData)
    }
  })
}

export function useResourceMutations() {
  const client = useQueryClient()
  const invalidate = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.resources }),
      client.invalidateQueries({ queryKey: queryKeys.dashboard })
    ])
  const create = useMutation({
    /** @param {FormData} formData */
    mutationFn: formData => apiUpload('/api/resources', formData),
    onSuccess: invalidate
  })
  const createFolder = useMutation({
    /** @param {{ url: string, folderPath: string, fallthrough: boolean }} mapping */
    mutationFn: mapping => apiPost('/api/resources', mapping),
    onSuccess: invalidate
  })
  const toggle = useMutation({
    /** @param {{ url: string, enabled: boolean }} input */
    mutationFn: input => apiPost('/api/resources/toggle', input),
    onSuccess: invalidate
  })
  const remove = useMutation({
    /** @param {string} url */
    mutationFn: url => apiDelete(`/api/resources/${encodeURIComponent(url)}`),
    onSuccess: invalidate
  })
  return { create, createFolder, toggle, remove }
}

export function useClearLogs() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => apiDelete('/api/logs'),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.dashboard }),
        client.invalidateQueries({ queryKey: queryKeys.audit }),
        client.invalidateQueries({ queryKey: queryKeys.editRuleUsage })
      ])
  })
}

/** @typedef {import('./types').ReplayDescription} ReplayDescription */
/** @typedef {import('./types').ReplayOverrides} ReplayOverrides */
/** @typedef {import('./types').ReplayResult} ReplayResult */
/** @typedef {import('./types').CurlCommand} CurlCommand */

/**
 * The replay form of an entry, fetched when the dialog opens and not kept
 * afterwards (the entry may have been evicted in the meantime).
 *
 * @param {string | number} id
 * @returns {import('@tanstack/react-query').UseQueryResult<ReplayDescription>}
 */
export function useReplayForm(id) {
  return useQuery({
    queryKey: queryKeys.logReplay(id),
    queryFn: ({ signal }) =>
      apiGet(`/api/logs/${encodeURIComponent(String(id))}/replay`, { signal }),
    staleTime: 0,
    gcTime: 0
  })
}

/**
 * Sends an entry again through the proxy. The new entry reaches the list
 * through the event stream; the dashboard is refetched for the counters.
 *
 * @returns {import('@tanstack/react-query').UseMutationResult<ReplayResult, Error, { id: string | number, request: ReplayOverrides }>}
 */
export function useReplayLog() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, request }) =>
      apiPost(`/api/logs/${encodeURIComponent(String(id))}/replay`, request),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.dashboard })
  })
}

/**
 * The curl command that repeats an entry.
 *
 * @param {string | number} id
 * @returns {Promise<CurlCommand>}
 */
export function fetchCurlCommand(id) {
  return apiGet(`/api/logs/${encodeURIComponent(String(id))}/curl`)
}

/** @typedef {import('./types').BreakpointRule} BreakpointRule */
/** @typedef {import('./types').PausedBreakpoint} PausedBreakpoint */
/** @typedef {import('./types').BreakpointEvent} BreakpointEvent */

/**
 * The breakpoints endpoint answers an array on GET and `{ breakpointRules }` on POST.
 *
 * @param {any} payload
 * @returns {BreakpointRule[]}
 */
export function normalizeBreakpointRules(payload) {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.breakpointRules)) return payload.breakpointRules
  return []
}

/** @returns {import('@tanstack/react-query').UseQueryResult<BreakpointRule[]>} */
export function useBreakpointRules() {
  return useQuery({
    queryKey: queryKeys.breakpoints,
    queryFn: ({ signal }) => apiGet('/api/breakpoints', { signal }),
    select: normalizeBreakpointRules
  })
}

/**
 * Add, update or remove a breakpoint rule (`POST /api/breakpoints`).
 */
export function useBreakpointRuleMutation() {
  const client = useQueryClient()
  return useMutation({
    /** @param {{ action: 'add' | 'update' | 'remove', id?: string, url?: string, name?: string, enabled?: boolean, phase?: string }} payload */
    mutationFn: payload => apiPost('/api/breakpoints', payload),
    onSuccess: data => {
      client.setQueryData(queryKeys.breakpoints, normalizeBreakpointRules(data))
    }
  })
}

/**
 * The flows held at a breakpoint. The list is kept current by the
 * `breakpoint` events (`applyBreakpointEvent`) and refetched when the
 * stream (re)opens.
 *
 * @returns {import('@tanstack/react-query').UseQueryResult<PausedBreakpoint[]>}
 */
export function usePendingBreakpoints() {
  return useQuery({
    queryKey: queryKeys.breakpointsPending,
    queryFn: ({ signal }) => apiGet('/api/breakpoints/pending', { signal }),
    select: data => (data && Array.isArray(data.items) ? data.items : [])
  })
}

/**
 * @param {import('@tanstack/react-query').QueryClient} client
 * @param {string} id
 */
function removePendingBreakpoint(client, id) {
  client.setQueryData(
    queryKeys.breakpointsPending,
    /** @param {{ items?: PausedBreakpoint[] } | undefined} previous */ previous =>
      previous && Array.isArray(previous.items)
        ? { items: previous.items.filter(item => item.id !== id) }
        : previous
  )
}

/**
 * Apply a `breakpoint` event of the stream to the pending list.
 *
 * @param {import('@tanstack/react-query').QueryClient} client
 * @param {BreakpointEvent | null | undefined} event
 */
export function applyBreakpointEvent(client, event) {
  if (!event || typeof event !== 'object') return
  if (event.action === 'paused' && event.item) {
    const item = event.item
    client.setQueryData(
      queryKeys.breakpointsPending,
      /** @param {{ items?: PausedBreakpoint[] } | undefined} previous */ previous => {
        const items = previous && Array.isArray(previous.items) ? previous.items : []
        if (items.some(existing => existing.id === item.id)) return previous
        return { items: [...items, item] }
      }
    )
  } else if (event.action === 'resumed' && event.id) {
    removePendingBreakpoint(client, event.id)
  }
}

/**
 * Send a paused flow on, with the edits of the editor
 * (`POST /api/breakpoints/pending/:id/resume`).
 */
export function useResumeBreakpoint() {
  const client = useQueryClient()
  return useMutation({
    /** @param {{ id: string, overrides: Record<string, unknown> }} params */
    mutationFn: ({ id, overrides }) =>
      apiPost(`/api/breakpoints/pending/${encodeURIComponent(id)}/resume`, overrides),
    onSuccess: (_data, { id }) => removePendingBreakpoint(client, id)
  })
}

/**
 * Abort a paused flow (`POST /api/breakpoints/pending/:id/abort`); the
 * client gets a 502.
 */
export function useAbortBreakpoint() {
  const client = useQueryClient()
  return useMutation({
    /** @param {string} id */
    mutationFn: id => apiPost(`/api/breakpoints/pending/${encodeURIComponent(id)}/abort`),
    onSuccess: (_data, id) => removePendingBreakpoint(client, id)
  })
}

/** @typedef {import('./types').ThrottleRule} ThrottleRule */

/**
 * The throttle endpoint answers an array on GET and `{ throttleRules }` on POST.
 *
 * @param {any} payload
 * @returns {ThrottleRule[]}
 */
export function normalizeThrottleRules(payload) {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.throttleRules)) return payload.throttleRules
  return []
}

/** @returns {import('@tanstack/react-query').UseQueryResult<ThrottleRule[]>} */
export function useThrottleRules() {
  return useQuery({
    queryKey: queryKeys.throttle,
    queryFn: ({ signal }) => apiGet('/api/throttle', { signal }),
    select: normalizeThrottleRules
  })
}

/**
 * Add, update or remove a network-condition rule (`POST /api/throttle`).
 */
export function useThrottleRuleMutation() {
  const client = useQueryClient()
  return useMutation({
    /** @param {{ action: 'add' | 'update' | 'remove', id?: string, url?: string, name?: string, enabled?: boolean, delayMs?: number, throttleKbps?: number }} payload */
    mutationFn: payload => apiPost('/api/throttle', payload),
    onSuccess: data => {
      client.setQueryData(queryKeys.throttle, normalizeThrottleRules(data))
    }
  })
}
