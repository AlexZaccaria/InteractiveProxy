import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  BarChart3,
  CircuitBoard,
  CornerDownRight,
  Download,
  Edit3,
  FileText,
  HardDrive,
  Keyboard,
  Moon,
  ShieldAlert,
  Sun,
  Trash2
} from 'lucide-react'
import RequestLogs from './features/logs/RequestLogs'
import { URL_SEARCH_INPUT_ID } from './features/logs/LogFilters'
import LocalResources from './components/LocalResources'
import BlockedResources from './components/BlockedResources'
import FilterRules from './components/FilterRules'
import EditRules from './features/rules/EditRules'
import Modal from './components/Modal'
import Spinner from './components/Spinner'
import AuditPanel from './components/AuditPanel'
import ShortcutsHelp from './components/ShortcutsHelp'
import Tooltip from './components/Tooltip'
import { useModal } from './hooks/useModal'
import { useProxyEvents } from './hooks/useProxyEvents'
import { isEditableTarget, useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import {
  queryKeys,
  useClearLogs,
  useConfig,
  useDashboard,
  useEditRules,
  useSetFlag
} from './lib/queries'
import { TAB_ORDER } from './lib/shortcuts'
import { readStoredTheme, subscribeToSystemTheme } from './lib/theme'
import { useProxyStore } from './store/useProxyStore'

/** Dashboard polling period while the event stream is not open. */
const DASHBOARD_POLL_MS = 2000
/** Quiet time after a burst of `log` events before the derived queries are refetched. */
const LOG_EVENT_DEBOUNCE_MS = 500

// Below 768 px the tabs keep their natural width in a row that scrolls
// sideways; from 768 px they grow to fill the bar, and from 1024 px they
// share it equally.
const TAB_BASE_CLASS =
  'shrink-0 md:shrink md:grow lg:basis-0 min-w-0 inline-flex items-center justify-center gap-2 px-3 lg:px-4 h-9 rounded-lg text-xs font-medium tracking-wide transition-all duration-150 whitespace-nowrap'
const TAB_INACTIVE_CLASS =
  'border border-transparent text-fg-muted hover:text-fg-base hover:bg-surface-hover'

/** The colours of the header icon buttons by tone; the active state overrides them. */
const ICON_BUTTON_TONE_CLASS = {
  neutral: 'text-fg-muted hover:bg-surface-hover hover:text-fg',
  indigo:
    'text-indigo-300 hover:bg-indigo-600/20 hover:text-indigo-200 disabled:text-fg-dim disabled:hover:bg-transparent',
  red: 'text-red-400 hover:bg-red-600/20 hover:text-red-300 disabled:text-fg-dim disabled:hover:bg-transparent'
}

/**
 * One tab of the tab bar (WAI-ARIA tabs pattern: the selected tab is the
 * only one in the Tab order, the arrows move between tabs).
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {boolean} props.active
 * @param {(id: string) => void} props.onSelect
 * @param {import('react').ComponentType<{ className?: string }>} props.icon
 * @param {import('react').ReactNode} props.label
 * @param {string} props.activeClassName
 */
function TabButton({ id, active, onSelect, icon: Icon, label, activeClassName }) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={active}
      aria-controls={`panel-${id}`}
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(id)}
      className={`${TAB_BASE_CLASS} ${active ? activeClassName : TAB_INACTIVE_CLASS}`}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * One counter of the header: a cell of the 3×2 grid below 768 px, the
 * centred content of one of six equal cells from there.
 *
 * @param {Object} props
 * @param {import('react').ComponentType<{ className?: string }>} props.icon
 * @param {string} props.label
 * @param {number} props.value
 * @param {string} props.colorClassName
 */
function Counter({ icon: Icon, label, value, colorClassName }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Icon className={`w-5 h-5 shrink-0 ${colorClassName}`} />
      <div className="min-w-0">
        <p className="text-xs text-fg-muted truncate">{label}</p>
        <p className={`text-lg font-bold leading-tight tabular-nums ${colorClassName}`}>{value}</p>
      </div>
    </div>
  )
}

