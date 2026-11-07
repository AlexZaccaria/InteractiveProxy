'use strict'

/**
 * Filter-rule suggestions: per-host traffic counters (with the most frequent
 * paths and the last time the host was seen) maintained as entries enter and
 * leave the log window, and the ranked list served by
 * `/api/filters/suggestions`.
 *
 * `createSuggestionTracker` returns one self-contained instance; the log
 * store calls `onAdd` / `onRemove` from its hooks.
 */

const { hostPatternMatches } = require('../rules/url-match')
const { extractHostInfoFromLog, sanitizePathForSuggestions } = require('./stats')

/** @typedef {import('./search').LogEntry} LogEntry */
/** @typedef {import('./store').LogStore} LogStore */

/**
 * Compiled filter-rule matcher as built by the routing layer.
 *
 * @typedef {{ raw: string, value: string, type: string }} BypassMatcher
 */

/**
 * @typedef {object} SuggestionRecord
 * @property {string} host
 * @property {number} count
 * @property {number} lastSeen
 * @property {Map<string, number>} pathCounts
 */

/**
 * @typedef {object} Suggestion
 * @property {string} pattern
 * @property {number} count
 * @property {number | null} lastSeen
 * @property {{ path: string, count: number }[]} samplePaths
 */

/**
 * @typedef {object} SuggestionTracker
 * @property {(logEntry: LogEntry) => void} onAdd Account for an entry that entered the window.
 * @property {(logEntry: LogEntry, store: LogStore) => void} onRemove Account for an evicted entry; the store is scanned to recompute the host's last-seen time.
 * @property {(options?: { limit?: number }) => Suggestion[]} compute Ranked suggestions, hosts already covered by a host rule excluded.
 * @property {() => void} reset Forget every counter.
 */

/**
 * @typedef {object} SuggestionTrackerOptions
 * @property {() => BypassMatcher[]} getBypassMatchers The current filter-rule matchers.
 */

/**
 * @param {SuggestionTrackerOptions} options
 * @returns {SuggestionTracker}
 */
function createSuggestionTracker({ getBypassMatchers }) {
  /** @type {Map<string, SuggestionRecord>} */
  const bypassSuggestionStats = new Map()
  /** @type {WeakMap<object, { host: string, pathKey: string, timestamp: number | null }>} */
  let logSuggestionMetadata = new WeakMap()

  /**
   * @param {LogEntry} logEntry
   */
  function onAdd(logEntry) {
    const hostInfo = extractHostInfoFromLog(logEntry)
    if (!hostInfo?.host) return

    const hostKey = hostInfo.host
    let record = bypassSuggestionStats.get(hostKey)
    if (!record) {
      record = {
        host: hostKey,
        count: 0,
        lastSeen: 0,
        pathCounts: new Map()
      }
      bypassSuggestionStats.set(hostKey, record)
    }

    record.count += 1

    if (logEntry.timestamp) {
      const ts = Date.parse(logEntry.timestamp)
      if (!Number.isNaN(ts)) {
        record.lastSeen = Math.max(record.lastSeen, ts)
      }
    }

    const pathKey = sanitizePathForSuggestions(hostInfo.path)
    const prevPathCount = record.pathCounts.get(pathKey) || 0
    record.pathCounts.set(pathKey, prevPathCount + 1)

    logSuggestionMetadata.set(logEntry, {
      host: hostKey,
      pathKey,
      timestamp: logEntry.timestamp ? Date.parse(logEntry.timestamp) : null
    })
  }

  /**
   * @param {LogEntry} logEntry
   * @param {LogStore} store
   */
  function onRemove(logEntry, store) {
    const meta = logSuggestionMetadata.get(logEntry)
    if (!meta?.host) return

    const record = bypassSuggestionStats.get(meta.host)
    if (!record) {
      logSuggestionMetadata.delete(logEntry)
      return
    }

    record.count = Math.max(0, record.count - 1)

    if (meta.pathKey && record.pathCounts.has(meta.pathKey)) {
      const next = (record.pathCounts.get(meta.pathKey) || 0) - 1
      if (next > 0) {
        record.pathCounts.set(meta.pathKey, next)
      } else {
        record.pathCounts.delete(meta.pathKey)
      }
    }

    if (record.count === 0) {
      bypassSuggestionStats.delete(meta.host)
    } else if (meta.timestamp && record.lastSeen === meta.timestamp) {
      let newLastSeen = 0
      store.forEachNewestFirst(log => {
        if (!log || typeof log !== 'object') return
        const info = logSuggestionMetadata.get(log)
        if (info?.host === meta.host && info.timestamp && info.timestamp > newLastSeen) {
          newLastSeen = info.timestamp
        }
      })
      record.lastSeen = newLastSeen
    }

    logSuggestionMetadata.delete(logEntry)
  }

  /**
   * @param {{ limit?: number }} [options]
   * @returns {Suggestion[]}
   */
  function compute({ limit = 10 } = {}) {
    const cappedLimit = Math.max(1, Math.min(50, limit))
    const bypassMatchers = getBypassMatchers()

    const results = Array.from(bypassSuggestionStats.values())
      .filter(
        record =>
          !bypassMatchers.some(
            matcher => matcher.type === 'host' && hostPatternMatches(matcher.value, record.host)
          )
      )
      .map(record => {
        const topPaths = Array.from(record.pathCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([path, count]) => ({ path, count }))

        return {
          pattern: record.host,
          count: record.count,
          lastSeen: record.lastSeen || null,
          samplePaths: topPaths
        }
      })
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        if (b.lastSeen !== a.lastSeen) return (b.lastSeen || 0) - (a.lastSeen || 0)
        return a.pattern.localeCompare(b.pattern)
      })
      .slice(0, cappedLimit)

    return results
  }

  function reset() {
    bypassSuggestionStats.clear()
    logSuggestionMetadata = new WeakMap()
  }

  return { onAdd, onRemove, compute, reset }
}

module.exports = { createSuggestionTracker }
