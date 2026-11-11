import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILE_TYPES,
  DEFAULT_METHODS,
  DEFAULT_SOURCES,
  EXPORT_LIMIT,
  STORAGE_KEYS,
  buildExportQuery,
  buildLogsQuery,
  filtersToQuery,
  migrateStoredSources,
  readStoredBoolean,
  readStoredList,
  readStoredSources,
  readStoredString
} from './filters'

/** @type {import('./filters').LogFilters} */
const defaults = {
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

/**
 * @param {Record<string, string>} entries
 * @returns {import('./filters').FilterStorage}
 */
function storageOf(entries) {
  return {
    getItem: key => (key in entries ? entries[key] : null),
    setItem: (key, value) => {
      entries[key] = value
    }
  }
}

describe('filtersToQuery', () => {
  it('sends the lists and the WebSocket flag, omitting empty searches and unset flags', () => {
    expect(filtersToQuery(defaults)).toEqual({
      sources: 'proxied,mitm,websocket,imported',
      methods: 'GET,POST,PUT,DELETE,PATCH',
      fileTypes: 'json,html,css,js,image,video,audio,font,other',
      showWsConnections: 'false'
    })
  })

  it('sends the searches and the flags when set and skips empty lists', () => {
    expect(
      filtersToQuery({
        ...defaults,
        search: 'api; !tracking',
        requestSearch: 'token',
        responseSearch: 'ok',
        requestRewrittenOnly: true,
        responseRewrittenOnly: true,
        sources: [],
        methods: ['GET'],
        fileTypes: [],
        showWsConnections: true
      })
    ).toEqual({
      search: 'api; !tracking',
      requestSearch: 'token',
      responseSearch: 'ok',
      requestRewrittenOnly: 'true',
      responseRewrittenOnly: 'true',
      methods: 'GET',
      showWsConnections: 'true'
    })
  })
})

describe('buildLogsQuery', () => {
  it('adds the page and the summary view', () => {
    expect(buildLogsQuery(defaults, 30, 15)).toMatchObject({
      offset: '30',
      limit: '15',
      view: 'summary',
      showWsConnections: 'false'
    })
  })
})

describe('buildExportQuery', () => {
  it('exports the marked ids and ignores the filters', () => {
    expect(buildExportQuery({ ...defaults, search: 'x' }, ['a', '', 'b'])).toEqual({
      offset: '0',
      limit: String(EXPORT_LIMIT),
      ids: 'a,b'
    })
  })

  it('exports what the filters match when nothing is marked', () => {
    const query = buildExportQuery({ ...defaults, search: 'x' }, [])
    expect(query.ids).toBeUndefined()
    expect(query.view).toBeUndefined()
    expect(query).toMatchObject({ offset: '0', limit: String(EXPORT_LIMIT), search: 'x' })
  })
})

describe('stored filters', () => {
  it('reads strings, booleans and lists with fallbacks', () => {
    const storage = storageOf({
      [STORAGE_KEYS.searchTerm]: 'api',
      [STORAGE_KEYS.requestRewrittenOnly]: 'true',
      [STORAGE_KEYS.responseRewrittenOnly]: '"yes"',
      [STORAGE_KEYS.methods]: '["GET", 3, "HEAD"]',
      [STORAGE_KEYS.fileTypes]: '{not json'
    })
    expect(readStoredString(storage, STORAGE_KEYS.searchTerm, '')).toBe('api')
    expect(readStoredString(storage, 'missing', 'x')).toBe('x')
    expect(readStoredBoolean(storage, STORAGE_KEYS.requestRewrittenOnly, false)).toBe(true)
    expect(readStoredBoolean(storage, STORAGE_KEYS.responseRewrittenOnly, false)).toBe(false)
    expect(readStoredList(storage, STORAGE_KEYS.methods, DEFAULT_METHODS)).toEqual(['GET', 'HEAD'])
    expect(readStoredList(storage, STORAGE_KEYS.fileTypes, DEFAULT_FILE_TYPES)).toBe(
      DEFAULT_FILE_TYPES
    )
    expect(readStoredBoolean(null, STORAGE_KEYS.showWsConnections, true)).toBe(true)
  })

  it('migrates the pre-2.0 sources', () => {
    expect(migrateStoredSources(['proxied', 'tunnel'])).toEqual(['proxied', 'websocket'])
    expect(migrateStoredSources(['direct', 'websocket'])).toEqual(['websocket'])
    expect(migrateStoredSources(['mitm'])).toEqual(['mitm'])
    expect(migrateStoredSources(['proxied', 'mitm', 'websocket'])).toEqual([
      'proxied',
      'mitm',
      'websocket',
      'imported'
    ])
    expect(migrateStoredSources(['proxied', 'imported'])).toEqual(['proxied', 'imported'])
    expect(migrateStoredSources(['bogus'])).toEqual(DEFAULT_SOURCES)
    expect(readStoredSources(storageOf({ [STORAGE_KEYS.sources]: '["tunnel"]' }))).toEqual([
      'websocket'
    ])
    expect(readStoredSources(storageOf({}))).toEqual(DEFAULT_SOURCES)
  })
})
