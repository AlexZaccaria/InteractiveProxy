import { create } from 'zustand'
import { apiPost } from '../lib/api'
import { queryClient } from '../lib/queryClient'
import { applyThemeToDocument, resolveInitialTheme, storeTheme } from '../lib/theme'

/**
 * Global UI state: the proxy's flags (mirrored from GET /api/config and the
 * `config` events), the event-stream status and the navigation state that
 * several tabs share. Server data lives in the query cache, not here.
 */

/** @typedef {import('../lib/types').FilterMode} FilterMode */
/** @typedef {import('../lib/types').ConfigSnapshot} ConfigSnapshot */
/** @typedef {import('../lib/theme').Theme} Theme */

/**
 * API flag name → store field.
 *
 * @type {Record<string, 'interactiveModeEnabled' | 'editRulesEnabled' | 'localResourcesEnabled' | 'filterRulesEnabled' | 'blockedRulesEnabled' | 'breakpointsEnabled' | 'throttlingEnabled'>}
 */
export const FLAG_FIELDS = {
  'interactive-mode': 'interactiveModeEnabled',
  'edit-rules-mode': 'editRulesEnabled',
  'local-resources-mode': 'localResourcesEnabled',
  'filter-rules-mode': 'filterRulesEnabled',
  'blocked-rules-mode': 'blockedRulesEnabled',
  'breakpoints-mode': 'breakpointsEnabled',
  'throttling-mode': 'throttlingEnabled'
}

/** @typedef {keyof typeof FLAG_FIELDS} FlagName */

/**
 * @typedef {Object} JsonPathRuleSeed
 * @property {string} [name]
 * @property {string} [path]
 * @property {any} [value]
 * @property {string} [valueType]
 * @property {string} [url]
 * @property {'request' | 'response' | 'both'} [target]
 */

/**
 * @typedef {Object} ProxyStore
 * @property {boolean} interactiveModeEnabled
 * @property {boolean} editRulesEnabled
 * @property {boolean} localResourcesEnabled
 * @property {boolean} filterRulesEnabled
 * @property {boolean} blockedRulesEnabled
 * @property {boolean} breakpointsEnabled
 * @property {boolean} throttlingEnabled
 * @property {FilterMode} filterMode
 * @property {boolean} eventsConnected
 * @property {string} activeTab
 * @property {boolean} showAuditPanel
 * @property {boolean} showShortcutsHelp
 * @property {Theme} theme The theme in use; `setTheme` applies it to the document.
 * @property {JsonPathRuleSeed | null} jsonPathRuleSeed
 * @property {(snapshot: Partial<ConfigSnapshot> | null | undefined) => void} applyConfig Copy the flags present in a config payload.
 * @property {(flag: FlagName, enabled: boolean) => Promise<void>} setFlagOnServer POST the flag, then mirror the server's answer.
 * @property {(mode: FilterMode) => Promise<void>} setFilterModeOnServer POST the filter mode, then mirror the server's answer.
 * @property {(connected: boolean) => void} setEventsConnected
 * @property {(tab: string) => void} setActiveTab
 * @property {(visible: boolean) => void} setShowAuditPanel
 * @property {() => void} toggleAuditPanel
 * @property {(visible: boolean) => void} setShowShortcutsHelp
 * @property {() => void} toggleShortcutsHelp
 * @property {(theme: Theme, options?: { persist?: boolean }) => void} setTheme Apply the theme to the document and, unless `persist` is false, store the choice.
 * @property {() => void} toggleTheme
 * @property {(seed: JsonPathRuleSeed | null) => void} setJsonPathRuleSeed
 */

/**
 * @param {unknown} value
 * @returns {FilterMode}
 */
function normalizeFilterMode(value) {
  return value === 'focus' ? 'focus' : 'ignore'
}

export const useProxyStore = create(
  /** @type {import('zustand').StateCreator<ProxyStore>} */ (
    (set, get) => ({
      interactiveModeEnabled: true,
      editRulesEnabled: true,
      localResourcesEnabled: true,
      filterRulesEnabled: true,
      blockedRulesEnabled: true,
      breakpointsEnabled: true,
      throttlingEnabled: true,
      filterMode: 'ignore',
      eventsConnected: false,
      activeTab: 'logs',
      showAuditPanel: false,
      showShortcutsHelp: false,
      theme: resolveInitialTheme(),
      jsonPathRuleSeed: null,

      applyConfig: snapshot => {
        if (!snapshot || typeof snapshot !== 'object') return
        /** @type {Partial<ProxyStore>} */
        const next = {}
        for (const field of Object.values(FLAG_FIELDS)) {
          const value = snapshot[field]
          if (typeof value === 'boolean') next[field] = value
        }
        if (snapshot.filterMode) next.filterMode = normalizeFilterMode(snapshot.filterMode)
        set(next)
      },

      setFlagOnServer: async (flag, enabled) => {
        const field = FLAG_FIELDS[flag]
        const data = await apiPost(`/api/${flag}`, { enabled })
        const value = data && typeof data[field] === 'boolean' ? data[field] : enabled
        set({ [field]: value })
        queryClient.invalidateQueries({ queryKey: ['config'] })
      },

      setFilterModeOnServer: async mode => {
        const normalized = normalizeFilterMode(mode)
        const data = await apiPost('/api/filter-mode', { mode: normalized })
        set({ filterMode: normalizeFilterMode(data && data.filterMode) })
        queryClient.invalidateQueries({ queryKey: ['config'] })
        queryClient.invalidateQueries({ queryKey: ['filters'] })
        queryClient.invalidateQueries({ queryKey: ['filter-metrics'] })
        queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      },

      setEventsConnected: connected => set({ eventsConnected: connected }),
      setActiveTab: tab => set({ activeTab: tab }),
      setShowAuditPanel: visible => set({ showAuditPanel: visible }),
      toggleAuditPanel: () => set(state => ({ showAuditPanel: !state.showAuditPanel })),
      setShowShortcutsHelp: visible => set({ showShortcutsHelp: visible }),
      toggleShortcutsHelp: () => set(state => ({ showShortcutsHelp: !state.showShortcutsHelp })),
      setTheme: (theme, { persist = true } = {}) => {
        applyThemeToDocument(theme)
        if (persist) storeTheme(theme)
        set({ theme })
      },
      toggleTheme: () => {
        const theme = get().theme === 'dark' ? 'light' : 'dark'
        applyThemeToDocument(theme)
        storeTheme(theme)
        set({ theme })
      },
      setJsonPathRuleSeed: seed => set({ jsonPathRuleSeed: seed })
    })
  )
)
