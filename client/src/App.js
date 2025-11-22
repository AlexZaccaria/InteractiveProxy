import React, { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import RequestLogs from './components/RequestLogs';
import LocalResources from './components/LocalResources';
import BlockedResources from './components/BlockedResources';
import FilterRules from './components/FilterRules';
import EditRules from './components/EditRules';
import Modal from './components/Modal';
import { useModal } from './hooks/useModal';
import axios from 'axios';
import AuditPanel from './components/AuditPanel';

function App() {
  const { modalState, closeModal, showConfirm, showAlert } = useModal();
  const [activeTab, setActiveTab] = useState('logs');
  const [resources, setResources] = useState([]);
  const [blockedCount, setBlockedCount] = useState(0);
  const [filterRuleCount, setFilterRuleCount] = useState(0);
  const [filteredRequests, setFilteredRequests] = useState(0);
  const [editRuleCount, setEditRuleCount] = useState(0);
  const [editedRequests, setEditedRequests] = useState(0);
  const [filteredLogsCount, setFilteredLogsCount] = useState(0);
  const [exportLogsFunc, setExportLogsFunc] = useState(null);
  const [interactiveMode, setInteractiveMode] = useState(true);
  const [editRulesEnabled, setEditRulesEnabled] = useState(true);
  const [localResourcesEnabled, setLocalResourcesEnabled] = useState(true);
  const [filterRulesEnabled, setFilterRulesEnabled] = useState(true);
  const [blockedRulesEnabled, setBlockedRulesEnabled] = useState(true);
  const [filterMode, setFilterMode] = useState('ignore');
  const [logsRefreshToken, setLogsRefreshToken] = useState(0);
  const [jsonPathRuleSeed, setJsonPathRuleSeed] = useState(null);
  const [stats, setStats] = useState({
    total: 0,
    served: 0,
    proxied: 0,
    blocked: 0,
    redirected: 0,
    errors: 0
  });
  const [dashboardPerformance, setDashboardPerformance] = useState(null);
  const [dashboardPayloads, setDashboardPayloads] = useState(null);
  const [dashboardRoutes, setDashboardRoutes] = useState(null);
  const [showAuditPanel, setShowAuditPanel] = useState(false);

  const fetchDashboard = useCallback(async () => {
    if (!interactiveMode) return;
    try {
      const response = await axios.get('/api/dashboard');
      const {
        stats: serverStats = {},
        resources: resourceEntries = [],
        blocked: blockedList = [],
        filterMetrics = {},
        editedRequests: editedValue = 0,
        performance: performanceData = null,
        payloads: payloadData = null,
        routes: routesData = null
      } = response.data || {};

      const totalLogged = serverStats.total ?? 0;
      const totalBypassed = filterMetrics.totalFiltered ?? 0;

      setResources(resourceEntries);
      setBlockedCount(blockedList.length);

      // Processed: requests that go through the proxy internals and are
      // neither blocked nor redirected. Computed on the backend.
      const processedValue = serverStats.processed ?? Math.max(0, totalLogged - (serverStats.blocked ?? 0));
      setFilteredRequests(processedValue);

      setFilterRuleCount(filterMetrics.activeRules ?? 0);
      setEditedRequests(editedValue);
      setStats({
        // Overall logged traffic (HTTP/HTTPS/WebSocket). Bypassed/redirected
        // flows are logged as 'direct'/'tunnel' and already included in
        // totalLogged, so we do not add totalBypassed again to avoid
        // double-counting.
        total: totalLogged,
        served: serverStats.served ?? 0,
        proxied: serverStats.proxied ?? 0,
        blocked: serverStats.blocked ?? 0,
        redirected: totalBypassed,
        errors: serverStats.errors ?? 0
      });
      setDashboardPerformance(performanceData || null);
      setDashboardPayloads(payloadData || null);
      setDashboardRoutes(routesData || null);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    }
  }, [interactiveMode]);

  const deleteResource = useCallback(async (url) => {
    try {
      const confirmed = await showConfirm(
        'Delete local resource',
        `Are you sure you want to delete the resource for ${url}? This action cannot be undone.`
      );

      if (!confirmed) return;

      await axios.delete(`/api/resources/${encodeURIComponent(url)}`);
      await fetchDashboard();
    } catch (error) {
      console.error('Error deleting resource:', error);
    }
  }, [fetchDashboard, showConfirm]);

  const fetchEditRuleCount = useCallback(async () => {
    try {
      const response = await axios.get('/api/edit-rules');
      setEditRuleCount(response.data.rules?.length || 0);
    } catch (error) {
      console.error('Error fetching edit rules:', error);
    }
  }, []);

  // Fetch config on mount
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await axios.get('/api/config');
        setInteractiveMode(response.data.interactiveModeEnabled);
        if (typeof response.data.editRulesEnabled === 'boolean') {
          setEditRulesEnabled(response.data.editRulesEnabled);
        }
        if (typeof response.data.localResourcesEnabled === 'boolean') {
          setLocalResourcesEnabled(response.data.localResourcesEnabled);
        }
        if (typeof response.data.filterRulesEnabled === 'boolean') {
          setFilterRulesEnabled(response.data.filterRulesEnabled);
        }
        if (typeof response.data.blockedRulesEnabled === 'boolean') {
          setBlockedRulesEnabled(response.data.blockedRulesEnabled);
        }
        if (response.data.filterMode) {
          setFilterMode(response.data.filterMode === 'focus' ? 'focus' : 'ignore');
        }
        if (typeof response.data.filteredRequestCount === 'number') {
          setFilteredRequests(response.data.filteredRequestCount);
        }
      } catch (error) {
        console.error('Error fetching config:', error);
      }
    };
    fetchConfig();
  }, []);

  useEffect(() => {
    if (interactiveMode) {
      fetchDashboard();
    }
    fetchEditRuleCount();

    const interval = setInterval(() => {
      if (interactiveMode) {
        fetchDashboard();
      }
      fetchEditRuleCount();
    }, 2000);
    return () => clearInterval(interval);
  }, [interactiveMode, fetchDashboard, fetchEditRuleCount]);

  // Update interactive mode on server
  const handleInteractiveModeChange = useCallback(async (enabled) => {
    try {
      await axios.post('/api/interactive-mode', { enabled });
      setInteractiveMode(enabled);
    } catch (error) {
      console.error('Failed to set interactive mode:', error);
    }
  }, []);

  // Update live edit rules mode on server
  const handleEditRulesModeChange = useCallback(async (enabled) => {
    try {
      await axios.post('/api/edit-rules-mode', { enabled });
      setEditRulesEnabled(enabled);
    } catch (error) {
      console.error('Failed to set edit rules mode:', error);
    }
  }, []);

  // Update local resources mode on server
  const handleLocalResourcesModeChange = useCallback(async (enabled) => {
    try {
      await axios.post('/api/local-resources-mode', { enabled });
      setLocalResourcesEnabled(enabled);
    } catch (error) {
      console.error('Failed to set local resources mode:', error);
    }
  }, []);

  // Update global filter rules mode (bypass engine) on server
  const handleFilterRulesModeChange = useCallback(async (enabled) => {
    try {
      await axios.post('/api/filter-rules-mode', { enabled });
      setFilterRulesEnabled(enabled);
    } catch (error) {
      console.error('Failed to set filter rules mode:', error);
    }
  }, []);

  // Update blocked rules mode on server
  const handleBlockedRulesModeChange = useCallback(async (enabled) => {
    try {
      await axios.post('/api/blocked-rules-mode', { enabled });
      setBlockedRulesEnabled(enabled);
    } catch (error) {
      console.error('Failed to set blocked rules mode:', error);
    }
  }, []);

  const handleFilterModeChange = useCallback(async (mode) => {
    try {
      const normalized = mode === 'focus' ? 'focus' : 'ignore';
      const response = await axios.post('/api/filter-mode', { mode: normalized });
      const nextMode = response.data?.filterMode === 'focus' ? 'focus' : 'ignore';
      setFilterMode(nextMode);
    } catch (error) {
      console.error('Failed to set filter mode:', error);
    }
  }, []);

  const handleCreateJsonPathRuleFromLogs = useCallback((seed) => {
    if (!seed) return;
    setJsonPathRuleSeed(seed);
    setActiveTab('edit');
  }, []);

  const handleProxyIconClick = useCallback((event) => {
    // Secret gesture: triple-click on the proxy icon/title block.
    // React's synthetic event.detail increments with the click count
    // (1, 2, 3, ...). When it reaches 3, toggle the audit panel.
    if (event?.detail >= 3) {
      setShowAuditPanel(prevVisible => !prevVisible);
    }
  }, []);

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
        <AuditPanel
          onClose={() => setShowAuditPanel(false)}
          performance={dashboardPerformance}
          payloads={dashboardPayloads}
          routes={dashboardRoutes}
        />
      )}
      
      <div className="min-h-screen bg-[#0a0a0a]" style={{ minWidth: '1024px' }}>
      {/* Header */}
      <header className="bg-[#1a1a1a] border-b border-[#2a2a2a] sticky top-0 z-50">
        <div className="px-6 py-4" style={{ minWidth: '1024px' }}>
          <div className="grid grid-cols-3 items-center gap-4">
            {/* Logo and Title */}
            <div className="flex items-center space-x-2 cursor-default" onClick={handleProxyIconClick}>
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
                    <p className="text-lg font-bold text-white">{stats.total}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-5 h-5 text-orange-400" />
                  <div>
                    <p className="text-xs text-slate-400">Blocked</p>
                    <p className="text-lg font-bold text-orange-400">{stats.blocked}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <CornerDownRight className="w-5 h-5 text-blue-400" />
                  <div>
                    <p className="text-xs text-slate-400">Redirected</p>
                    <p className="text-lg font-bold text-blue-400">{stats.redirected}</p>
                  </div>
                </div>
              </div>

              {/* Processed / Edited / Served */}
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <CircuitBoard className="w-5 h-5 text-purple-400" />
                  <div>
                    <p className="text-xs text-slate-400">Processed</p>
                    <p className="text-lg font-bold text-purple-400">{filteredRequests}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Edit3 className="w-5 h-5 text-cyan-400" />
                  <div>
                    <p className="text-xs text-slate-400">Edited</p>
                    <p className="text-lg font-bold text-cyan-400">{editedRequests}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <HardDrive className="w-5 h-5 text-green-400" />
                  <div>
                    <p className="text-xs text-slate-400">Served</p>
                    <p className="text-lg font-bold text-green-400">{stats.served}</p>
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
                    onClick={() => !interactiveMode && handleInteractiveModeChange(true)}
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
                    onClick={() => interactiveMode && handleInteractiveModeChange(false)}
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
                  className="p-2 bg-blue-600/20 hover:bg-blue-600/30 disabled:bg-slate-700/20 disabled:text-slate-600 text-blue-400 border border-blue-600/30 disabled:border-slate-600/30 rounded-lg transition-colors disabled:cursor-not-allowed"
                >
                  <Download className="w-4 h-4" />
                </button>
                <div
                  className="invisible group-hover/export-logs:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                  style={{ zIndex: 99999 }}
                >
                  <div className="font-semibold mb-1 text-slate-200">Export filtered logs</div>
                  <p>
                    {filteredLogsCount > 0
                      ? `Export ${filteredLogsCount} filtered logs to a JSON file.`
                      : 'There are no filtered logs to export yet.'}
                  </p>
                </div>
              </div>
              
              {/* Clear Logs Button */}
              <div className="relative group/clear-logs">
                <button
                  onClick={async () => {
                    const confirmed = await showConfirm(
                      'Clear All Logs',
                      'Are you sure you want to clear all logs? This action cannot be undone.'
                    );
                    if (confirmed) {
                      await axios.delete('http://localhost:8080/api/logs');
                      setLogsRefreshToken(token => token + 1);
                    }
                  }}
                  className="p-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <div
                  className="invisible group-hover/clear-logs:visible absolute right-0 top-full mt-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                  style={{ zIndex: 99999 }}
                >
                  <div className="font-semibold mb-1 text-slate-200">Clear logs</div>
                  <p>
                    This will permanently delete all captured request logs from the current session.
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
            <span>Blocked ({blockedCount})</span>
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
            <span>{filterMode === 'focus' ? 'Processed' : 'Redirected'} ({filterRuleCount})</span>
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
            <span>Local ({resources.length})</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="mt-6 pb-8">
          {activeTab === 'logs' && (
            <RequestLogs
              onFilteredCountChange={setFilteredLogsCount}
              onExportLogs={setExportLogsFunc}
              refreshToken={logsRefreshToken}
              onCreateJsonPathRule={handleCreateJsonPathRuleFromLogs}
            />
          )}
          {activeTab === 'resources' && (
            <LocalResources 
              resources={resources} 
              onDelete={deleteResource}
              onRefresh={fetchDashboard}
              enabled={localResourcesEnabled}
              onModeChange={handleLocalResourcesModeChange}
            />
          )}
          
          {activeTab === 'blocked' && (
            <BlockedResources 
              enabled={blockedRulesEnabled}
              onModeChange={handleBlockedRulesModeChange}
              showConfirm={showConfirm}
            />
          )}

          {activeTab === 'filters' && (
            <FilterRules
              onRulesChanged={fetchDashboard}
              filterMode={filterMode}
              onFilterModeChange={handleFilterModeChange}
              filterRulesEnabled={filterRulesEnabled}
              onFilterRulesModeChange={handleFilterRulesModeChange}
              showConfirm={showConfirm}
            />
          )}

          {activeTab === 'edit' && (
            <EditRules
              onRulesChanged={fetchEditRuleCount}
              editRulesEnabled={editRulesEnabled}
              onEditRulesModeChange={handleEditRulesModeChange}
              showConfirm={showConfirm}
              showAlert={showAlert}
              initialJsonPathSeed={jsonPathRuleSeed}
              onConsumeJsonPathSeed={() => setJsonPathRuleSeed(null)}
            />
          )}
        </div>
      </div>
    </div>
    </>
  );
}

export default App;
