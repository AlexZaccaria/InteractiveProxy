import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_FILE_TYPES,
  DEFAULT_METHODS,
  STORAGE_KEYS,
  readStoredBoolean,
  readStoredList,
  readStoredSources,
  readStoredString
} from './filters'

/** @typedef {import('./filters').LogFilters} LogFilters */
/** @typedef {import('./filters').FilterStorage} FilterStorage */

/** Quiet time after the last keystroke before a text search is applied. */
export const TEXT_FILTER_DEBOUNCE_MS = 1000

/**
 * @typedef {Object} LogFilterState
 * @property {LogFilters} filters The applied filters (the list query's key).
 * @property {string} searchTerm What the user is typing in the URL search.
 * @property {string} requestBodySearch
 * @property {string} responseSearchTerm
 * @property {boolean} isDebouncing True while a typed search differs from the applied one.
 * @property {(value: string) => void} setSearchTerm
 * @property {(value: string) => void} setRequestBodySearch
 * @property {(value: string) => void} setResponseSearchTerm
 * @property {() => void} toggleRequestRewrittenOnly
 * @property {() => void} toggleResponseRewrittenOnly
 * @property {(source: string) => void} toggleSource
 * @property {(method: string) => void} toggleMethod
 * @property {(fileType: string) => void} toggleFileType
 * @property {(value: boolean) => void} setShowWsConnections
 */

/**
 * @param {string[]} list
 * @param {string} value
 * @returns {string[]}
 */
function toggleInList(list, value) {
  return list.includes(value) ? list.filter(item => item !== value) : [...list, value]
}

/**
 * The filter state of the log list. The URL search, the rewritten-only
 * flags, the sources, the methods, the file types and the WebSocket
 * connection flag persist in localStorage under the 1.0 keys; the request
 * and response searches do not. Text searches apply after a debounce, the
 * other filters at once.
 *
 * @param {FilterStorage | null | undefined} [storage]
 * @returns {LogFilterState}
 */
export function useLogFilters(storage = globalThis.localStorage) {
  const [searchTerm, setSearchTerm] = useState(() =>
    readStoredString(storage, STORAGE_KEYS.searchTerm, '')
  )
  const [requestBodySearch, setRequestBodySearch] = useState('')
  const [responseSearchTerm, setResponseSearchTerm] = useState('')
  const [appliedText, setAppliedText] = useState(() => ({
    search: readStoredString(storage, STORAGE_KEYS.searchTerm, ''),
    requestSearch: '',
    responseSearch: ''
  }))

  const [requestRewrittenOnly, setRequestRewrittenOnly] = useState(() =>
    readStoredBoolean(storage, STORAGE_KEYS.requestRewrittenOnly, false)
  )
  const [responseRewrittenOnly, setResponseRewrittenOnly] = useState(() =>
    readStoredBoolean(storage, STORAGE_KEYS.responseRewrittenOnly, false)
  )
  const [sources, setSources] = useState(() => readStoredSources(storage))
  const [methods, setMethods] = useState(() =>
    readStoredList(storage, STORAGE_KEYS.methods, DEFAULT_METHODS)
  )
  const [fileTypes, setFileTypes] = useState(() =>
    readStoredList(storage, STORAGE_KEYS.fileTypes, DEFAULT_FILE_TYPES)
  )
  const [showWsConnections, setShowWsConnections] = useState(() =>
    readStoredBoolean(storage, STORAGE_KEYS.showWsConnections, false)
  )

  const persist = useCallback(
    /**
     * @param {string} key
     * @param {string} value
     */
    (key, value) => {
      if (!storage) return
      try {
        storage.setItem(key, value)
      } catch {
        // Storage full or disabled: the filters simply do not persist.
      }
    },
    [storage]
  )

  useEffect(() => persist(STORAGE_KEYS.searchTerm, searchTerm), [persist, searchTerm])
  useEffect(
    () => persist(STORAGE_KEYS.requestRewrittenOnly, JSON.stringify(requestRewrittenOnly)),
    [persist, requestRewrittenOnly]
  )
  useEffect(
    () => persist(STORAGE_KEYS.responseRewrittenOnly, JSON.stringify(responseRewrittenOnly)),
    [persist, responseRewrittenOnly]
  )
  useEffect(() => persist(STORAGE_KEYS.sources, JSON.stringify(sources)), [persist, sources])
  useEffect(() => persist(STORAGE_KEYS.methods, JSON.stringify(methods)), [persist, methods])
  useEffect(() => persist(STORAGE_KEYS.fileTypes, JSON.stringify(fileTypes)), [persist, fileTypes])
  useEffect(
    () => persist(STORAGE_KEYS.showWsConnections, JSON.stringify(showWsConnections)),
    [persist, showWsConnections]
  )

  const isDebouncing =
    searchTerm !== appliedText.search ||
    requestBodySearch !== appliedText.requestSearch ||
    responseSearchTerm !== appliedText.responseSearch

  useEffect(() => {
    if (!isDebouncing) return undefined
    const timer = setTimeout(() => {
      setAppliedText({
        search: searchTerm,
        requestSearch: requestBodySearch,
        responseSearch: responseSearchTerm
      })
    }, TEXT_FILTER_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [isDebouncing, searchTerm, requestBodySearch, responseSearchTerm])

  const filters = useMemo(
    () => ({
      search: appliedText.search,
      requestSearch: appliedText.requestSearch,
      responseSearch: appliedText.responseSearch,
      requestRewrittenOnly,
      responseRewrittenOnly,
      sources,
      methods,
      fileTypes,
      showWsConnections
    }),
    [
      appliedText,
      requestRewrittenOnly,
      responseRewrittenOnly,
      sources,
      methods,
      fileTypes,
      showWsConnections
    ]
  )

  const toggleRequestRewrittenOnly = useCallback(
    () => setRequestRewrittenOnly(previous => !previous),
    []
  )
  const toggleResponseRewrittenOnly = useCallback(
    () => setResponseRewrittenOnly(previous => !previous),
    []
  )
  const toggleSource = useCallback(
    /** @param {string} source */
    source => setSources(previous => toggleInList(previous, source)),
    []
  )
  const toggleMethod = useCallback(
    /** @param {string} method */
    method => setMethods(previous => toggleInList(previous, method)),
    []
  )
  const toggleFileType = useCallback(
    /** @param {string} fileType */
    fileType => setFileTypes(previous => toggleInList(previous, fileType)),
    []
  )

  return {
    filters,
    searchTerm,
    requestBodySearch,
    responseSearchTerm,
    isDebouncing,
    setSearchTerm,
    setRequestBodySearch,
    setResponseSearchTerm,
    toggleRequestRewrittenOnly,
    toggleResponseRewrittenOnly,
    toggleSource,
    toggleMethod,
    toggleFileType,
    setShowWsConnections
  }
}
