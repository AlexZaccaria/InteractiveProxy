import React, { useState } from 'react'
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
} from 'lucide-react'
import Spinner from './Spinner'
import { ApiError } from '../lib/api'
import { useResourceMutations, useResources, useSetFlag } from '../lib/queries'
import { useProxyStore } from '../store/useProxyStore'
import Tooltip from './Tooltip'

/**
 * Panel for listing and managing local resource overrides.
 *
 * Users can toggle, add and remove local resources that override upstream responses
 * for matching URLs. This component also contains a small form for creating new
 * overrides with either file uploads or inline text content.
 *
 * The list comes from the `resources` query; the global toggle is the
 * `localResourcesEnabled` flag of the store.
 *
 * @param {Object} props
 * @param {(title: string, message: string) => Promise<boolean>} [props.showConfirm] Confirm helper used before deleting a resource.
 */
function LocalResources({ showConfirm }) {
  const enabled = useProxyStore(state => state.localResourcesEnabled)
  const setLocalResourcesMode = useSetFlag('local-resources-mode')
  const resourcesQuery = useResources()
  const { create, toggle, remove } = useResourceMutations()
  const resources = resourcesQuery.data || []
  const [showAddForm, setShowAddForm] = useState(false)
  const [mode, setMode] = useState('file') // 'file' or 'text'
  const [url, setUrl] = useState('')
  const [file, setFile] = useState(null)
  const [textContent, setTextContent] = useState('')
  const [contentType, setContentType] = useState('text/plain')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [deletingUrl, setDeletingUrl] = useState(null)
  const [togglingUrl, setTogglingUrl] = useState(null)

  const handleFileChange = e => {
    const selectedFile = e.target.files[0]
    if (selectedFile) {
      setFile(selectedFile)
      if (!contentType || contentType === 'text/plain') {
        setContentType(selectedFile.type || 'application/octet-stream')
      }
    }
  }

  const handleDelete = async resourceUrl => {
    try {
      setDeletingUrl(resourceUrl)
      const confirmed = showConfirm
        ? await showConfirm(
            'Delete local resource',
            `Are you sure you want to delete the resource for ${resourceUrl}? This action cannot be undone.`
          )
        : true

      if (!confirmed) return

      await remove.mutateAsync(resourceUrl)
    } catch (err) {
      console.error('Error deleting local resource:', err)
    } finally {
      setDeletingUrl(null)
    }
  }

  const handleToggleEnabled = async resource => {
    if (!resource || !resource.url) return
    try {
      setTogglingUrl(resource.url)
      const nextEnabled = resource.enabled === false ? true : false
      await toggle.mutateAsync({ url: resource.url, enabled: nextEnabled })
    } catch (err) {
      console.error('Error toggling local resource:', err)
    } finally {
      setTogglingUrl(null)
    }
  }

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (!url) {
      setError('URL is required')
      return
    }

    if (mode === 'file' && !file) {
      setError('Select a file to upload')
      return
    }

    if (mode === 'text' && !textContent) {
      setError('Please enter text content')
      return
    }

    setLoading(true)

    try {
      const formData = new FormData()
      formData.append('url', url)
      formData.append('contentType', contentType)

      if (mode === 'file') {
        formData.append('file', file)
      } else {
        formData.append('content', textContent)
      }

      await create.mutateAsync(formData)

      setSuccess('Resource added successfully!')

      setTimeout(() => {
        setUrl('')
        setFile(null)
        setTextContent('')
        setContentType('text/plain')
        setSuccess('')
        setShowAddForm(false)
      }, 1500)
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body?.error === 'string'
          ? err.body.error
          : 'Error uploading resource'
      )
    } finally {
      setLoading(false)
    }
  }
  const formatBytes = bytes => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  const getFileIcon = contentType => {
    if (contentType.startsWith('image/')) {
      return <Image className="w-5 h-5 text-purple-400" />
    } else if (contentType.includes('json') || contentType.includes('javascript')) {
      return <FileText className="w-5 h-5 text-blue-400" />
    } else if (contentType.includes('text')) {
      return <FileText className="w-5 h-5 text-green-400" />
    }
    return <File className="w-5 h-5 text-fg-muted" />
  }

  const getContentTypeBadge = contentType => {
    if (contentType.startsWith('image/')) {
      return 'bg-purple-500/20 text-purple-400 border-purple-500/30'
    } else if (contentType.includes('json')) {
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30'
    } else if (contentType.includes('javascript')) {
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    } else if (contentType.includes('html')) {
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30'
    } else if (contentType.includes('text')) {
      return 'bg-green-500/20 text-green-400 border-green-500/30'
    }
    return 'bg-fg-faint/20 text-fg-muted border-fg-faint/30'
  }

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-lg p-4 border border-edge">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <Tooltip
              title="Local resources"
              description={
                enabled
                  ? 'Local resources are active and will override matching URLs with your configured files or text.'
                  : 'Local resources are disabled. Requests will go to the remote server even if a matching local entry exists.'
              }
              placement="bottom-start"
            >
              <button
                type="button"
                onClick={() => setLocalResourcesMode.mutate(!enabled)}
                className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border transition-colors ${
                  enabled
                    ? 'bg-emerald-600/20 border-emerald-600/30 text-emerald-300'
                    : 'bg-accent-neutral/40 border-fg-dim/50 text-fg-muted'
                }`}
                aria-pressed={!!enabled}
              >
                <HardDrive className="w-4 h-4" />
                <span className="text-xs font-medium tracking-wide">{enabled ? 'ON' : 'OFF'}</span>
              </button>
            </Tooltip>
            <div>
              <h3 className="text-base font-semibold text-fg">Local Resources</h3>
              <p className="text-xs text-fg-muted">
                {resources.length} {resources.length === 1 ? 'resource loaded' : 'resources loaded'}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            disabled={showAddForm}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30 hover:text-fg disabled:bg-surface-highlight disabled:text-fg-faint disabled:border-fg-dim/50 transition-colors text-xs font-medium"
          >
            <Plus className="w-4 h-4" />
            <span>Add Resource</span>
          </button>
        </div>
      </div>

      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="text-sm text-fg-body">
            <p className="font-medium text-emerald-400 mb-1">How it works</p>
            <p>
              Local resources intercept matching URLs and serve your custom content instead of
              forwarding the request. When a request URL contains your specified pattern, the proxy
              returns your local file or text content immediately. This is useful for testing,
              mocking APIs, or replacing remote assets with local versions.
            </p>
          </div>
        </div>
      </div>

      {showAddForm && (
        <div className="bg-surface-raised rounded-lg p-5 border border-edge">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h4 className="text-sm font-semibold text-fg">Add local resource</h4>
              <p className="text-xs text-fg-muted">
                Serve a local file or inline content when the request URL matches.
              </p>
            </div>

            {/* Mode Selection */}
            <div
              role="group"
              aria-label="Resource kind"
              className="inline-flex items-center rounded-full bg-surface-sunken border border-edge-subtle p-0.5"
            >
              <button
                type="button"
                onClick={() => setMode('file')}
                className={`px-3 h-8 text-xs font-medium tracking-wide rounded-full transform transition-all duration-150 ${
                  mode === 'file'
                    ? 'bg-surface-active text-fg-strong scale-100'
                    : 'bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-strong scale-95'
                }`}
              >
                File
              </button>
              <button
                type="button"
                onClick={() => setMode('text')}
                className={`px-3 h-8 text-xs font-medium tracking-wide rounded-full transform transition-all duration-150 ml-0.5 ${
                  mode === 'text'
                    ? 'bg-emerald-500/10 border border-emerald-600/60 text-emerald-200 scale-100'
                    : 'bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-strong scale-95'
                }`}
              >
                Text
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* URL Input */}
            <div>
              <label
                htmlFor="local-resource-url"
                className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2"
              >
                URL to intercept
              </label>
              <input
                type="text"
                id="local-resource-url"
                name="local-resource-url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="e.g. /api/data.json or https://example.com/api/data.json"
                className="w-full px-3 h-8 bg-surface border border-edge rounded-lg text-xs text-fg placeholder-fg-muted focus:outline-hidden focus:ring-1 focus:ring-blue-500"
                required
              />
            </div>

            {/* Content Type */}
            <div>
              <label
                htmlFor="local-resource-content-type"
                className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2"
              >
                Content type
              </label>
              <select
                id="local-resource-content-type"
                name="local-resource-content-type"
                value={contentType}
                onChange={e => setContentType(e.target.value)}
                className="w-full px-3 h-8 bg-surface border border-edge rounded-lg text-xs text-fg focus:outline-hidden focus:ring-1 focus:ring-blue-500"
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
                <span className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2">
                  File to upload
                </span>
                <div className="relative">
                  <input
                    type="file"
                    id="file-upload"
                    name="file-upload"
                    aria-label="File to upload"
                    onChange={handleFileChange}
                    className="hidden"
                    required
                  />
                  <label
                    htmlFor="file-upload"
                    className="flex items-center justify-center w-full px-3 py-2 bg-surface border border-edge rounded-lg text-sm text-fg-muted hover:border-blue-500 hover:text-blue-400 cursor-pointer transition-colors"
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
                <label
                  htmlFor="local-resource-content"
                  className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2"
                >
                  Content
                </label>
                <textarea
                  id="local-resource-content"
                  name="local-resource-content"
                  value={textContent}
                  onChange={e => setTextContent(e.target.value)}
                  placeholder="Enter text content, JSON, HTML, etc..."
                  rows={8}
                  className="w-full px-3 py-2 bg-surface border border-edge rounded-lg text-xs text-fg placeholder-fg-muted focus:outline-hidden focus:ring-1 focus:ring-blue-500 font-mono resize-none"
                  required
                />
                <p className="mt-2 text-xs text-fg-muted">{textContent.length} characters</p>
              </div>
            )}

            {/* Error Message */}
            {error && (
              <div className="flex items-center space-x-2 p-4 bg-red-900/40 border border-red-800 rounded-lg text-red-200">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            {/* Success Message */}
            {success && (
              <div className="flex items-center space-x-2 p-4 bg-emerald-900/40 border border-emerald-700 rounded-lg text-emerald-200">
                <CheckCircle className="w-5 h-5 shrink-0" />
                <p className="text-sm">{success}</p>
              </div>
            )}

            {/* Submit Button */}
            <div className="flex items-center gap-3 pt-4 border-t border-edge">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 h-8 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/30 hover:text-fg disabled:bg-surface-highlight disabled:text-fg-faint disabled:border-fg-dim/50 transition-colors text-xs font-medium"
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
                className="inline-flex items-center justify-center px-4 h-8 rounded-lg bg-surface border border-edge text-xs font-medium text-fg-body hover:bg-surface-raised hover:text-fg transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {resources.length === 0 ? (
        <div className="bg-surface-raised rounded-lg p-12 border border-edge text-center">
          <HardDrive className="w-16 h-16 text-fg-dim mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-fg mb-2">No local resources</h3>
          <p className="text-fg-muted mb-6">
            Upload files or text content to override remote resources.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {resources.map(resource => {
            const isEnabled = resource.enabled !== false
            return (
              <div
                key={resource.url}
                className={`bg-surface rounded-lg border p-4 transition-colors ${
                  isEnabled
                    ? 'border-edge hover:border-emerald-500/70'
                    : 'border-edge/40 opacity-70'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2 mb-2">
                      {getFileIcon(resource.contentType)}
                      <span
                        className={`px-2 py-1 rounded text-xs font-medium border ${getContentTypeBadge(resource.contentType)}`}
                      >
                        {resource.contentType}
                      </span>
                      <span className="px-2 py-1 rounded text-xs font-medium border bg-fg-faint/20 text-fg-muted border-fg-faint/30">
                        {formatBytes(resource.size)}
                      </span>
                    </div>

                    <div className="flex items-start space-x-2 mb-2">
                      <LinkIcon className="w-4 h-4 text-fg-muted mt-0.5 shrink-0" />
                      <p className="text-fg font-mono text-sm break-all">{resource.url}</p>
                    </div>

                    <p className="text-fg-muted text-xs mb-1">
                      File: {resource.originalName || resource.filename}
                    </p>
                  </div>

                  <div className="ml-4 flex items-center gap-2 shrink-0">
                    <Tooltip title={isEnabled ? 'Disable local resource' : 'Enable local resource'}>
                      <button
                        onClick={() => handleToggleEnabled(resource)}
                        disabled={togglingUrl === resource.url}
                        className={`inline-flex items-center justify-center gap-2 px-3 h-8 rounded-lg transition-colors border text-xs font-medium ${
                          isEnabled
                            ? 'bg-emerald-600/20 border-emerald-500/60 text-emerald-200 hover:bg-emerald-600/30'
                            : 'bg-accent-neutral/20 border-fg-dim/60 text-fg-muted hover:bg-accent-neutral/30'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                        aria-label={isEnabled ? 'Disable local resource' : 'Enable local resource'}
                      >
                        {togglingUrl === resource.url ? (
                          <Spinner size="sm" />
                        ) : (
                          <Power className="w-4 h-4" />
                        )}
                      </button>
                    </Tooltip>

                    <Tooltip title="Delete resource">
                      <button
                        onClick={() => handleDelete(resource.url)}
                        disabled={deletingUrl === resource.url}
                        className="inline-flex items-center justify-center gap-2 px-3 h-8 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium"
                        aria-label="Delete resource"
                      >
                        {deletingUrl === resource.url ? (
                          <Spinner size="sm" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default LocalResources
