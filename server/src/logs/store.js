'use strict'

/**
 * In-memory log window: a ring buffer of the newest `maxEntries` entries plus
 * a `Map` by id, so that adding, evicting the oldest and looking an entry up
 * are all O(1) and both iteration orders need no copy.
 *
 * `createLogStore` returns one self-contained instance. Entries are enriched
 * on insertion (blocked-rule visibility, search text and snapshots, file type,
 * per-request metrics) and the `onAdd` / `onRemove` hooks let the statistics
 * and suggestion trackers follow the window; evicted entries also release
 * their edit-rule usage counters.
 */

const { getLogUrlString, getFileTypeFromLogEntry, ensureLogSearchSnapshots } = require('./search')
const { computeLogEntryMetrics } = require('./stats')
const { logDebug, logError } = require('../util/logger')

/** @typedef {import('./search').LogEntry} LogEntry */

/**
 * @typedef {object} LogStoreOptions
 * @property {number} maxEntries Capacity of the window (entries beyond it evict the oldest).
 * @property {{ releaseUsage: (ids: Iterable<unknown>) => void }} ruleStore Edit-rule usage counters to release on eviction.
 * @property {() => boolean} isInteractive Whether interactive logging is on; when off, `add` is a no-op.
 * @property {() => string[]} getBlockedPatterns Blocked-rule URL substrings that hide entries from the log view.
 * @property {(entry: LogEntry) => void} onAdd Called after an entry entered the window.
 * @property {(entry: LogEntry) => void} onRemove Called after an entry was evicted (the new entry is already in).
 */

/**
 * @typedef {object} LogStore
 * @property {number} capacity
 * @property {(entry: LogEntry) => void} add Enrich, insert as newest, evict the oldest when full.
 * @property {(id: unknown) => LogEntry | undefined} findById
 * @property {(entry: LogEntry) => void} touch Re-notify the entry listeners for an entry that changed after insertion.
 * @property {() => void} clear Drop every entry (counters of other trackers are reset by their owners).
 * @property {() => number} size
 * @property {(fn: (entry: LogEntry) => void) => void} forEachOldestFirst
 * @property {(fn: (entry: LogEntry) => void) => void} forEachNewestFirst
 * @property {() => LogEntry[]} toArrayNewestFirst
 * @property {() => void} recomputeBlockedVisibility Refresh `hiddenByBlockedRules` on every entry after the blocked rules change.
 * @property {() => string[]} getBlockedPatterns The current blocked-rule patterns (as injected).
 * @property {(listener: (entry: LogEntry) => void) => () => void} onEntryAdded Subscribe to new entries (after the `onAdd` hook); returns the unsubscribe function.
 * @property {(listener: () => void) => () => void} onCleared Subscribe to `clear()`; returns the unsubscribe function.
 */

/**
 * @param {LogStoreOptions} options
 * @returns {LogStore}
 */