/**
 * One button of the segmented icon group of the header. Labelled for
 * assistive technology; the tooltip around it carries the visible label.
 * Any other prop (the tooltip's `aria-describedby`) goes to the button.
 *
 * @param {Object} props
 * @param {string} props.label
 * @param {() => void} props.onClick
 * @param {import('react').ComponentType<{ className?: string }>} props.icon
 * @param {boolean} [props.pressed]
 * @param {boolean} [props.expanded]
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.busy] Shows a spinner in place of the icon.
 * @param {'neutral' | 'indigo' | 'red'} [props.tone]
 * @param {string} [props['aria-describedby']]
 */
function HeaderIconButton({
  label,
  onClick,
  icon: Icon,
  pressed,
  expanded,
  disabled,
  busy,
  tone = 'neutral',
  ...rest
}) {
  const active = pressed || expanded
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      className={`inline-flex items-center justify-center w-8 h-7.5 rounded-md transition-colors disabled:cursor-not-allowed ${
        active
          ? 'bg-surface-active text-fg-strong shadow-[0_0_0_1px_rgba(148,163,184,0.4)]'
          : ICON_BUTTON_TONE_CLASS[tone]
      }`}
      {...rest}
    >
      {busy ? <Spinner size="sm" /> : <Icon className="w-4 h-4" />}
    </button>
  )
}

