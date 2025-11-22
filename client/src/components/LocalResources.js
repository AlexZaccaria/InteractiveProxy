import React, { useState } from 'react';
import { 
  Trash2, 
  FileText, 
  Image, 
  File,
  HardDrive,
  Link as LinkIcon,
  Plus,
  Upload,
  CheckCircle,
  AlertCircle,
  Power
} from 'lucide-react';
import axios from 'axios';
import Spinner from './Spinner';

/**
 * Panel for listing and managing local resource overrides.
 *
 * Users can toggle, add and remove local resources that override upstream responses
 * for matching URLs. This component also contains a small form for creating new
 * overrides with either file uploads or inline text content.
 *
 * @param {Object} props
 * @param {Array} props.resources List of currently configured local resources.
 * @param {(url: string) => Promise<void>} [props.onDelete] Optional callback to delete a resource by URL.
 * @param {() => void} [props.onRefresh] Optional callback invoked after changes so the parent can refetch.
 * @param {boolean} [props.enabled] Whether local resources are globally enabled.
 * @param {(enabled: boolean) => void} [props.onModeChange] Called when the global local-resources toggle is changed.
 */
function LocalResources({ resources, onDelete, onRefresh, enabled = true, onModeChange }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [mode, setMode] = useState('file'); // 'file' or 'text'
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [textContent, setTextContent] = useState('');
  const [contentType, setContentType] = useState('text/plain');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [deletingUrl, setDeletingUrl] = useState(null);
  const [togglingUrl, setTogglingUrl] = useState(null);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      if (!contentType || contentType === 'text/plain') {
        setContentType(selectedFile.type || 'application/octet-stream');
      }
    }
  };

  const handleDelete = async (resourceUrl) => {
    if (!onDelete) return;
    try {
      setDeletingUrl(resourceUrl);
      await onDelete(resourceUrl);
    } catch (err) {
      console.error('Error deleting local resource:', err);
    } finally {
      setDeletingUrl(null);
    }
  };

  const handleToggleEnabled = async (resource) => {
    if (!resource || !resource.url) return;
    try {
      setTogglingUrl(resource.url);
      const nextEnabled = resource.enabled === false ? true : false;
      await axios.post('/api/resources/toggle', {
        url: resource.url,
        enabled: nextEnabled
      });
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Error toggling local resource:', err);
    } finally {
      setTogglingUrl(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!url) {
      setError('URL is required');
      return;
    }

    if (mode === 'file' && !file) {
      setError('Select a file to upload');
      return;
    }

    if (mode === 'text' && !textContent) {
      setError('Please enter text content');
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('url', url);
      formData.append('contentType', contentType);

      if (mode === 'file') {
        formData.append('file', file);
      } else {
        formData.append('content', textContent);
      }

      await axios.post('/api/resources', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      setSuccess('Resource added successfully!');
      
      setTimeout(() => {
        setUrl('');
        setFile(null);
        setTextContent('');
        setContentType('text/plain');
        setSuccess('');
        setShowAddForm(false);
        if (onRefresh) onRefresh();
      }, 1500);
    } catch (err) {
      setError(err.response?.data?.error || 'Error uploading resource');
    } finally {
      setLoading(false);
    }
  };
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const getFileIcon = (contentType) => {
    if (contentType.startsWith('image/')) {
      return <Image className="w-5 h-5 text-purple-400" />;
    } else if (contentType.includes('json') || contentType.includes('javascript')) {
      return <FileText className="w-5 h-5 text-blue-400" />;
    } else if (contentType.includes('text')) {
      return <FileText className="w-5 h-5 text-green-400" />;
    }
    return <File className="w-5 h-5 text-slate-400" />;
  };

  const getContentTypeBadge = (contentType) => {
    if (contentType.startsWith('image/')) {
      return 'bg-purple-500/20 text-purple-400 border-purple-500/30';
    } else if (contentType.includes('json')) {
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    } else if (contentType.includes('javascript')) {
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    } else if (contentType.includes('html')) {
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    } else if (contentType.includes('text')) {
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    }
    return 'bg-slate-500/20 text-slate-400 border-slate-500/30';
  };

  return (
    <div className="space-y-4">
      <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="relative group/local-resources">
              <button
                type="button"
                onClick={() => onModeChange && onModeChange(!enabled)}
                className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border transition-colors ${
                  enabled
                    ? 'bg-emerald-600/20 border-emerald-600/30 text-emerald-300'
                    : 'bg-slate-700/40 border-slate-600/50 text-slate-400'
                }`}
                aria-pressed={!!enabled}
              >
                <HardDrive className="w-4 h-4" />
                <span className="text-xs font-medium tracking-wide">{enabled ? 'ON' : 'OFF'}</span>
              </button>
              <div
                className="invisible group-hover/local-resources:visible absolute left-full bottom-full ml-2 mb-2 w-64 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-xs text-slate-300 shadow-2xl"
                style={{ zIndex: 99999 }}
              >
                <div className="font-semibold mb-1 text-slate-200">Local resources</div>
                <p>
                  {enabled
                    ? 'Local resources are active and will override matching URLs with your configured files or text.'
                    : 'Local resources are disabled. Requests will go to the remote server even if a matching local entry exists.'}
                </p>
              </div>
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Local Resources</h3>
              <p className="text-xs text-slate-400">
                {resources.length} {resources.length === 1 ? 'resource loaded' : 'resources loaded'}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            disabled={showAddForm}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30 hover:text-white disabled:bg-slate-700 disabled:text-slate-500 disabled:border-slate-600/50 transition-colors text-xs font-medium"
          >
            <Plus className="w-4 h-4" />
            <span>Add Resource</span>
          </button>
        </div>
      </div>

      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="text-sm text-slate-300">
            <p className="font-medium text-emerald-400 mb-1">How it works</p>
            <p>
              Local resources intercept matching URLs and serve your custom content instead of forwarding the request.
              When a request URL contains your specified pattern, the proxy returns your local file or text content immediately.
              This is useful for testing, mocking APIs, or replacing remote assets with local versions.
            </p>
          </div>
        </div>
      </div>

      {showAddForm && (
        <div className="bg-[#1a1a1a] rounded-lg p-5 border border-[#2a2a2a]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h4 className="text-sm font-semibold text-white">Add local resource</h4>
              <p className="text-xs text-slate-400">
                Serve a local file or inline content when the request URL matches.
              </p>
            </div>

            {/* Mode Selection */}
            <div className="inline-flex items-center rounded-full bg-[#050508] border border-[#252525] p-0.5">
              <button
                type="button"
                onClick={() => setMode('file')}
                className={`px-3 h-8 text-xs font-medium tracking-wide rounded-full transform transition-all duration-150 ${
                  mode === 'file'
                    ? 'bg-slate-800 text-slate-100 scale-100'
                    : 'bg-transparent text-slate-400 hover:bg-[#161616] hover:text-slate-100 scale-95'
                }`}
              >
                File
              </button>
              <button
                type="button"
                onClick={() => setMode('text')}
                className={`px-3 h-8 text-xs font-medium tracking-wide rounded-full transform transition-all duration-150 ml-0.5 ${
                  mode === 'text'
                    ? 'bg-[#101716] border border-emerald-600/60 text-emerald-200 scale-100'
                    : 'bg-transparent text-slate-400 hover:bg-[#161616] hover:text-slate-100 scale-95'
                }`}
              >
                Text
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* URL Input */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                URL to intercept
              </label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="e.g. /api/data.json or https://example.com/api/data.json"
                className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                required
              />
            </div>

            {/* Content Type */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                Content type
              </label>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value)}
                className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="text/plain">text/plain</option>
                <option value="text/html">text/html</option>
                <option value="application/json">application/json</option>
                <option value="application/javascript">application/javascript</option>
                <option value="text/css">text/css</option>
                <option value="image/jpeg">image/jpeg</option>
                <option value="image/png">image/png</option>
                <option value="image/gif">image/gif</option>
                <option value="image/svg+xml">image/svg+xml</option>
                <option value="application/octet-stream">application/octet-stream</option>
              </select>
            </div>

            {/* File Upload Mode */}
            {mode === 'file' && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  File to upload
                </label>
                <div className="relative">
                  <input
                    type="file"
                    id="file-upload"
                    onChange={handleFileChange}
                    className="hidden"
                    required
                  />
                  <label
                    htmlFor="file-upload"
                    className="flex items-center justify-center w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-slate-400 hover:border-blue-500 hover:text-blue-400 cursor-pointer transition-colors"
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    <span>{file ? file.name : 'Choose a file...'}</span>
                  </label>
                </div>
                {file && (
                  <p className="mt-2 text-sm text-green-400">
                    Selected file: {file.name} ({(file.size / 1024).toFixed(2)} KB)
                  </p>
                )}
              </div>
            )}

            {/* Text Content Mode */}
            {mode === 'text' && (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  Content
                </label>
                <textarea
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                  placeholder="Enter text content, JSON, HTML, etc..."
                  rows={8}
                  className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono resize-none"
                  required
                />
                <p className="mt-2 text-xs text-slate-400">
                  {textContent.length} characters
                </p>
              </div>
            )}

            {/* Error Message */}
            {error && (
              <div className="flex items-center space-x-2 p-4 bg-red-900/40 border border-red-800 rounded-lg text-red-200">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            {/* Success Message */}
            {success && (
              <div className="flex items-center space-x-2 p-4 bg-emerald-900/40 border border-emerald-700 rounded-lg text-emerald-200">
                <CheckCircle className="w-5 h-5 flex-shrink-0" />
                <p className="text-sm">{success}</p>
              </div>
            )}

            {/* Submit Button */}
            <div className="flex items-center gap-3 pt-4 border-t border-[#2a2a2a]">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 h-8 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30 hover:text-white disabled:bg-slate-700 disabled:text-slate-500 disabled:border-slate-600/50 transition-colors text-xs font-medium"
              >
                {loading ? (
                  <>
                    <Spinner size="sm" color="blue" />
                    <span>Uploading...</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    <span>Add resource</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="inline-flex items-center justify-center px-4 h-8 rounded-lg bg-[#0a0a0a] border border-[#2a2a2a] text-xs font-medium text-slate-300 hover:bg-[#1a1a1a] hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {resources.length === 0 ? (
        <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] text-center">
          <HardDrive className="w-16 h-16 text-slate-600 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-white mb-2">No local resources</h3>
          <p className="text-slate-400 mb-6">
            Upload files or text content to override remote resources.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {resources.map((resource) => {
            const isEnabled = resource.enabled !== false;
            return (
              <div
                key={resource.url}
                className={`bg-[#0a0a0a] rounded-lg border p-4 transition-colors ${
                  isEnabled
                    ? 'border-[#2a2a2a] hover:border-emerald-500/70'
                    : 'border-slate-700/40 opacity-70'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2 mb-2">
                      {getFileIcon(resource.contentType)}
                      <span className={`px-2 py-1 rounded text-xs font-medium border ${getContentTypeBadge(resource.contentType)}`}>
                        {resource.contentType}
                      </span>
                      <span className="px-2 py-1 rounded text-xs font-medium border bg-slate-500/20 text-slate-400 border-slate-500/30">
                        {formatBytes(resource.size)}
                      </span>
                    </div>
                    
                    <div className="flex items-start space-x-2 mb-2">
                      <LinkIcon className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                      <p className="text-white font-mono text-sm break-all">
                        {resource.url}
                      </p>
                    </div>
                    
                    <p className="text-slate-400 text-xs mb-1">
                      File: {resource.originalName || resource.filename}
                    </p>
                  </div>
                  
                  <div className="ml-4 flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleToggleEnabled(resource)}
                      disabled={togglingUrl === resource.url}
                      className={`inline-flex items-center justify-center gap-2 px-3 h-8 rounded-lg transition-colors border text-xs font-medium ${
                        isEnabled
                          ? 'bg-emerald-600/20 border-emerald-500/60 text-emerald-200 hover:bg-emerald-600/30'
                          : 'bg-slate-700/20 border-slate-600/60 text-slate-400 hover:bg-slate-700/30'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                      title={isEnabled ? 'Disable local resource' : 'Enable local resource'}
                    >
                      {togglingUrl === resource.url ? (
                        <Spinner size="sm" />
                      ) : (
                        <Power className="w-4 h-4" />
                      )}
                    </button>

                    <button
                      onClick={() => handleDelete(resource.url)}
                      disabled={deletingUrl === resource.url}
                      className="inline-flex items-center justify-center gap-2 px-3 h-8 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium"
                      title="Delete resource"
                    >
                      {deletingUrl === resource.url ? (
                        <Spinner size="sm" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default LocalResources;
