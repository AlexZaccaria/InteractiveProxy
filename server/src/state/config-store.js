'use strict'

/**
 * Persisted global flags of the proxy (`storage/config.json`): interactive
 * mode, local resources, filter rules, blocked rules and the filter mode.
 *
 * The edit-rules flag lives in the rule store and is read and written through
 * it, so that config.json keeps carrying `editRulesEnabled` as before.
 *
 * @module state/config-store
 */

const fs = require('fs')
const fsPromises = fs.promises

/** @typedef {'ignore' | 'focus'} FilterMode */

/**
 * @typedef {object} ConfigSnapshot
 * @property {boolean} interactiveModeEnabled
 * @property {boolean} editRulesEnabled
 * @property {boolean} localResourcesEnabled
 * @property {boolean} filterRulesEnabled
 * @property {boolean} blockedRulesEnabled
 * @property {FilterMode} filterMode
 */

/**
 * @typedef {object} ConfigStore
 * @property {boolean} interactiveModeEnabled Logging to the in-memory window and the UI.
 * @property {boolean} localResourcesEnabled Serving of uploaded local resources.
 * @property {boolean} filterRulesEnabled Bypass engine (ignore/focus rules).
 * @property {boolean} blockedRulesEnabled Blocked URL rules.
 * @property {FilterMode} filterMode Normalised filter mode; assigning an unknown value is ignored.
 * @property {() => void} load Read config.json synchronously (a missing or invalid file keeps the defaults).
 * @property {() => void} persist Write the flags to config.json, coalescing concurrent writes.
 * @property {() => ConfigSnapshot} snapshot The flags as exposed by `GET /api/config`.
 */

/**
 * @typedef {object} ConfigStoreOptions
 * @property {string} file Path of config.json.
 * @property {{ isEnabled: () => boolean, setEnabled: (value: boolean) => void }} ruleStore Owner of the edit-rules flag.
 */

/**
 * @param {unknown} value
 * @returns {FilterMode | null}
 */
function normalizeFilterMode (value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (normalized === 'focus' || normalized === 'ignore') return normalized
  return null
}

/**
 * Create the configuration store. Nothing is read from disk until `load()`.
 *
 * @param {ConfigStoreOptions} options
 * @returns {ConfigStore}
 */
function createConfigStore ({ file, ruleStore }) {
  let interactiveModeEnabled = true // interactive mode flag
  let localResourcesEnabled = true // global local resources flag
  let filterRulesEnabled = true // global filter rules flag
  let blockedRulesEnabled = true // global blocked rules flag
  /** @type {FilterMode} */
  let filterMode = 'ignore' // bypass mode: 'ignore' (default) or 'focus'
  /** @type {Promise<void> | null} */
  let persistWritePromise = null
  let persistQueued = false

  /**
   * Load interactive mode, filter mode, and global feature modes from disk.
   */
  function load () {
    try {
      if (fs.existsSync(file)) {
        const config = JSON.parse(fs.readFileSync(file, 'utf8'))
        interactiveModeEnabled = config.interactiveModeEnabled !== false
        if (typeof config.editRulesEnabled === 'boolean') {
          ruleStore.setEnabled(config.editRulesEnabled)
        }
        if (typeof config.localResourcesEnabled === 'boolean') {
          localResourcesEnabled = config.localResourcesEnabled
        }
        if (typeof config.filterRulesEnabled === 'boolean') {
          filterRulesEnabled = config.filterRulesEnabled
        }
        if (typeof config.blockedRulesEnabled === 'boolean') {
          blockedRulesEnabled = config.blockedRulesEnabled
        }

        let rawMode = null
        if (typeof config.filterMode === 'string') {
          rawMode = config.filterMode
        } else if (typeof config.bypassMode === 'string') {
          // Legacy key, kept for backward compatibility
          rawMode = config.bypassMode
        }

        const normalized = normalizeFilterMode(rawMode)
        if (normalized) {
          filterMode = normalized
        }
      }
    } catch (error) {
      console.error('Error loading config:', error)
    }
  }

  /**
   * Persist the flags. A write already in progress is not duplicated: the
   * request is queued and a single follow-up write runs when it finishes.
   */
  function persist () {
    if (persistWritePromise) {
      persistQueued = true
      return
    }

    persistWritePromise = (async () => {
      try {
        /** @type {Record<string, unknown>} */
        let existing = {}
        try {
          const raw = await fsPromises.readFile(file, 'utf8')
          existing = JSON.parse(raw) || {}
        } catch (readError) {
          const code = /** @type {{ code?: string } | null} */ (readError)?.code
          if (readError && code !== 'ENOENT') {
            console.error('Error reading config file:', readError)
          }
          existing = {}
        }

        /** @type {Record<string, unknown>} */
        const updated = {
          ...existing,
          interactiveModeEnabled,
          editRulesEnabled: ruleStore.isEnabled(),
          localResourcesEnabled,
          filterRulesEnabled,
          blockedRulesEnabled,
          filterMode
        }

        // Drop legacy key if present
        if (Object.hasOwn(updated, 'bypassMode')) {
          delete updated.bypassMode
        }

        await fsPromises.writeFile(file, JSON.stringify(updated, null, 2))
      } catch (error) {
        console.error('Error saving config:', error)
      } finally {
        persistWritePromise = null
        if (persistQueued) {
          persistQueued = false
          persist()
        }
      }
    })()
  }

  /**
   * @returns {ConfigSnapshot}
   */
  function snapshot () {
    return {
      interactiveModeEnabled,
      editRulesEnabled: ruleStore.isEnabled(),
      localResourcesEnabled,
      filterRulesEnabled,
      blockedRulesEnabled,
      filterMode
    }
  }

  /** @type {ConfigStore} */
  const store = {
    get interactiveModeEnabled () {
      return interactiveModeEnabled
    },
    set interactiveModeEnabled (value) {
      interactiveModeEnabled = value === true
    },
    get localResourcesEnabled () {
      return localResourcesEnabled
    },
    set localResourcesEnabled (value) {
      localResourcesEnabled = value === true
    },
    get filterRulesEnabled () {
      return filterRulesEnabled
    },
    set filterRulesEnabled (value) {
      filterRulesEnabled = value === true
    },
    get blockedRulesEnabled () {
      return blockedRulesEnabled
    },
    set blockedRulesEnabled (value) {
      blockedRulesEnabled = value === true
    },
    get filterMode () {
      return filterMode
    },
    set filterMode (value) {
      const normalized = normalizeFilterMode(value)
      if (normalized) {
        filterMode = normalized
      }
    },
    load,
    persist,
    snapshot
  }

  return store
}

module.exports = {
  normalizeFilterMode,
  createConfigStore
}
