import React, { useState, useMemo, useEffect, useCallback } from 'react';
import ReactJson from '@microlink/react-json-view';
import Modal from './Modal';
import { useModal } from '../hooks/useModal';
import { 
  Search, 
  Filter,
  ChevronDown,
  ChevronUp,
  Globe,
  HardDrive,
  AlertCircle,
  Clock,
  Link as LinkIcon,
  FileText,
  FileJson,
  FileCode,
  Image,
  Film,
  Music,
  FileArchive,
  File,
  Replace,
  Ban,
  HelpCircle
} from 'lucide-react';

function RequestLogs({ logs, onFilteredCountChange, onExportLogs }) {
  const { modalState, closeModal, showPrompt } = useModal();
  const [searchTerm, setSearchTerm] = useState(() => localStorage.getItem('proxyFilters_searchTerm') || '');
  const [requestBodySearch, setRequestBodySearch] = useState('');
  const [responseSearchTerm, setResponseSearchTerm] = useState('');
  
  // Load filters from localStorage or use defaults (only transport protocols)
  const [selectedSources, setSelectedSources] = useState(() => {
    const saved = localStorage.getItem('proxyFilters_sources');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Migrate old filters: replace 'tunnel' and 'direct' with 'websocket', keep only protocols
      const protocols = ['proxied', 'mitm', 'websocket'];
      const filtered = parsed.filter(s => protocols.includes(s));
      // Ensure websocket is included if tunnel or direct were present
      if ((parsed.includes('tunnel') || parsed.includes('direct')) && !filtered.includes('websocket')) {
        filtered.push('websocket');
      }
      // If empty after migration, use defaults
      return filtered.length > 0 ? filtered : ['proxied', 'mitm', 'websocket'];
    }
    return ['proxied', 'mitm', 'websocket'];
  });
  
  const [selectedMethods, setSelectedMethods] = useState(() => {
    const saved = localStorage.getItem('proxyFilters_methods');
    return saved ? JSON.parse(saved) : ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']; // OPTIONS, HEAD, and CONNECT disabled by default
  });
  
  const [selectedFileTypes, setSelectedFileTypes] = useState(() => {
    const saved = localStorage.getItem('proxyFilters_fileTypes');
    return saved ? JSON.parse(saved) : ['json', 'html', 'css', 'js', 'image', 'video', 'audio', 'font', 'other'];
  });
  
  const [expandedLog, setExpandedLog] = useState(null);
  const [showSourcesDropdown, setShowSourcesDropdown] = useState(false);
  const [showMethodsDropdown, setShowMethodsDropdown] = useState(false);
  const [showFileTypesDropdown, setShowFileTypesDropdown] = useState(false);
  const [blockedUrls, setBlockedUrls] = useState([]);
  const [showWsConnections, setShowWsConnections] = useState(() => {
    const saved = localStorage.getItem('proxyFilters_showWsConnections');
    return saved ? JSON.parse(saved) : false; // Default: hide connections
  });

  const toggleMethod = (method) => {
    setSelectedMethods(prev => 
      prev.includes(method) 
        ? prev.filter(m => m !== method)
        : [...prev, method]
    );
  };

  const toggleSource = (source) => {
    setSelectedSources(prev => 
      prev.includes(source) 
        ? prev.filter(s => s !== source)
        : [...prev, source]
    );
  };

  const toggleFileType = (fileType) => {
    setSelectedFileTypes(prev => 
      prev.includes(fileType) 
        ? prev.filter(f => f !== fileType)
        : [...prev, fileType]
    );
  };

  const getFileTypeFromLog = (log) => {
    const contentType = log.responseHeaders?.['content-type'] || '';
    const url = (log.fullUrl || log.url).toLowerCase();
    
    if (contentType.includes('json')) return 'json';
    if (contentType.includes('html')) return 'html';
    if (contentType.includes('css')) return 'css';
    if (contentType.includes('javascript')) return 'js';
    if (contentType.includes('image/')) return 'image';
    if (contentType.includes('video/')) return 'video';
    if (contentType.includes('audio/')) return 'audio';
    
    // Check font by content-type or extension
    const fontExtensions = ['.woff', '.woff2', '.ttf', '.otf', '.eot'];
    if (contentType.includes('font/') || fontExtensions.some(ext => url.endsWith(ext))) return 'font';
    
    return 'other';
  };

  // Save filters to localStorage when they change
  useEffect(() => {
    localStorage.setItem('proxyFilters_sources', JSON.stringify(selectedSources));
  }, [selectedSources]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_searchTerm', searchTerm);
  }, [searchTerm]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_methods', JSON.stringify(selectedMethods));
  }, [selectedMethods]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_fileTypes', JSON.stringify(selectedFileTypes));
  }, [selectedFileTypes]);

  useEffect(() => {
    localStorage.setItem('proxyFilters_showWsConnections', JSON.stringify(showWsConnections));
  }, [showWsConnections]);

  // Close dropdowns when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('.dropdown-container')) {
        setShowSourcesDropdown(false);
        setShowMethodsDropdown(false);
        setShowFileTypesDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load blocked URLs on mount
  useEffect(() => {
    fetch('http://localhost:8080/api/blocked')
      .then(res => res.json())
      .then(data => setBlockedUrls(data))
      .catch(err => console.error('Error loading blocked URLs:', err));
  }, []);

  const toggleBlockUrl = async (url) => {
    // Check if any blocked URL contains this URL (partial match)
    const matchingBlockedUrl = blockedUrls.find(blockedUrl => 
      url.includes(blockedUrl) || blockedUrl.includes(url)
    );
    
    if (matchingBlockedUrl) {
      // URL is already blocked (or contains a blocked pattern) - unblock it
      const action = 'remove';
      try {
        const response = await fetch('http://localhost:8080/api/blocked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: matchingBlockedUrl, action })
        });
        
        if (response.ok) {
          const data = await response.json();
          setBlockedUrls(data.blockedUrls);
        }
      } catch (error) {
        console.error('Error unblocking URL:', error);
      }
    } else {
      // URL is not blocked - show modal to edit and make it more generic
      const editedUrl = await showPrompt(
        'Block URL Pattern',
        'Edit the URL pattern to block (you can make it more generic):',
        url,
        'Enter URL pattern...',
        [
          'Block domain: facebook.com',
          'Block path: /api/tracking',
          'Block specific: https://example.com/ads/banner.js'
        ]
      );
      
      if (editedUrl && editedUrl.trim()) {
        const action = 'add';
        try {
          const response = await fetch('http://localhost:8080/api/blocked', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: editedUrl.trim(), action })
          });
          
          if (response.ok) {
            const data = await response.json();
            setBlockedUrls(data.blockedUrls);
          }
        } catch (error) {
          console.error('Error blocking URL:', error);
        }
      }
    }
  };

  const filteredLogs = useMemo(() => {
    // Debug: check if any logs have isConnectionLog flag
    const connectionLogs = logs.filter(log => log.isConnectionLog);
    if (connectionLogs.length > 0) {
      console.log('Found connection logs:', connectionLogs.length, 'showWsConnections:', showWsConnections);
    }
    
    const filtered = logs.filter(log => {
      // Check if URL is blocked and should be hidden
      // Check if blocked (always hide blocked URLs)
      const isBlocked = blockedUrls.some(blockedUrl => 
        (log.fullUrl || log.url).includes(blockedUrl)
      );
      if (isBlocked) return false;
      
      // Hide WebSocket connection logs if option is disabled
      if (!showWsConnections && log.isConnectionLog) {
        console.log('Hiding WS connection log:', log.url, 'showWsConnections:', showWsConnections);
        return false;
      }
      
      // Search in URL with support for ; delimiter and ! negation
      const matchesSearch = searchTerm === '' || (() => {
        const terms = searchTerm.split(';').map(t => t.trim()).filter(t => t);
        if (terms.length === 0) return true;
        
        const searchableText = [
          log.url,
          log.method,
          log.targetUrl || '',
          log.localResource || ''
        ].join(' ').toLowerCase();
        
        return terms.every(term => {
          if (term.startsWith('!')) {
            // Negation: must NOT contain
            const negatedTerm = term.substring(1).toLowerCase();
            return !searchableText.includes(negatedTerm);
          } else {
            // Normal: must contain
            return searchableText.includes(term.toLowerCase());
          }
        });
      })();
      
      // Search in request body AND request headers
      const matchesRequestBodySearch = requestBodySearch === '' || (
        (log.body && (typeof log.body === 'string' 
          ? log.body.toLowerCase().includes(requestBodySearch.toLowerCase())
          : JSON.stringify(log.body).toLowerCase().includes(requestBodySearch.toLowerCase())
        )) ||
        (log.headers && JSON.stringify(log.headers).toLowerCase().includes(requestBodySearch.toLowerCase()))
      );
      
      // Search in response body AND response headers
      const matchesResponseSearch = responseSearchTerm === '' || (
        (log.responseBody && log.responseBody.toLowerCase().includes(responseSearchTerm.toLowerCase())) ||
        (log.responseHeaders && JSON.stringify(log.responseHeaders).toLowerCase().includes(responseSearchTerm.toLowerCase()))
      );
      
      // Whitelist sources filter - always include local, blocked, error, tunnel, direct
      const alwaysIncludedSources = ['local', 'blocked', 'error', 'tunnel', 'direct'];
      const sourceSelected = alwaysIncludedSources.includes(log.source) || selectedSources.includes(log.source);
      
      // Whitelist methods filter - always include WS
      const methodSelected = log.method === 'WS' || selectedMethods.includes(log.method);
      
      // File type filter
      const fileType = getFileTypeFromLog(log);
      const fileTypeSelected = selectedFileTypes.includes(fileType);
      
      return matchesSearch && matchesRequestBodySearch && matchesResponseSearch && sourceSelected && methodSelected && fileTypeSelected;
    });
    
    // Reverse order: newest at bottom
    return filtered.reverse();
  }, [logs, searchTerm, requestBodySearch, responseSearchTerm, selectedSources, selectedMethods, selectedFileTypes, blockedUrls, showWsConnections]);

  const exportLogs = useCallback(() => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `proxy-logs-${timestamp}.json`;
    
    const dataStr = JSON.stringify(filteredLogs, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [filteredLogs]);

  // Notify parent of filtered count
  useEffect(() => {
    if (onFilteredCountChange) {
      onFilteredCountChange(filteredLogs.length);
    }
  }, [filteredLogs.length, onFilteredCountChange]);

  // Provide export function to parent
  useEffect(() => {
    if (onExportLogs) {
      onExportLogs(() => exportLogs);
    }
  }, [onExportLogs, filteredLogs, exportLogs]);

  const getSourceIcon = (source) => {
    switch (source) {
      case 'local':
        return <HardDrive className="w-4 h-4 text-green-400" />;
      case 'proxied':
        return <Globe className="w-4 h-4 text-purple-400" />;
      case 'websocket':
        return <Globe className="w-4 h-4 text-yellow-400" />;
      case 'tunnel':
        return <Globe className="w-4 h-4 text-blue-400" />;
      case 'blocked':
        return <Ban className="w-4 h-4 text-orange-400" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-400" />;
      default:
        return <LinkIcon className="w-4 h-4 text-slate-400" />;
    }
  };

  const getSourceBadge = (source) => {
    const badges = {
      local: 'bg-green-500/20 text-green-400 border-green-500/30',
      proxied: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
      mitm: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
      tunnel: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
      blocked: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
      error: 'bg-red-500/20 text-red-400 border-red-500/30',
      websocket: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    };
    return badges[source] || badges.websocket;
  };

  const getMethodBadge = (method) => {
    const badges = {
      GET: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
      POST: 'bg-green-500/20 text-green-400 border-green-500/30',
      PUT: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
      DELETE: 'bg-red-500/20 text-red-400 border-red-500/30',
      PATCH: 'bg-orange-500/20 text-orange-400 border-orange-500/30'
    };
    return badges[method] || 'bg-slate-500/20 text-slate-400 border-slate-500/30';
  };

  const getContentTypeInfo = (log) => {
    const contentType = log.responseHeaders?.['content-type'] || '';
    const requestContentType = log.headers?.['content-type'] || '';
    const responseBody = log.responseBody || '';
    const requestBody = typeof log.body === 'string' ? log.body : JSON.stringify(log.body || '');
    const url = (log.fullUrl || log.url).toLowerCase();
    
    // Fonts - check by extension or content-type
    const fontExtensions = ['.woff', '.woff2', '.ttf', '.otf', '.eot'];
    if (contentType.includes('font/') || fontExtensions.some(ext => url.endsWith(ext))) {
      const ext = fontExtensions.find(e => url.endsWith(e))?.toUpperCase().replace('.', '') || 'FONT';
      return { icon: FileText, label: ext, color: 'text-pink-400' };
    }
    
    // Images
    if (contentType.includes('image/')) {
      const format = contentType.split('/')[1]?.split(';')[0]?.toUpperCase() || 'IMG';
      return { icon: Image, label: format, color: 'text-purple-400' };
    }
    // Videos
    if (contentType.includes('video/')) {
      const format = contentType.split('/')[1]?.split(';')[0]?.toUpperCase() || 'VIDEO';
      return { icon: Film, label: format, color: 'text-pink-400' };
    }
    // Audio
    if (contentType.includes('audio/')) {
      const format = contentType.split('/')[1]?.split(';')[0]?.toUpperCase() || 'AUDIO';
      return { icon: Music, label: format, color: 'text-green-400' };
    }
    // JSON - check content-type, URL extension, OR try to parse
    if (contentType.includes('application/json') || requestContentType.includes('application/json') || url.endsWith('.json')) {
      return { icon: FileJson, label: 'JSON', color: 'text-yellow-400' };
    }
    
    // Try to parse response body as JSON
    if (!responseBody.includes('[Binary')) {
      try {
        JSON.parse(responseBody);
        return { icon: FileJson, label: 'JSON', color: 'text-yellow-400' };
      } catch {}
    }
    
    // Try to parse request body as JSON
    if (requestBody) {
      try {
        JSON.parse(requestBody);
        return { icon: FileJson, label: 'JSON', color: 'text-yellow-400' };
      } catch {}
    }
    // JavaScript
    if (contentType.includes('javascript') || contentType.includes('ecmascript')) {
      return { icon: FileCode, label: 'JS', color: 'text-amber-400' };
    }
    // CSS
    if (contentType.includes('css')) {
      return { icon: FileCode, label: 'CSS', color: 'text-blue-400' };
    }
    // HTML
    if (contentType.includes('html')) {
      return { icon: FileText, label: 'HTML', color: 'text-orange-400' };
    }
    // XML
    if (contentType.includes('xml')) {
      return { icon: FileText, label: 'XML', color: 'text-cyan-400' };
    }
    // Text
    if (contentType.includes('text/')) {
      return { icon: FileText, label: 'TXT', color: 'text-slate-400' };
    }
    // Archives
    if (contentType.includes('zip') || contentType.includes('compressed') || contentType.includes('archive')) {
      return { icon: FileArchive, label: 'ZIP', color: 'text-indigo-400' };
    }
    // PDF
    if (contentType.includes('pdf')) {
      return { icon: File, label: 'PDF', color: 'text-red-400' };
    }
    // Binary/Unknown
    if (contentType.includes('octet-stream') || contentType.includes('binary')) {
      return { icon: File, label: 'BIN', color: 'text-slate-500' };
    }
    
    // Default
    return { icon: File, label: 'FILE', color: 'text-slate-400' };
  };

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
      
      <div className="space-y-4">
      {/* Filters */}
      <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a] space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
          {/* Search URL/Request */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search URL..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-8 py-1.5 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="absolute right-2.5 top-1/2 transform -translate-y-1/2 group/help">
              <HelpCircle className="w-3.5 h-3.5 text-slate-500 cursor-help" />
              <div className="invisible group-hover/help:visible absolute right-0 bottom-full mb-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl" style={{zIndex: 99999}}>
                <div className="font-semibold mb-2">Search syntax:</div>
                <div className="space-y-1">
                  <div><code className="text-blue-400">;</code> - AND (all terms)</div>
                  <div><code className="text-red-400">!</code> - NOT (exclude term)</div>
                </div>
                <div className="mt-2 text-slate-400">
                  Es: <code className="text-green-400">!facebook; !scontent; api</code>
                </div>
              </div>
            </div>
          </div>

          {/* Search Request Body */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-yellow-400" />
            <input
              type="text"
              placeholder="Search in request..."
              value={requestBodySearch}
              onChange={(e) => setRequestBodySearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
            />
          </div>

          {/* Search Response Body */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-green-400" />
            <input
              type="text"
              placeholder="Search in response..."
              value={responseSearchTerm}
              onChange={(e) => setResponseSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-green-500"
            />
          </div>
        </div>

        {/* Filter Dropdowns - Whitelist */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {/* Sources Dropdown */}
          <div className="relative dropdown-container">
            <button
              onClick={() => setShowSourcesDropdown(!showSourcesDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-slate-400 hover:border-blue-500 hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-full"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>Sources ({selectedSources.length})</span>
              <ChevronDown className="w-3.5 h-3.5 ml-auto" />
            </button>
            
            {showSourcesDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl z-10 min-w-[160px]">
                {[
                  { key: 'proxied', label: 'HTTP' },
                  { key: 'mitm', label: 'HTTPS' },
                  { key: 'websocket', label: 'WebSocket' }
                ].map(source => (
                  <label
                    key={source.key}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] cursor-pointer text-sm text-slate-300 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSources.includes(source.key)}
                      onChange={() => toggleSource(source.key)}
                      className="w-4 h-4 rounded border-slate-500 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 bg-slate-600"
                    />
                    <span>{source.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Methods Dropdown */}
          <div className="relative dropdown-container">
            <button
              onClick={() => setShowMethodsDropdown(!showMethodsDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-slate-400 hover:border-blue-500 hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-full"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>Methods ({selectedMethods.length})</span>
              <ChevronDown className="w-3.5 h-3.5 ml-auto" />
            </button>
            
            {showMethodsDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl z-10 min-w-[180px]">
                {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'CONNECT', 'OPTIONS', 'HEAD'].map(method => (
                  <label
                    key={method}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] cursor-pointer text-sm text-slate-300 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedMethods.includes(method)}
                      onChange={() => toggleMethod(method)}
                      className="w-4 h-4 rounded border-slate-500 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 bg-slate-600"
                    />
                    <span>{method}</span>
                  </label>
                ))}
                <div className="border-t border-[#2a2a2a] my-1"></div>
                <label
                  className="flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] cursor-pointer text-sm text-slate-300 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={showWsConnections}
                    onChange={(e) => setShowWsConnections(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-500 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 bg-slate-600"
                  />
                  <span className="text-xs">WS Connection Status</span>
                </label>
              </div>
            )}
          </div>

          {/* File Types Dropdown */}
          <div className="relative dropdown-container">
            <button
              onClick={() => setShowFileTypesDropdown(!showFileTypesDropdown)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-slate-400 hover:border-blue-500 hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-full"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>Types ({selectedFileTypes.length})</span>
              <ChevronDown className="w-3.5 h-3.5 ml-auto" />
            </button>
            
            {showFileTypesDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl z-10 min-w-[140px]">
                {[
                  { key: 'json', label: 'JSON' },
                  { key: 'html', label: 'HTML' },
                  { key: 'css', label: 'CSS' },
                  { key: 'js', label: 'JavaScript' },
                  { key: 'image', label: 'Immagini' },
                  { key: 'video', label: 'Video' },
                  { key: 'audio', label: 'Audio' },
                  { key: 'font', label: 'Font' },
                  { key: 'other', label: 'Altro' }
                ].map(type => (
                  <label
                    key={type.key}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] cursor-pointer text-sm text-slate-300 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFileTypes.includes(type.key)}
                      onChange={() => toggleFileType(type.key)}
                      className="w-4 h-4 rounded border-slate-500 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 bg-slate-600"
                    />
                    <span>{type.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Logs List */}
      <div className="space-y-2">
        {filteredLogs.length === 0 ? (
          <div className="bg-[#1a1a1a] rounded-lg p-8 border border-[#2a2a2a] text-center">
            <AlertCircle className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400">Nessuna richiesta trovata</p>
          </div>
        ) : (
          filteredLogs.map((log) => (
            <div
              key={log.id}
              className="bg-[#1a1a1a] rounded-lg border border-[#2a2a2a] overflow-hidden hover:border-blue-500/50 transition-colors"
            >
              <div
                className="p-4 cursor-pointer"
                onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2 mb-2 flex-wrap">
                      {getSourceIcon(log.source)}
                      <span className={`px-2 py-1 rounded text-xs font-medium border ${getMethodBadge(log.method)}`}>
                        {log.method}
                      </span>
                      {log.direction && (() => {
                        // Extract domain from URL for WebSocket direction
                        let directionText = log.direction;
                        if (log.direction.includes('→')) {
                          try {
                            const url = new URL(log.fullUrl || log.url);
                            const domain = url.hostname;
                            directionText = log.direction.replace('server', domain).replace('client', 'client');
                          } catch {}
                        }
                        return (
                          <span className="px-2 py-1 rounded text-xs font-medium bg-slate-700/50 text-slate-300 border border-slate-600">
                            {directionText}
                          </span>
                        );
                      })()}
                      {/* Hide WEBSOCKET badge if method is WS */}
                      {log.method !== 'WS' && (
                        <span className={`px-2 py-1 rounded text-xs font-medium border ${getSourceBadge(log.source)}`}>
                          {log.source.toUpperCase()}
                        </span>
                      )}
                      {log.statusCode && (
                        <span className={`px-2 py-1 rounded text-xs font-medium border ${
                          log.statusCode >= 200 && log.statusCode < 300
                            ? 'bg-green-500/20 text-green-400 border-green-500/30'
                            : 'bg-red-500/20 text-red-400 border-red-500/30'
                        }`}>
                          {log.statusCode}
                        </span>
                      )}
                      {log.responseHeaders && (() => {
                        const contentInfo = getContentTypeInfo(log);
                        const ContentIcon = contentInfo.icon;
                        return (
                          <span className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border bg-slate-700/50 border-slate-600 ${contentInfo.color}`}>
                            <ContentIcon className="w-3 h-3" />
                            {contentInfo.label}
                          </span>
                        );
                      })()}
                    </div>
                    
                    <p className="text-white font-mono text-sm truncate mb-1">
                      {log.fullUrl || log.url}
                    </p>
                    
                    {log.localResource && (
                      <p className="text-green-400 text-xs flex items-center gap-1">
                        <HardDrive className="w-3 h-3" />
                        Served from local resource: {log.localResource}
                      </p>
                    )}
                    
                    <div className="flex items-center space-x-2 mt-2 text-xs text-slate-400">
                      <Clock className="w-3 h-3" />
                      <span>{new Date(log.timestamp).toLocaleString('it-IT')}</span>
                    </div>
                  </div>
                  
                  <button className="ml-4 text-slate-400 hover:text-white transition-colors">
                    {expandedLog === log.id ? (
                      <ChevronUp className="w-5 h-5" />
                    ) : (
                      <ChevronDown className="w-5 h-5" />
                    )}
                  </button>
                </div>
              </div>

              {expandedLog === log.id && (
                <div className="border-t border-[#2a2a2a] p-4 bg-[#0a0a0a]">
                  <div className="space-y-4">
                    {/* Action Buttons */}
                    <div className="pb-3 border-b border-[#2a2a2a] space-y-2">
                      <label className="flex items-center justify-center gap-2 px-4 py-2 bg-[#0a0a0a] border-2 border-blue-600 hover:bg-blue-600 text-blue-400 hover:text-white rounded-lg cursor-pointer transition-colors w-full">
                        <input
                          type="file"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files[0];
                            if (!file) return;
                            
                            const formData = new FormData();
                            formData.append('file', file);
                            formData.append('url', log.fullUrl || log.url);
                            
                            try {
                              const response = await fetch('http://localhost:8080/api/resources', {
                                method: 'POST',
                                body: formData
                              });
                              
                              if (response.ok) {
                                alert(`Resource replaced successfully!\nOra ${log.fullUrl || log.url} will serve the local file.`);
                              } else {
                                alert('Error uploading resource');
                              }
                            } catch (error) {
                              console.error('Error uploading resource:', error);
                              alert('Error during upload');
                            }
                            
                            e.target.value = '';
                          }}
                        />
                        <Replace className="w-4 h-4" />
                        <span>Replace with local file</span>
                      </label>
                      
                      <button
                        onClick={() => toggleBlockUrl(log.fullUrl || log.url)}
                        className={`flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-colors w-full border-2 ${
                          blockedUrls.some(u => (log.fullUrl || log.url).includes(u))
                            ? 'bg-[#0a0a0a] border-green-600 text-green-400 hover:bg-green-600 hover:text-white'
                            : 'bg-[#0a0a0a] border-orange-600 text-orange-400 hover:bg-orange-600 hover:text-white'
                        }`}
                      >
                        <Ban className="w-4 h-4" />
                        <span>
                          {blockedUrls.some(u => (log.fullUrl || log.url).includes(u))
                            ? 'Unblock URL'
                            : 'Block URL'}
                        </span>
                      </button>
                    </div>

                    {/* Request Section */}
                    <div className="border-b border-slate-700 pb-4">
                      <h3 className="text-base font-bold text-blue-400 mb-3">📤 Request</h3>
                      
                      <div className="space-y-3">
                        <div>
                          <h4 className="text-sm font-semibold text-slate-300 mb-2">Request Headers</h4>
                          <div className="bg-slate-950 p-3 rounded">
                            <ReactJson 
                              src={log.headers}
                              theme="monokai"
                              collapsed={1}
                              displayDataTypes={false}
                              displayObjectSize={false}
                              enableClipboard={true}
                              style={{ background: 'transparent', fontSize: '12px' }}
                            />
                          </div>
                        </div>
                        
                        {log.body && (typeof log.body === 'string' ? log.body.length > 0 : Object.keys(log.body).length > 0) && (() => {
                          const bodyString = typeof log.body === 'string' ? log.body : JSON.stringify(log.body);
                          const isJSON = bodyString.trim().startsWith('{') || bodyString.trim().startsWith('[');
                          
                          return (
                            <div>
                              <h4 className="text-sm font-semibold text-slate-300 mb-2">Request Body</h4>
                              {isJSON ? (
                                <div className="bg-slate-950 p-3 rounded">
                                  {(() => {
                                    try {
                                      const jsonData = typeof log.body === 'string' ? JSON.parse(log.body) : log.body;
                                      return (
                                        <ReactJson 
                                          src={jsonData}
                                          theme="monokai"
                                          collapsed={2}
                                          displayDataTypes={false}
                                          displayObjectSize={true}
                                          enableClipboard={true}
                                          style={{ background: 'transparent', fontSize: '12px' }}
                                        />
                                      );
                                    } catch {
                                      return (
                                        <pre className="text-xs text-slate-300 overflow-x-auto max-h-60">
                                          {bodyString}
                                        </pre>
                                      );
                                    }
                                  })()}
                                </div>
                              ) : (
                                <pre className="bg-slate-950 p-3 rounded text-xs text-slate-300 overflow-x-auto max-h-60">
                                  {bodyString}
                                </pre>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Response Section or WebSocket Message */}
                    {(log.responseHeaders || log.responseBody || (log.source === 'websocket' && log.body)) && (
                      <div>
                        <h3 className="text-base font-bold text-green-400 mb-3">
                          {log.source === 'websocket' ? '💬 Message' : '📥 Response'}
                        </h3>
                        
                        <div className="space-y-3">
                          {log.responseHeaders && (
                            <div>
                              <h4 className="text-sm font-semibold text-slate-300 mb-2">Response Headers</h4>
                              <div className="bg-slate-950 p-3 rounded">
                                <ReactJson 
                                  src={log.responseHeaders}
                                  theme="monokai"
                                  collapsed={1}
                                  displayDataTypes={false}
                                  displayObjectSize={false}
                                  enableClipboard={true}
                                  style={{ background: 'transparent', fontSize: '12px' }}
                                />
                              </div>
                            </div>
                          )}
                          
                          {/* Show responseBody OR body for WebSocket messages */}
                          {((log.responseBody && log.responseBody !== '0' && log.responseBody.length > 0) || 
                            (log.source === 'websocket' && log.body)) && (() => {
                            let bodyToShow = log.responseBody || (typeof log.body === 'string' ? log.body : JSON.stringify(log.body));
                            
                            // Socket.IO: clean up message format
                            if (log.source === 'websocket' && bodyToShow) {
                              // Remove numeric prefix (e.g., "42{...}" -> "{...}")
                              let i = 0;
                              while (i < bodyToShow.length && /\d/.test(bodyToShow[i])) {
                                i++;
                              }
                              if (i > 0) {
                                bodyToShow = bodyToShow.substring(i);
                              }
                              
                              // Remove Socket.IO channel prefix (e.g., "/ws/chat/quests,[...]" -> "[...]")
                              // Only if it starts with / and contains a comma
                              if (bodyToShow.startsWith('/')) {
                                const commaIndex = bodyToShow.indexOf(',');
                                if (commaIndex > 0) {
                                  bodyToShow = bodyToShow.substring(commaIndex + 1);
                                }
                              }
                            }
                            
                            const contentType = log.responseHeaders?.['content-type'] || '';
                            const url = (log.fullUrl || log.url).toLowerCase();
                            const trimmedBody = bodyToShow.trim();
                            
                            // Detect images by content-type or file extension
                            const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif', '.tiff'];
                            const isImage = contentType.includes('image/') || imageExtensions.some(ext => url.endsWith(ext));
                            
                            // Try to parse as JSON - most reliable way
                            let isJSON = contentType.includes('json') || url.endsWith('.json');
                            let jsonData = null;
                            if (!isJSON && !bodyToShow.includes('[Binary')) {
                              try {
                                jsonData = JSON.parse(bodyToShow);
                                isJSON = true;
                              } catch {}
                            }
                            
                            const isHTML = contentType.includes('html') || trimmedBody.startsWith('<!DOCTYPE') || trimmedBody.startsWith('<html');
                            
                            return (
                              <div>
                                <h4 className="text-sm font-semibold text-slate-300 mb-2">
                                  Response Body Preview
                                  {log.responseSize && (
                                    <span className="ml-2 text-xs text-slate-500">
                                      ({(log.responseSize / 1024).toFixed(2)} KB)
                                    </span>
                                  )}
                                </h4>
                                
                                {isImage ? (
                                  <div className="bg-slate-950 p-3 rounded">
                                    {bodyToShow.includes('[Binary') ? (
                                      <>
                                        <img 
                                          src={log.fullUrl || log.url} 
                                          alt="Response preview" 
                                          className="max-w-full max-h-96 rounded border border-slate-700"
                                          onError={(e) => {
                                            e.target.style.display = 'none';
                                            e.target.nextSibling.style.display = 'block';
                                          }}
                                        />
                                        <div style={{display: 'none'}} className="text-slate-500 text-sm">
                                          Unable to load image. Try opening it in a new tab: 
                                          <a href={log.fullUrl || log.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline ml-1">
                                            {log.fullUrl || log.url}
                                          </a>
                                        </div>
                                      </>
                                    ) : (
                                      <div className="text-slate-500 text-sm">
                                        Immagine rilevata ma body non disponibile. 
                                        <a href={log.fullUrl || log.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline ml-1">
                                          Apri in nuova scheda
                                        </a>
                                      </div>
                                    )}
                                  </div>
                                ) : isJSON && !bodyToShow.includes('[Binary') ? (
                                  <div className="bg-slate-950 p-3 rounded">
                                    {(() => {
                                      // Use already parsed data if available
                                      const data = jsonData || (() => {
                                        try {
                                          return JSON.parse(bodyToShow);
                                        } catch {
                                          return null;
                                        }
                                      })();
                                      
                                      if (data) {
                                        return (
                                          <ReactJson 
                                            src={data}
                                            theme="monokai"
                                            collapsed={2}
                                            displayDataTypes={false}
                                            displayObjectSize={true}
                                            enableClipboard={true}
                                            style={{ background: 'transparent', fontSize: '12px' }}
                                          />
                                        );
                                      } else {
                                        return (
                                          <pre className="text-xs text-slate-300 overflow-x-auto max-h-96">
                                            {bodyToShow}
                                          </pre>
                                        );
                                      }
                                    })()}
                                  </div>
                                ) : isHTML && !bodyToShow.includes('[Binary') ? (
                                  <div className="space-y-2">
                                    <div className="bg-slate-950 border border-slate-700 rounded p-3 max-h-96 overflow-auto">
                                      <iframe 
                                        srcDoc={bodyToShow}
                                        className="w-full h-96 bg-white rounded"
                                        sandbox="allow-same-origin"
                                        title="HTML Preview"
                                      />
                                    </div>
                                    <details className="bg-slate-950 rounded">
                                      <summary className="cursor-pointer p-3 text-xs text-slate-400 hover:text-slate-300">
                                        Mostra sorgente HTML
                                      </summary>
                                      <pre className="p-3 text-xs text-slate-300 overflow-x-auto max-h-60 border-t border-slate-800">
                                        {bodyToShow}
                                      </pre>
                                    </details>
                                  </div>
                                ) : (
                                  <pre className="bg-slate-950 p-3 rounded text-xs text-slate-300 overflow-x-auto max-h-96">
                                    {bodyToShow}
                                  </pre>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                    
                    {/* Error Section */}
                    {log.error && (
                      <div>
                        <h3 className="text-base font-bold text-red-400 mb-3">❌ Errore</h3>
                        <pre className="bg-red-950/30 p-3 rounded text-xs text-red-300 overflow-x-auto">
                          {log.error}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
    </>
  );
}

export default RequestLogs;
