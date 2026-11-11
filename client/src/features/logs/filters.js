/**
 * The filter model of the log list: the option lists, the defaults, the
 * localStorage keys the filters have persisted under since 1.0, and the
 * query strings `GET /api/logs` and `GET /api/logs/export` expect.
 */

/** Entries per page of the list. */
export const PAGE_SIZE = 15

/** Upper bound of one export (the server's log window). */
export const EXPORT_LIMIT = 5000

/** @type {Array<{ key: string, label: string }>} */
export const SOURCE_OPTIONS = [
  { key: 'proxied', label: 'HTTP' },
  { key: 'mitm', label: 'HTTPS' },
  { key: 'websocket', label: 'WebSocket' },
  { key: 'imported', label: 'Imported' }
]

/** @type {string[]} */
export const METHOD_OPTIONS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'CONNECT',
  'OPTIONS',
  'HEAD'
]

/** @type {Array<{ key: string, label: string }>} */
export const FILE_TYPE_OPTIONS = [
  { key: 'json', label: 'JSON' },
  { key: 'html', label: 'HTML' },
  { key: 'css', label: 'CSS' },
  { key: 'js', label: 'JavaScript' },
  { key: 'image', label: 'Images' },
  { key: 'video', label: 'Video' },
  { key: 'audio', label: 'Audio' },
  { key: 'font', label: 'Font' },
  { key: 'other', label: 'Other' }
]

/** The transport sources; `local`, `blocked` and `error` entries are always listed by the server. */
export const DEFAULT_SOURCES = SOURCE_OPTIONS.map(option => option.key)

/** `CONNECT`, `OPTIONS` and `HEAD` are off by default. */
export const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

export const DEFAULT_FILE_TYPES = FILE_TYPE_OPTIONS.map(option => option.key)

export const STORAGE_KEYS = {
  searchTerm: 'proxyFilters_searchTerm',
  requestRewrittenOnly: 'proxyFilters_requestRewrittenOnly',
  responseRewrittenOnly: 'proxyFilters_responseRewrittenOnly',
  sources: 'proxyFilters_sources',
  methods: 'proxyFilters_methods',
  fileTypes: 'proxyFilters_fileTypes',
  showWsConnections: 'proxyFilters_showWsConnections'
}

/**
 * The filters a list query is keyed on. The three text searches are the
 * applied values (after the debounce), not what the user is typing.
 *
 * @typedef {Object} LogFilters
 * @property {string} search URL search (`;` and, `!` not, `||` or; parsed by the server).
 * @property {string} requestSearch
 * @property {string} responseSearch
 * @property {boolean} requestRewrittenOnly
 * @property {boolean} responseRewrittenOnly
 * @property {string[]} sources
 * @property {string[]} methods
 * @property {string[]} fileTypes
 * @property {boolean} showWsConnections
 */

/**
 * @typedef {Pick<Storage, 'getItem' | 'setItem'>} FilterStorage
 */

/**
 * @param {FilterStorage | null | undefined} storage
 * @param {string} key
 * @returns {string | null}
 */
function readRaw(storage, key) {
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

/**
 * @param {FilterStorage | null | undefined} storage
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
export function readStoredString(storage, key, fallback) {
  const raw = readRaw(storage, key)
  return raw === null ? fallback : raw
}

/**
 * A JSON boolean; anything unparseable or of another type yields the fallback.
 *
 * @param {FilterStorage | null | undefined} storage
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function readStoredBoolean(storage, key, fallback) {
  const raw = readRaw(storage, key)
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'boolean' ? parsed : fallback
  } catch {
    return fallback
  }
}

/**
 * A JSON array of strings; anything else yields the fallback.
 *
 * @param {FilterStorage | null | undefined} storage
 * @param {string} key
 * @param {string[]} fallback
 * @returns {string[]}
 */
export function readStoredList(storage, key, fallback) {
  const raw = readRaw(storage, key)
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    return parsed.filter(value => typeof value === 'string')
  } catch {
    return fallback
  }
}

/**
 * Sources saved before 2.0 could contain `tunnel` and `direct`; only the
 * transport sources are kept, and `websocket` replaces the removed ones. An
 * empty result falls back to the defaults.
 *
 * @param {string[]} saved
 * @returns {string[]}
 */
export function migrateStoredSources(saved) {
  const filtered = saved.filter(source => DEFAULT_SOURCES.includes(source))
  if ((saved.includes('tunnel') || saved.includes('direct')) && !filtered.includes('websocket')) {
    filtered.push('websocket')
  }
  // A list saved before the `imported` source existed, with every source of
  // that time selected, keeps every source selected.
  const sourcesBeforeImport = ['proxied', 'mitm', 'websocket']
  if (
    !filtered.includes('imported') &&
    sourcesBeforeImport.every(source => filtered.includes(source))
  ) {
    filtered.push('imported')
  }
  return filtered.length > 0 ? filtered : [...DEFAULT_SOURCES]
}

/**
 * @param {FilterStorage | null | undefined} storage
 * @returns {string[]}
 */
export function readStoredSources(storage) {
  const raw = readRaw(storage, STORAGE_KEYS.sources)
  if (!raw) return [...DEFAULT_SOURCES]
  return migrateStoredSources(readStoredList(storage, STORAGE_KEYS.sources, DEFAULT_SOURCES))
}

/**
 * The query parameters of a filter set, exactly as the server reads them:
 * text searches and the rewritten-only flags only when set, the lists only
 * when non-empty, `showWsConnections` always.
 *
 * @param {LogFilters} filters
 * @returns {Record<string, string>}
 */
export function filtersToQuery(filters) {
  /** @type {Record<string, string>} */
  const query = {}
  if (filters.search) query.search = filters.search
  if (filters.requestSearch) query.requestSearch = filters.requestSearch
  if (filters.responseSearch) query.responseSearch = filters.responseSearch
  if (filters.requestRewrittenOnly) query.requestRewrittenOnly = 'true'
  if (filters.responseRewrittenOnly) query.responseRewrittenOnly = 'true'
  if (filters.sources.length) query.sources = filters.sources.join(',')
  if (filters.methods.length) query.methods = filters.methods.join(',')
  if (filters.fileTypes.length) query.fileTypes = filters.fileTypes.join(',')
  query.showWsConnections = String(filters.showWsConnections)
  return query
}

/**
 * The query of one page of `GET /api/logs` in the summary view.
 *
 * @param {LogFilters} filters
 * @param {number} offset
 * @param {number} limit
 * @returns {Record<string, string>}
 */
export function buildLogsQuery(filters, offset, limit) {
  return {
    offset: String(offset),
    limit: String(limit),
    view: 'summary',
    ...filtersToQuery(filters)
  }
}

/**
 * The query of `GET /api/logs/export`: the marked entries by id when there
 * are any (the filters are then ignored), otherwise everything the filters
 * match.
 *
 * @param {LogFilters} filters
 * @param {string[]} selectedIds
 * @returns {Record<string, string>}
 */
export function buildExportQuery(filters, selectedIds) {
  const ids = selectedIds.filter(Boolean)
  if (ids.length > 0) {
    return { offset: '0', limit: String(EXPORT_LIMIT), ids: ids.join(',') }
  }
  return { offset: '0', limit: String(EXPORT_LIMIT), ...filtersToQuery(filters) }
}
