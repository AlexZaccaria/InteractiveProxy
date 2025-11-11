import React, { useState, useEffect, useCallback } from 'react';
import { 
  Activity, 
  FileText, 
  Upload, 
  Globe,
  HardDrive,
  AlertCircle,
  Ban,
  Trash2,
  Download
} from 'lucide-react';
import RequestLogs from './components/RequestLogs';
import LocalResources from './components/LocalResources';
import BlockedResources from './components/BlockedResources';
import AddResource from './components/AddResource';
import Modal from './components/Modal';
import { useModal } from './hooks/useModal';
import axios from 'axios';

function App() {
  const { modalState, closeModal, showConfirm } = useModal();
  const [activeTab, setActiveTab] = useState('logs');
  const [logs, setLogs] = useState([]);
  const [resources, setResources] = useState([]);
  const [blockedCount, setBlockedCount] = useState(0);
  const [filteredLogsCount, setFilteredLogsCount] = useState(0);
  const [exportLogsFunc, setExportLogsFunc] = useState(null);
  const [interactiveMode, setInteractiveMode] = useState(true);
  const [stats, setStats] = useState({
    total: 0,
    local: 0,
    proxied: 0,
    blocked: 0,
    errors: 0
  });

  const fetchLogs = useCallback(async () => {
    if (!interactiveMode) return; // Skip if interactive mode is off
    try {
      const response = await axios.get('/api/logs');
      setLogs(response.data);
      
      // Calculate stats
      const total = response.data.length;
      const local = response.data.filter(log => log.source === 'local').length;
      const proxied = response.data.filter(log => 
        log.source === 'proxied' || 
        log.source === 'tunnel' || 
        log.source === 'mitm' || 
        log.source === 'websocket' ||
        log.source === 'direct'  // Include direct (old logs)
      ).length;
      const blocked = response.data.filter(log => log.source === 'blocked').length;
      const errors = response.data.filter(log => log.source === 'error').length;
      
      setStats({ total, local, proxied, blocked, errors });
    } catch (error) {
      console.error('Error fetching logs:', error);
    }
  }, [interactiveMode]);

  const fetchResources = useCallback(async () => {
    if (!interactiveMode) return; // Skip if interactive mode is off
    try {
      const response = await axios.get('/api/resources');
      setResources(response.data);
    } catch (error) {
      console.error('Error fetching resources:', error);
    }
  }, [interactiveMode]);

  const fetchBlockedCount = useCallback(async () => {
    try {
      const response = await axios.get('/api/blocked');
      setBlockedCount(response.data.length);
    } catch (error) {
      console.error('Error fetching blocked count:', error);
    }
  }, []);

  const deleteResource = useCallback(async (url) => {
    if (window.confirm(`Are you sure you want to delete the resource for ${url}?`)) {
      try {
        await axios.delete(`/api/resources/${encodeURIComponent(url)}`);
        await fetchResources();
      } catch (error) {
        console.error('Error deleting resource:', error);
        alert('Error deleting resource');
      }
    }
  }, [fetchResources]);

  // Fetch config on mount
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await axios.get('/api/config');
        setInteractiveMode(response.data.interactiveModeEnabled);
      } catch (error) {
        console.error('Error fetching config:', error);
      }
    };
    fetchConfig();
  }, []);

  useEffect(() => {
    if (interactiveMode) {
      fetchLogs();
      fetchResources();
      fetchBlockedCount();
    }
    
    const interval = setInterval(() => {
      if (interactiveMode) {
        fetchLogs();
        fetchResources();
        fetchBlockedCount();
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [interactiveMode, fetchLogs, fetchResources, fetchBlockedCount]);

  // Update interactive mode on server
  const handleInteractiveModeChange = useCallback(async (enabled) => {
    try {
      await axios.post('/api/interactive-mode', { enabled });
      setInteractiveMode(enabled);
    } catch (error) {
      console.error('Failed to set interactive mode:', error);
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
      
      <div className="min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <header className="bg-[#1a1a1a] border-b border-[#2a2a2a] sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4">
          <div className="grid grid-cols-3 items-center gap-4">
            {/* Logo and Title */}
            <div className="flex items-center space-x-3">
              <div className="bg-blue-500/20 p-2 rounded-lg">
                <Activity className="w-6 h-6 text-blue-400" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Proxy Server</h1>
                <p className="text-sm text-slate-400">Request Monitoring</p>
              </div>
            </div>

            {/* Inline Stats - Centered */}
            <div className="flex items-center justify-center gap-6">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-blue-400" />
                <div>
                  <p className="text-xs text-slate-400">Total</p>
                  <p className="text-lg font-bold text-white">{stats.total}</p>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <Ban className="w-5 h-5 text-orange-400" />
                <div>
                  <p className="text-xs text-slate-400">Blocked</p>
                  <p className="text-lg font-bold text-orange-400">{stats.blocked}</p>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <HardDrive className="w-5 h-5 text-green-400" />
                <div>
                  <p className="text-xs text-slate-400">Local</p>
                  <p className="text-lg font-bold text-green-400">{stats.local}</p>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-purple-400" />
                <div>
                  <p className="text-xs text-slate-400">Proxied</p>
                  <p className="text-lg font-bold text-purple-400">{stats.proxied}</p>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-red-400" />
                <div>
                  <p className="text-xs text-slate-400">Errors</p>
                  <p className="text-lg font-bold text-red-400">{stats.errors}</p>
                </div>
              </div>
            </div>
            
            {/* Action Buttons - Right aligned */}
            <div className="flex items-center justify-end gap-2">
              {/* Interactive Mode Toggle - Compact */}
              <button
                onClick={() => handleInteractiveModeChange(!interactiveMode)}
                className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors border ${
                  interactiveMode 
                    ? 'bg-green-600/20 border-green-600/30 text-green-400' 
                    : 'bg-slate-600/20 border-slate-600/30 text-slate-400'
                }`}
                title={interactiveMode ? 'Interactive mode ON - logging enabled' : 'Interactive mode OFF - proxy only'}
              >
                <Activity className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">{interactiveMode ? 'ON' : 'OFF'}</span>
              </button>
              
              {/* Export Logs Button */}
              <button
                onClick={() => exportLogsFunc && exportLogsFunc()}
                disabled={!exportLogsFunc || filteredLogsCount === 0}
                className="p-2 bg-blue-600/20 hover:bg-blue-600/30 disabled:bg-slate-700/20 disabled:text-slate-600 text-blue-400 border border-blue-600/30 disabled:border-slate-600/30 rounded-lg transition-colors disabled:cursor-not-allowed"
                title={`Export ${filteredLogsCount} filtered logs`}
              >
                <Download className="w-4 h-4" />
              </button>
              
              {/* Clear Logs Button */}
              <button
                onClick={async () => {
                  const confirmed = await showConfirm(
                    'Clear All Logs',
                    'Are you sure you want to clear all logs? This action cannot be undone.'
                  );
                  if (confirmed) {
                    await axios.delete('http://localhost:8080/api/logs');
                    setLogs([]);
                  }
                }}
                className="p-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors"
                title="Clear logs"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="container mx-auto px-6 mt-6">
        <div className="flex space-x-1 bg-[#1a1a1a] rounded-lg p-1">
          <button
            onClick={() => setActiveTab('logs')}
            className={`flex-1 px-6 py-3 font-medium rounded-md transition-all ${
              activeTab === 'logs'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-300 hover:bg-[#2a2a2a]'
            }`}
          >
            <div className="flex items-center justify-center space-x-2">
              <FileText className="w-4 h-4" />
              <span>Request Logs {filteredLogsCount > 0 && `(${filteredLogsCount})`}</span>
            </div>
          </button>
          
          <button
            onClick={() => setActiveTab('resources')}
            className={`flex-1 px-6 py-3 font-medium rounded-md transition-all ${
              activeTab === 'resources'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-300 hover:bg-[#2a2a2a]'
            }`}
          >
            <div className="flex items-center justify-center space-x-2">
              <HardDrive className="w-4 h-4" />
              <span>Local Resources ({resources.length})</span>
            </div>
          </button>
          
          <button
            onClick={() => setActiveTab('blocked')}
            className={`flex-1 px-6 py-3 font-medium rounded-md transition-all ${
              activeTab === 'blocked'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-300 hover:bg-[#2a2a2a]'
            }`}
          >
            <div className="flex items-center justify-center space-x-2">
              <Ban className="w-4 h-4" />
              <span>Blocked Resources ({blockedCount})</span>
            </div>
          </button>
          
          <button
            onClick={() => setActiveTab('add')}
            className={`flex-1 px-6 py-3 font-medium rounded-md transition-all ${
              activeTab === 'add'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'text-slate-400 hover:text-slate-300 hover:bg-[#2a2a2a]'
            }`}
          >
            <div className="flex items-center justify-center space-x-2">
              <Upload className="w-4 h-4" />
              <span>Add Resource</span>
            </div>
          </button>
        </div>

        {/* Tab Content */}
        <div className="mt-6 pb-8">
          {activeTab === 'logs' && (
            <RequestLogs 
              logs={logs} 
              onFilteredCountChange={setFilteredLogsCount}
              onExportLogs={setExportLogsFunc}
            />
          )}
          
          {activeTab === 'resources' && (
            <LocalResources 
              resources={resources} 
              onDelete={deleteResource}
              onRefresh={fetchResources}
            />
          )}
          
          {activeTab === 'blocked' && (
            <BlockedResources />
          )}
          
          {activeTab === 'add' && (
            <AddResource onSuccess={() => {
              fetchResources();
              setActiveTab('resources');
            }} />
          )}
        </div>
      </div>
    </div>
    </>
  );
}

export default App;