function createLogStore({
  maxEntries,
  ruleStore,
  isInteractive,
  getBlockedPatterns,
  onAdd,
  onRemove
}) {
  const capacity = Math.max(1, Math.floor(Number(maxEntries)) || 1)

  // Ring buffer: `head` is the slot the next entry is written to. When the
  // window is full that slot holds the oldest entry, which is the one evicted.
  // Newest entry: slots[(head - 1 + capacity) % capacity]; oldest entry:
  // slots[(head - count + capacity) % capacity].
  /** @type {(LogEntry | undefined)[]} */
  let slots = new Array(capacity)
  let head = 0
  let count = 0
  /** @type {Map<string, LogEntry>} */
  let byId = new Map()

  // Change listeners (event stream): kept apart from the onAdd/onRemove hooks
  // so that subscribers can come and go without touching the wiring.
  /** @type {Set<(entry: LogEntry) => void>} */
  const entryListeners = new Set()
  /** @type {Set<() => void>} */
  const clearListeners = new Set()

  /**
   * @param {LogEntry | undefined} entry
   * @returns {string | null}
   */
  function idKey(entry) {
    if (!entry || typeof entry !== 'object' || entry.id === undefined || entry.id === null)
      return null
    return String(entry.id)
  }

  /**
   * @param {LogEntry} entry
   */
  function add(entry) {
    if (!isInteractive()) return
    if (entry && typeof entry === 'object') {
      // Precompute whether this log should be hidden by blocked URL rules. This
      // moves the cost of blocked URL matching to log insertion and rules
      // updates instead of every /api/logs request.
      try {
        const blockedPatterns = getBlockedPatterns()
        const patterns = Array.isArray(blockedPatterns) ? blockedPatterns : []
        if (patterns.length > 0) {
          const urlString = getLogUrlString(entry)
          if (urlString) {
            entry.hiddenByBlockedRules = patterns.some(pattern => urlString.includes(pattern))
          }
        }
      } catch (error) {
        logDebug('logs', 'Could not evaluate the blocked patterns for a log entry', error)
      }

      // Precompute base search text for global search (URL, method, target/local info)
      const parts = [
        entry.url || '',
        entry.method || '',
        entry.targetUrl || '',
        entry.localResource || ''
      ]
      entry.searchBase = parts.join(' ').toLowerCase()

      // Precompute fileType once per log entry when it's first added
      if (!entry.fileType) {
        entry.fileType = getFileTypeFromLogEntry(entry)
      }

      // Precompute request/response search snapshots (body + Connect + raw preview)
      ensureLogSearchSnapshots(entry)

      // Compute lightweight per-request metrics used by the audit panel
      computeLogEntryMetrics(entry)
    }

    /** @type {LogEntry | undefined} */
    let evicted
    if (count === capacity) {
      evicted = slots[head]
    }
    slots[head] = entry
    head = (head + 1) % capacity
    if (count < capacity) count++

    const key = idKey(entry)
    if (key !== null) byId.set(key, entry)

    if (evicted !== undefined) {
      const evictedKey = idKey(evicted)
      // A newer entry with the same id keeps its place in the index.
      if (evictedKey !== null && byId.get(evictedKey) === evicted) byId.delete(evictedKey)
    }

    onAdd(entry)

    for (const listener of entryListeners) {
      try {
        listener(entry)
      } catch (error) {
        logError('logs', 'Log entry listener failed', error)
      }
    }

    if (evicted) {
      onRemove(evicted)
      // Keep edit rule usage counters aligned with the current in-memory
      // window by decrementing counts for any rules that were recorded on
      // the evicted log entry.
      if (Array.isArray(evicted.rewrites)) {
        ruleStore.releaseUsage(evicted.rewrites.map(rewrite => rewrite && rewrite.id))
      }
    }
  }

  /**
   * @param {unknown} id
   * @returns {LogEntry | undefined}
   */
  function findById(id) {
    if (id === undefined || id === null) return undefined
    return byId.get(String(id))
  }

  /**
   * Tell the entry listeners that an entry already in the window changed
   * (a response edited at a breakpoint after it was logged).
   *
   * @param {LogEntry} entry
   */
  function touch(entry) {
    const key = idKey(entry)
    if (key === null || byId.get(key) !== entry) return
    for (const listener of entryListeners) {
      try {
        listener(entry)
      } catch (error) {
        logError('logs', 'Log entry listener failed', error)
      }
    }
  }

  function clear() {
    slots = new Array(capacity)
    head = 0
    count = 0
    byId = new Map()

    for (const listener of clearListeners) {
      try {
        listener()
      } catch (error) {
        logError('logs', 'Log clear listener failed', error)
      }
    }
  }

  /**
   * @param {(entry: LogEntry) => void} listener
   * @returns {() => void}
   */
  function onEntryAdded(listener) {
    entryListeners.add(listener)
    return () => {
      entryListeners.delete(listener)
    }
  }

  /**
   * @param {() => void} listener
   * @returns {() => void}
   */
  function onCleared(listener) {
    clearListeners.add(listener)
    return () => {
      clearListeners.delete(listener)
    }
  }

  /**
   * @param {(entry: LogEntry) => void} fn
   */
  function forEachOldestFirst(fn) {
    const start = (head - count + capacity) % capacity
    for (let i = 0; i < count; i++) {
      fn(/** @type {LogEntry} */ (slots[(start + i) % capacity]))
    }
  }

  /**
   * @param {(entry: LogEntry) => void} fn
   */
  function forEachNewestFirst(fn) {
    for (let i = 1; i <= count; i++) {
      fn(/** @type {LogEntry} */ (slots[(head - i + capacity) % capacity]))
    }
  }

  /**
   * @returns {LogEntry[]}
   */
  function toArrayNewestFirst() {
    /** @type {LogEntry[]} */
    const result = []
    forEachNewestFirst(entry => {
      result.push(entry)
    })
    return result
  }

  /**
   * Recompute the hiddenByBlockedRules flag on all existing log entries after
   * the blocked rules change, so that the log filter can simply check a
   * boolean per log instead of scanning the blocked patterns list for every
   * entry on each request.
   */
  function recomputeBlockedVisibility() {
    if (count === 0) return

    const blockedPatterns = getBlockedPatterns()
    const patterns = Array.isArray(blockedPatterns) ? blockedPatterns : []

    if (!patterns.length) {
      forEachNewestFirst(log => {
        if (log && typeof log === 'object' && 'hiddenByBlockedRules' in log) {
          delete log.hiddenByBlockedRules
        }
      })
      return
    }

    forEachNewestFirst(log => {
      if (!log || typeof log !== 'object') return
      const urlString = getLogUrlString(log)
      log.hiddenByBlockedRules = urlString
        ? patterns.some(pattern => urlString.includes(pattern))
        : false
    })
  }

  return {
    capacity,
    add,
    findById,
    touch,
    clear,
    size: () => count,
    forEachOldestFirst,
    forEachNewestFirst,
    toArrayNewestFirst,
    recomputeBlockedVisibility,
    getBlockedPatterns: () => getBlockedPatterns(),
    onEntryAdded,
    onCleared
  }
}

module.exports = { createLogStore }
