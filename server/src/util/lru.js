'use strict'

/**
 * Small bounded cache with least-recently-used eviction, built on the
 * insertion order of `Map`: a hit moves the entry to the end, an insert
 * beyond the capacity drops the entry at the front.
 */

/**
 * @template K, V
 * @typedef {object} LruCache
 * @property {(key: K) => V | undefined} get
 * @property {(key: K) => boolean} has
 * @property {(key: K, value: V) => void} set
 * @property {(key: K) => boolean} delete
 * @property {() => void} clear
 * @property {() => number} size
 */

/**
 * Create a cache holding at most `maxEntries` values.
 *
 * @template K, V
 * @param {number} maxEntries
 * @returns {LruCache<K, V>}
 */
function createLruCache(maxEntries) {
  const capacity = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 1
  /** @type {Map<K, V>} */
  const entries = new Map()

  return {
    get(key) {
      if (!entries.has(key)) return undefined
      const value = /** @type {V} */ (entries.get(key))
      // Re-insert so the entry becomes the most recently used one.
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    has(key) {
      return entries.has(key)
    },
    set(key, value) {
      if (entries.has(key)) {
        entries.delete(key)
      } else if (entries.size >= capacity) {
        const oldest = entries.keys().next()
        if (!oldest.done) {
          entries.delete(oldest.value)
        }
      }
      entries.set(key, value)
    },
    delete(key) {
      return entries.delete(key)
    },
    clear() {
      entries.clear()
    },
    size() {
      return entries.size
    }
  }
}

module.exports = { createLruCache }