function App() {
  const { modalState, closeModal, showConfirm, showPrompt, showAlert } = useModal()
  const queryClient = useQueryClient()

  const activeTab = useProxyStore(state => state.activeTab)
  const setActiveTab = useProxyStore(state => state.setActiveTab)
  const interactiveMode = useProxyStore(state => state.interactiveModeEnabled)
  const filterMode = useProxyStore(state => state.filterMode)
  const showAuditPanel = useProxyStore(state => state.showAuditPanel)
  const setShowAuditPanel = useProxyStore(state => state.setShowAuditPanel)
  const toggleAuditPanel = useProxyStore(state => state.toggleAuditPanel)
  const showShortcutsHelp = useProxyStore(state => state.showShortcutsHelp)
  const setShowShortcutsHelp = useProxyStore(state => state.setShowShortcutsHelp)
  const toggleShortcutsHelp = useProxyStore(state => state.toggleShortcutsHelp)
  const theme = useProxyStore(state => state.theme)
  const setTheme = useProxyStore(state => state.setTheme)
  const toggleTheme = useProxyStore(state => state.toggleTheme)
  const setJsonPathRuleSeed = useProxyStore(state => state.setJsonPathRuleSeed)
  const applyConfig = useProxyStore(state => state.applyConfig)
  const setEventsConnected = useProxyStore(state => state.setEventsConnected)

  const [filteredLogsCount, setFilteredLogsCount] = useState(0)
  const [exportLogsFunc, setExportLogsFunc] = useState(null)
  // Bumped when the logs are cleared; RequestLogs reloads from the first page.
  const [logsRefreshToken, setLogsRefreshToken] = useState(0)
  // Bumped on every `log` event; RequestLogs refetches its window (debounced).
  const [logsVersion, setLogsVersion] = useState(0)
  const logEventTimerRef = useRef(null)

  // Stable registration callback for the logs export function so that
  // RequestLogs can be memoized. The function is stored as-is, avoiding the
  // React "functional updater" semantics for state setters.
  const registerExportLogs = useCallback(fn => {
    setExportLogsFunc(() => fn)
  }, [])

  // Live updates from GET /api/events, applied to the query cache. The
  // stream has no replay, so the dashboard is refetched whenever the
  // connection (re)opens; while it is open the polling intervals are off.
  const eventsConnected = useProxyEvents({
    log: () => {
      setLogsVersion(version => version + 1)
      if (logEventTimerRef.current) clearTimeout(logEventTimerRef.current)
      logEventTimerRef.current = setTimeout(() => {
        logEventTimerRef.current = null
        queryClient.invalidateQueries({ queryKey: queryKeys.filterSuggestions })
        queryClient.invalidateQueries({ queryKey: queryKeys.audit })
        queryClient.invalidateQueries({ queryKey: queryKeys.editRuleUsage })
      }, LOG_EVENT_DEBOUNCE_MS)
    },
    stats: data => {
      // Same fields as GET /api/dashboard except `resources` and `blocked`,
      // which are kept from the cached payload (refreshed on `rules` events).
      if (!data || typeof data !== 'object') return
      queryClient.setQueryData(queryKeys.dashboard, previous => ({
        ...data,
        resources: previous && Array.isArray(previous.resources) ? previous.resources : undefined,
        blocked: previous && Array.isArray(previous.blocked) ? previous.blocked : undefined
      }))
    },
    config: data => {
      if (!data || typeof data !== 'object') return
      queryClient.setQueryData(queryKeys.config, previous => ({ ...(previous || {}), ...data }))
      applyConfig(data)
    },
    rules: () => {
      for (const queryKey of [
        queryKeys.editRules,
        queryKeys.editRulePresets,
        queryKeys.editRuleUsage,
        queryKeys.blocked,
        queryKeys.filtersRoot,
        queryKeys.filterMetrics,
        queryKeys.resources,
        queryKeys.dashboard
      ]) {
        queryClient.invalidateQueries({ queryKey })
      }
    },
    'logs-cleared': () => {
      setLogsRefreshToken(token => token + 1)
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      queryClient.invalidateQueries({ queryKey: queryKeys.audit })
      queryClient.invalidateQueries({ queryKey: queryKeys.editRuleUsage })
    }
  })

  useEffect(
    () => () => {
      if (logEventTimerRef.current) clearTimeout(logEventTimerRef.current)
    },
    []
  )

  useEffect(() => {
    setEventsConnected(eventsConnected)
    if (eventsConnected) {
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
    }
  }, [eventsConnected, setEventsConnected, queryClient])

  // Without a stored choice the theme follows the operating system.
  useEffect(
    () =>
      subscribeToSystemTheme(systemTheme => {
        if (!readStoredTheme()) setTheme(systemTheme, { persist: false })
      }),
    [setTheme]
  )

  // The flags are mirrored into the store from the config payload, whether
  // it comes from the query or from a `config` event.
  const configQuery = useConfig()
  useEffect(() => {
    if (configQuery.data) applyConfig(configQuery.data)
  }, [configQuery.data, applyConfig])

  const dashboardQuery = useDashboard({
    enabled: interactiveMode,
    refetchInterval: eventsConnected ? false : DASHBOARD_POLL_MS
  })
  const editRulesQuery = useEditRules()
  const { mutateAsync: clearLogsOnServer, isPending: clearingLogs } = useClearLogs()
  const setInteractiveMode = useSetFlag('interactive-mode')

  const dashboard = dashboardQuery.data
  const header = useMemo(() => {
    const serverStats = (dashboard && dashboard.stats) || {}
    const filterMetrics = (dashboard && dashboard.filterMetrics) || {}
    const totalLogged = serverStats.total ?? 0
    // Processed: requests that go through the proxy internals and are
    // neither blocked nor redirected. Computed on the backend; before the
    // first dashboard payload the counter of the config is shown.
    const processed = dashboard
      ? (serverStats.processed ?? Math.max(0, totalLogged - (serverStats.blocked ?? 0)))
      : (configQuery.data?.filteredRequestCount ?? 0)
    return {
      // Overall logged traffic (HTTP/HTTPS/WebSocket). Bypassed/redirected
      // flows are logged as 'direct'/'tunnel' and already included in the
      // total, so totalFiltered is not added again.
      total: totalLogged,
      blocked: serverStats.blocked ?? 0,
      redirected: filterMetrics.totalFiltered ?? 0,
      processed,
      edited: dashboard?.editedRequests ?? 0,
      served: serverStats.served ?? 0,
      filterRuleCount: filterMetrics.activeRules ?? 0,
      blockedCount: Array.isArray(dashboard?.blocked) ? dashboard.blocked.length : 0,
      resourceCount: Array.isArray(dashboard?.resources) ? dashboard.resources.length : 0,
      routes: dashboard?.routes || null
    }
  }, [dashboard, configQuery.data])
  const editRuleCount = editRulesQuery.data ? editRulesQuery.data.length : 0

  const handleClearLogs = useCallback(async () => {
    try {
      const confirmed = await showConfirm(
        'Clear All Logs',
        'Are you sure you want to clear all logs? This action cannot be undone.'
      )
      if (!confirmed) return

      await clearLogsOnServer()
      setLogsRefreshToken(token => token + 1)
    } catch (error) {
      console.error('Error clearing logs:', error)
    }
  }, [showConfirm, clearLogsOnServer])

  const handleExportLogs = useCallback(() => {
    if (exportLogsFunc && filteredLogsCount > 0) exportLogsFunc()
  }, [exportLogsFunc, filteredLogsCount])

  const handleCreateJsonPathRuleFromLogs = useCallback(
    seed => {
      if (!seed) return
      setJsonPathRuleSeed(seed)
      setActiveTab('edit')
    },
    [setJsonPathRuleSeed, setActiveTab]
  )

  const handleProxyIconClick = useCallback(
    event => {
      // Secret gesture: triple-click on the proxy icon/title block. The
      // synthetic event.detail increments with the click count (1, 2, 3, ...);
      // when it reaches 3, toggle the audit panel.
      if (event?.detail >= 3) {
        toggleAuditPanel()
      }
    },
    [toggleAuditPanel]
  )

  // `/`: the Requests tab with the focus in its URL search. The tab switch
  // renders synchronously, so the field is normally there at once; the
  // animation frame covers the first mount of the tab.
  const focusUrlSearch = useCallback(() => {
    setShowShortcutsHelp(false)
    setActiveTab('logs')
    const focus = () => {
      const field = document.getElementById(URL_SEARCH_INPUT_ID)
      if (field instanceof HTMLElement) field.focus()
      return Boolean(field)
    }
    if (!focus()) requestAnimationFrame(focus)
  }, [setActiveTab, setShowShortcutsHelp])

  const shortcuts = useMemo(
    () => [
      { key: '/', handler: focusUrlSearch },
      { key: 'e', handler: handleExportLogs },
      {
        key: 'c',
        handler: () => {
          void handleClearLogs()
        }
      },
      ...TAB_ORDER.map((tab, index) => ({
        key: String(index + 1),
        handler: () => setActiveTab(tab)
      })),
      { key: '?', handler: toggleShortcutsHelp },
      {
        key: 'Escape',
        allowInEditable: true,
        /** @param {KeyboardEvent} event */
        handler: event => {
          if (isEditableTarget(event.target)) {
            ;/** @type {HTMLElement} */ (event.target).blur()
            return
          }
          setShowShortcutsHelp(false)
        }
      }
    ],
    [
      focusUrlSearch,
      handleExportLogs,
      handleClearLogs,
      setActiveTab,
      toggleShortcutsHelp,
      setShowShortcutsHelp
    ]
  )
  // The audit panel and the dialogs handle their own keys while they are open.
  useKeyboardShortcuts(shortcuts, { enabled: !modalState.isOpen && !showAuditPanel })

  /** @param {React.KeyboardEvent<HTMLDivElement>} event */
  const handleTabListKeyDown = event => {
    const index = TAB_ORDER.indexOf(/** @type {typeof TAB_ORDER[number]} */ (activeTab))
    /** @type {string | null} */
    let next = null
    if (event.key === 'ArrowRight') next = TAB_ORDER[(index + 1) % TAB_ORDER.length]
    else if (event.key === 'ArrowLeft')
      next = TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length]
    else if (event.key === 'Home') next = TAB_ORDER[0]
    else if (event.key === 'End') next = TAB_ORDER[TAB_ORDER.length - 1]
    if (!next) return
    event.preventDefault()
    setActiveTab(next)
    const button = document.getElementById(`tab-${next}`)
    if (button instanceof HTMLElement) button.focus()
  }

  const closeShortcutsHelp = useCallback(() => setShowShortcutsHelp(false), [setShowShortcutsHelp])

  const canExport = Boolean(exportLogsFunc) && filteredLogsCount > 0

  return (
    <>
      <Modal
        isOpen={modalState.isOpen}
        onClose={closeModal}
        title={modalState.title}
        message={modalState.message}
        type={modalState.type}
        onConfirm={modalState.onConfirm}
        showInput={modalState.showInput}
        inputValue={modalState.inputValue}
        inputPlaceholder={modalState.inputPlaceholder}
        examples={modalState.examples}
      />
      {showAuditPanel && (
        <AuditPanel onClose={() => setShowAuditPanel(false)} routes={header.routes} />
      )}

      <div className="min-h-screen bg-surface">
        {/* Header. From 1280 px one row: brand | counters | controls. Below
            that the brand and the controls share the first row and the
            counters take the next: six equal cells with centred content from
            768 px, a 3×2 grid sized to its content and centred below. Below
            768 px the view buttons (theme, audit, shortcuts) are hidden so
            that the first row holds the brand, the pill and the two actions
            down to about 400 px. */}
        <header className="bg-surface-raised border-b border-edge sticky top-0 z-50">
          <div className="px-4 sm:px-6 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 xl:grid xl:grid-cols-[auto_minmax(0,1fr)_auto]">
              {/* Brand */}
              <div
                className="flex items-center gap-2 shrink-0 cursor-default"
                onClick={handleProxyIconClick}
              >
                <div className="bg-blue-500/20 p-1.5 rounded-lg">
                  <Activity
                    className={`w-5 h-5 ${interactiveMode ? 'text-fg-body' : 'text-fg-faint'}`}
                  />
                </div>
                <div>
                  <h1 className="text-base font-bold text-fg leading-tight">Proxy Server</h1>
                  <p className="text-xs text-fg-muted">Request Monitoring</p>
                </div>
              </div>

              {/* Controls: the interactive-mode pill and the icon group. The
                  shortcuts panel hangs under the group's right edge. */}
              <div className="relative ml-auto flex items-center gap-2 shrink-0 xl:order-last xl:ml-0">
                <Tooltip
                  title="Interactive mode"
                  description={
                    interactiveMode
                      ? 'Interactive mode is ON. Requests are logged, decoded and shown in the UI.'
                      : 'Interactive mode is OFF. The proxy forwards traffic without logging it to the UI.'
                  }
                >
                  <div
                    role="group"
                    aria-label="Interactive mode"
                    className="inline-flex items-center rounded-full bg-surface-sunken border border-edge-subtle p-0.5"
                  >
                    <button
                      type="button"
                      onClick={() => !interactiveMode && setInteractiveMode.mutate(true)}
                      className={`px-3 h-7.5 text-[11px] font-medium tracking-wide rounded-full transition-colors duration-150 ${
                        interactiveMode
                          ? 'bg-surface-active text-fg-strong shadow-[0_0_0_1px_rgba(148,163,184,0.4)]'
                          : 'bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-strong'
                      }`}
                      aria-pressed={interactiveMode}
                    >
                      ON
                    </button>
                    <button
                      type="button"
                      onClick={() => interactiveMode && setInteractiveMode.mutate(false)}
                      className={`px-3 h-7.5 text-[11px] font-medium tracking-wide rounded-full transition-colors duration-150 ml-0.5 ${
                        !interactiveMode
                          ? 'bg-surface-active text-fg-strong shadow-[0_0_0_1px_rgba(148,163,184,0.4)]'
                          : 'bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-strong'
                      }`}
                      aria-pressed={!interactiveMode}
                    >
                      OFF
                    </button>
                  </div>
                </Tooltip>

                <div
                  role="group"
                  aria-label="View and actions"
                  className="inline-flex items-center gap-0.5 rounded-lg border border-edge bg-surface-sunken p-0.5"
                >
                  {/* The view buttons, shown from 768 px */}
                  <div className="hidden md:contents">
                    <Tooltip
                      title={
                        theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'
                      }
                    >
                      <HeaderIconButton
                        label={
                          theme === 'dark'
                            ? 'Switch to the light theme'
                            : 'Switch to the dark theme'
                        }
                        onClick={toggleTheme}
                        icon={theme === 'dark' ? Sun : Moon}
                      />
                    </Tooltip>
                    <Tooltip
                      title="Audit panel"
                      description="Errors by status, host timings, routes by handling and the use of each edit rule."
                    >
                      <HeaderIconButton
                        label="Audit panel"
                        onClick={toggleAuditPanel}
                        icon={BarChart3}
                        pressed={showAuditPanel}
                      />
                    </Tooltip>
                    <Tooltip
                      title="Keyboard shortcuts"
                      description="Also opened with the ? key."
                      open={showShortcutsHelp ? false : undefined}
                    >
                      <HeaderIconButton
                        label="Keyboard shortcuts"
                        onClick={toggleShortcutsHelp}
                        icon={Keyboard}
                        expanded={showShortcutsHelp}
                      />
                    </Tooltip>
                    <span className="w-px self-stretch bg-edge mx-0.5" aria-hidden="true" />
                  </div>
                  <Tooltip
                    title="Export logs"
                    description={
                      canExport
                        ? 'Export the current log view to a JSON file. If some requests are marked for export in the list, only those will be included; otherwise all filtered logs are exported.'
                        : 'There are no filtered logs to export yet.'
                    }
                  >
                    <HeaderIconButton
                      label="Export logs"
                      onClick={handleExportLogs}
                      icon={Download}
                      tone="indigo"
                      disabled={!canExport}
                    />
                  </Tooltip>
                  <Tooltip
                    title="Clear logs"
                    description="This will permanently delete all captured request logs from the current session."
                  >
                    <HeaderIconButton
                      label="Clear logs"
                      onClick={handleClearLogs}
                      icon={Trash2}
                      tone="red"
                      disabled={clearingLogs}
                      busy={clearingLogs}
                    />
                  </Tooltip>
                </div>
                {showShortcutsHelp && <ShortcutsHelp onClose={closeShortcutsHelp} />}
              </div>

              {/* Counters */}
              <div className="w-full min-w-0 grid grid-cols-[repeat(3,auto)] justify-center gap-x-6 gap-y-2 md:grid-cols-6 md:justify-items-center md:gap-x-2 xl:max-w-3xl xl:justify-self-center">
                <Counter
                  icon={FileText}
                  label="Total"
                  value={header.total}
                  colorClassName="text-fg"
                />
                <Counter
                  icon={ShieldAlert}
                  label="Blocked"
                  value={header.blocked}
                  colorClassName="text-orange-400"
                />
                <Counter
                  icon={CornerDownRight}
                  label="Redirected"
                  value={header.redirected}
                  colorClassName="text-blue-400"
                />
                <Counter
                  icon={CircuitBoard}
                  label="Processed"
                  value={header.processed}
                  colorClassName="text-purple-400"
                />
                <Counter
                  icon={Edit3}
                  label="Edited"
                  value={header.edited}
                  colorClassName="text-cyan-400"
                />
                <Counter
                  icon={HardDrive}
                  label="Served"
                  value={header.served}
                  colorClassName="text-green-400"
                />
              </div>
            </div>
          </div>
        </header>

        {/* Tabs: one row that scrolls sideways below 768 px */}
        <div className="px-4 sm:px-6 mt-6">
          <div
            role="tablist"
            aria-label="Sections"
            onKeyDown={handleTabListKeyDown}
            className="flex flex-nowrap items-center gap-1 overflow-x-auto scrollbar-none bg-surface-sunken border border-edge-subtle rounded-xl p-1.5"
          >
            <TabButton
              id="logs"
              active={activeTab === 'logs'}
              onSelect={setActiveTab}
              icon={FileText}
              label={<>Requests {filteredLogsCount > 0 && `(${filteredLogsCount})`}</>}
              activeClassName="bg-surface-active border border-fg-faint/70 text-fg-strong shadow-[0_0_0_1px_rgba(148,163,184,0.4)]"
            />
            <TabButton
              id="blocked"
              active={activeTab === 'blocked'}
              onSelect={setActiveTab}
              icon={ShieldAlert}
              label={`Blocked (${header.blockedCount})`}
              activeClassName="bg-orange-600/15 border border-orange-500/70 text-orange-700 dark:text-orange-100 shadow-[0_0_0_1px_rgba(249,115,22,0.4)]"
            />
            <TabButton
              id="filters"
              active={activeTab === 'filters'}
              onSelect={setActiveTab}
              icon={filterMode === 'focus' ? CircuitBoard : CornerDownRight}
              label={`${filterMode === 'focus' ? 'Processed' : 'Redirected'} (${header.filterRuleCount})`}
              activeClassName={
                filterMode === 'focus'
                  ? 'bg-purple-600/15 border border-purple-500/70 text-purple-700 dark:text-purple-100 shadow-[0_0_0_1px_rgba(168,85,247,0.4)]'
                  : 'bg-blue-600/15 border border-blue-500/70 text-blue-700 dark:text-blue-100 shadow-[0_0_0_1px_rgba(37,99,235,0.4)]'
              }
            />
            <TabButton
              id="edit"
              active={activeTab === 'edit'}
              onSelect={setActiveTab}
              icon={Edit3}
              label={`Edited (${editRuleCount})`}
              activeClassName="bg-cyan-600/15 border border-cyan-500/70 text-cyan-700 dark:text-cyan-100 shadow-[0_0_0_1px_rgba(34,211,238,0.4)]"
            />
            <TabButton
              id="resources"
              active={activeTab === 'resources'}
              onSelect={setActiveTab}
              icon={HardDrive}
              label={`Local (${header.resourceCount})`}
              activeClassName="bg-emerald-600/15 border border-emerald-500/70 text-emerald-700 dark:text-emerald-100 shadow-[0_0_0_1px_rgba(16,185,129,0.4)]"
            />
          </div>

          {/* Tab Content */}
          <div
            role="tabpanel"
            id={`panel-${activeTab}`}
            aria-labelledby={`tab-${activeTab}`}
            className="mt-6 pb-8"
          >
            {activeTab === 'logs' && (
              <RequestLogs
                onFilteredCountChange={setFilteredLogsCount}
                onExportLogs={registerExportLogs}
                refreshToken={logsRefreshToken}
                onCreateJsonPathRule={handleCreateJsonPathRuleFromLogs}
                eventsConnected={eventsConnected}
                logsVersion={logsVersion}
              />
            )}
            {activeTab === 'resources' && <LocalResources showConfirm={showConfirm} />}

            {activeTab === 'blocked' && <BlockedResources showConfirm={showConfirm} />}

            {activeTab === 'filters' && <FilterRules showConfirm={showConfirm} />}

            {activeTab === 'edit' && (
              <EditRules showConfirm={showConfirm} showPrompt={showPrompt} showAlert={showAlert} />
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export default App
