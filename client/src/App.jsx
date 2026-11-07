import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  FileText,
  HardDrive,
  ShieldAlert,
  Trash2,
  Download,
  Edit3,
  CornerDownRight,
  CircuitBoard
} from 'lucide-react'
import RequestLogs from './features/logs/RequestLogs'
import LocalResources from './components/LocalResources'
import BlockedResources from './components/BlockedResources'
import FilterRules from './components/FilterRules'
import EditRules from './features/rules/EditRules'
import Modal from './components/Modal'
import Spinner from './components/Spinner'
import AuditPanel from './components/AuditPanel'
import { useModal } from './hooks/useModal'
import { useProxyEvents } from './hooks/useProxyEvents'
import {
  queryKeys,
  useClearLogs,
  useConfig,
  useDashboard,
  useEditRules,
  useSetFlag
} from './lib/queries'
import { useProxyStore } from './store/useProxyStore'

/** Dashboard polling period while the event stream is not open. */
const DASHBOARD_POLL_MS = 2000
/** Quiet time after a burst of `log` events before the derived queries are refetched. */
const LOG_EVENT_DEBOUNCE_MS = 500

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

      <div className="min-h-screen bg-[#0a0a0a]" style={{ minWidth: '1024px' }}>
        {/* Header */}
        <header className="bg-[#1a1a1a] border-b border-[#2a2a2a] sticky top-0 z-50">
          <div className="px-6 py-4" style={{ minWidth: '1024px' }}>
            <div className="grid grid-cols-3 items-center gap-4">
              {/* Logo and Title */}
              <div
                className="flex items-center space-x-2 cursor-default"
                onClick={handleProxyIconClick}
              >
                <div className="bg-blue-500/20 p-1.5 rounded-lg">
                  <Activity
                    className={`w-5 h-5 ${interactiveMode ? 'text-slate-300' : 'text-slate-500'}`}
                  />
                </div>
                <div>
                  <h1 className="text-base font-bold text-white leading-tight">Proxy Server</h1>
                  <p className="text-xs text-slate-400">Request Monitoring</p>
                </div>
              </div>

              {/* Inline Stats - Centered */}
              <div className="flex items-center justify-center gap-4">
                {/* Total / Blocked / Redirected */}
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-slate-300" />
                    <div>
                      <p className="text-xs text-slate-400">Total</p>
                      <p className="text-lg font-bold text-white">{header.total}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-5 h-5 text-orange-400" />
                    <div>
                      <p className="text-xs text-slate-400">Blocked</p>
                      <p className="text-lg font-bold text-orange-400">{header.blocked}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <CornerDownRight className="w-5 h-5 text-blue-400" />
                    <div>
                      <p className="text-xs text-slate-400">Redirected</p>
                      <p className="text-lg font-bold text-blue-400">{header.redirected}</p>
                    </div>
                  </div>
                </div>

                {/* Processed / Edited / Served */}
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <CircuitBoard className="w-5 h-5 text-purple-400" />
                    <div>
                      <p className="text-xs text-slate-400">Processed</p>
                      <p className="text-lg font-bold text-purple-400">{header.processed}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Edit3 className="w-5 h-5 text-cyan-400" />
                    <div>
                      <p className="text-xs text-slate-400">Edited</p>
                      <p className="text-lg font-bold text-cyan-400">{header.edited}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <HardDrive className="w-5 h-5 text-green-400" />
                    <div>
                      <p className="text-xs text-slate-400">Served</p>
                      <p className="text-lg font-bold text-green-400">{header.served}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Buttons - Right aligned */}
              <div className="flex items-center justify-end gap-2">
                {/* Interactive Mode Toggle - two-option pill like Ignore/Focus, ON on the left */}
                <div className="relative group/interactive-mode">
                  <div className="inline-flex items-center rounded-full bg-[#050508] border border-[#252525] p-0.5">
                    <button
                      type="button"
                      onClick={() => !interactiveMode && setInteractiveMode.mutate(true)}
                      className={`px-3 h-8 text-[11px] font-medium tracking-wide rounded-full transform transition-all duration-150 ${
                        interactiveMode
                          ? 'bg-[#18181b] border border-slate-500/70 text-slate-100 shadow-[0_0_0_1px_rgba(148,163,184,0.4)] scale-100'
                          : 'bg-transparent text-slate-400 hover:bg-[#161616] hover:text-slate-100 scale-95'
                      }`}
                      aria-pressed={interactiveMode}
                    >
                      ON
                    </button>
                    <button
                      type="button"
                      onClick={() => interactiveMode && setInteractiveMode.mutate(false)}
                      className={`px-3 h-8 text-[11px] font-medium tracking-wide rounded-full transform transition-all duration-150 ml-0.5 ${
                        !interactiveMode
                          ? 'bg-[#18181b] text-slate-100 scale-100'
                          : 'bg-transparent text-slate-400 hover:bg-[#161616] hover:text-slate-100 scale-95'
                      }`}
                      aria-pressed={!interactiveMode}
                    >
                      OFF
                    </button>
                  </div>
                  <div
                    className="invisible group-hover/interactive-mode:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                    style={{ zIndex: 99999 }}
                  >
                    <div className="font-semibold mb-1 text-slate-200">Interactive mode</div>
                    <p>
                      {interactiveMode
                        ? 'Interactive mode is ON. Requests are logged, decoded and shown in the UI.'
                        : 'Interactive mode is OFF. The proxy forwards traffic without logging it to the UI.'}
                    </p>
                  </div>
                </div>

                {/* Export Logs Button */}
                <div className="relative group/export-logs">
                  <button
                    onClick={() => exportLogsFunc && exportLogsFunc()}
                    disabled={!exportLogsFunc || filteredLogsCount === 0}
                    className="p-2 bg-indigo-600/20 hover:bg-indigo-600/30 disabled:bg-slate-700/20 disabled:text-slate-600 text-indigo-300 border border-indigo-500/60 disabled:border-slate-600/30 rounded-lg transition-colors disabled:cursor-not-allowed"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <div
                    className="invisible group-hover/export-logs:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                    style={{ zIndex: 99999 }}
                  >
                    <div className="font-semibold mb-1 text-slate-200">Export logs</div>
                    <p>
                      {filteredLogsCount > 0
                        ? 'Export the current log view to a JSON file. If some requests are marked for export in the list, only those will be included; otherwise all filtered logs are exported.'
                        : 'There are no filtered logs to export yet.'}
                    </p>
                  </div>
                </div>

                {/* Clear Logs Button */}
                <div className="relative group/clear-logs">
                  <button
                    onClick={handleClearLogs}
                    disabled={clearingLogs}
                    className="p-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    {clearingLogs ? <Spinner size="sm" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                  <div
                    className="invisible group-hover/clear-logs:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                    style={{ zIndex: 99999 }}
                  >
                    <div className="font-semibold mb-1 text-slate-200">Clear logs</div>
                    <p>
                      This will permanently delete all captured request logs from the current
                      session.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Tabs */}
        <div className="px-6 mt-6" style={{ minWidth: '1024px' }}>
          <div className="flex items-center gap-1 bg-[#050508] border border-[#252525] rounded-xl p-1.5">
            <button
              onClick={() => setActiveTab('logs')}
              className={`flex-1 inline-flex items-center justify-center gap-2 px-4 h-9 rounded-lg text-xs font-medium tracking-wide transition-all duration-150 ${
                activeTab === 'logs'
                  ? 'bg-[#18181b] border border-slate-500/70 text-slate-100 shadow-[0_0_0_1px_rgba(148,163,184,0.4)]'
                  : 'border border-transparent text-slate-400 hover:text-slate-200 hover:bg-[#101010]'
              }`}
            >
              <FileText className="w-4 h-4" />
              <span>Requests {filteredLogsCount > 0 && `(${filteredLogsCount})`}</span>
            </button>

            <button
              onClick={() => setActiveTab('blocked')}
              className={`flex-1 inline-flex items-center justify-center gap-2 px-4 h-9 rounded-lg text-xs font-medium tracking-wide transition-all duration-150 ${
                activeTab === 'blocked'
                  ? 'bg-orange-600/15 border border-orange-500/70 text-orange-100 shadow-[0_0_0_1px_rgba(249,115,22,0.4)]'
                  : 'border border-transparent text-slate-400 hover:text-slate-200 hover:bg-[#101010]'
              }`}
            >
              <ShieldAlert className="w-4 h-4" />
              <span>Blocked ({header.blockedCount})</span>
            </button>

            <button
              onClick={() => setActiveTab('filters')}
              className={`flex-1 inline-flex items-center justify-center gap-2 px-4 h-9 rounded-lg text-xs font-medium tracking-wide transition-all duration-150 ${
                activeTab === 'filters'
                  ? filterMode === 'focus'
                    ? 'bg-purple-600/15 border border-purple-500/70 text-purple-100 shadow-[0_0_0_1px_rgba(168,85,247,0.4)]'
                    : 'bg-blue-600/15 border border-blue-500/70 text-blue-100 shadow-[0_0_0_1px_rgba(37,99,235,0.4)]'
                  : 'border border-transparent text-slate-400 hover:text-slate-200 hover:bg-[#101010]'
              }`}
            >
              {filterMode === 'focus' ? (
                <CircuitBoard className="w-4 h-4" />
              ) : (
                <CornerDownRight className="w-4 h-4" />
              )}
              <span>
                {filterMode === 'focus' ? 'Processed' : 'Redirected'} ({header.filterRuleCount})
              </span>
            </button>

            <button
              onClick={() => setActiveTab('edit')}
              className={`flex-1 inline-flex items-center justify-center gap-2 px-4 h-9 rounded-lg text-xs font-medium tracking-wide transition-all duration-150 ${
                activeTab === 'edit'
                  ? 'bg-cyan-600/15 border border-cyan-500/70 text-cyan-100 shadow-[0_0_0_1px_rgba(34,211,238,0.4)]'
                  : 'border border-transparent text-slate-400 hover:text-slate-200 hover:bg-[#101010]'
              }`}
            >
              <Edit3 className="w-4 h-4" />
              <span>Edited ({editRuleCount})</span>
            </button>

            <button
              onClick={() => setActiveTab('resources')}
              className={`flex-1 inline-flex items-center justify-center gap-2 px-4 h-9 rounded-lg text-xs font-medium tracking-wide transition-all duration-150 ${
                activeTab === 'resources'
                  ? 'bg-emerald-600/15 border border-emerald-500/70 text-emerald-100 shadow-[0_0_0_1px_rgba(16,185,129,0.4)]'
                  : 'border border-transparent text-slate-400 hover:text-slate-200 hover:bg-[#101010]'
              }`}
            >
              <HardDrive className="w-4 h-4" />
              <span>Local ({header.resourceCount})</span>
            </button>
          </div>

          {/* Tab Content */}
          <div className="mt-6 pb-8">
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
