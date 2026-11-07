import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../../lib/api'
import { queryKeys } from '../../lib/queries'

/** @typedef {import('../../lib/types').LogSummary} LogSummary */
/** @typedef {import('../../lib/types').LogDetail} LogDetail */

/**
 * How long a fetched detail is reused without a new request. An entry can
 * still change for a short while after it is logged (a response arriving
 * after its request), so it is not cached forever.
 */
const DETAIL_STALE_MS = 30_000

/**
 * The full view of one entry (`GET /api/logs/:id`), fetched only while
 * `enabled`. Both body sections of a card share this query, so opening
 * them costs one request.
 *
 * @param {string | number | null | undefined} id
 * @param {boolean} enabled
 * @returns {import('@tanstack/react-query').UseQueryResult<LogDetail>}
 */
export function useLogDetail(id, enabled) {
  return useQuery({
    queryKey: queryKeys.logDetail(id ?? ''),
    queryFn: ({ signal }) => apiGet(`/api/logs/${encodeURIComponent(String(id))}`, { signal }),
    enabled: enabled && id !== null && id !== undefined && id !== '',
    staleTime: DETAIL_STALE_MS
  })
}

/**
 * The entry to render in a body section: the detail once fetched, the
 * summary meanwhile.
 *
 * @param {LogSummary} log
 * @param {boolean} enabled
 * @returns {{ effectiveLog: LogSummary | LogDetail, isLoading: boolean, error: string | null }}
 */
export function useEffectiveLog(log, enabled) {
  const query = useLogDetail(log ? log.id : null, enabled)
  return {
    effectiveLog: query.data || log,
    isLoading: query.isLoading,
    error: query.error ? query.error.message || String(query.error) : null
  }
}
