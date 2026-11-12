import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import Modal from '../../components/Modal'
import { useModal } from '../../hooks/useModal'
import { ApiError } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import {
  fetchCurlCommand,
  useBlockedRuleMutation,
  useBlockedRules,
  useResourceMutations
} from '../../lib/queries'
import CurlCommandDialog from './CurlCommandDialog'
import LogFilters from './LogFilters'
import LogList from './LogList'
import ReplayDialog from './ReplayDialog'
import { downloadHarExport, downloadLogsExport, importHarFile } from './exportLogs'
import { useLogFilters } from './useLogFilters'
import { useLogList } from './useLogList'

/** @typedef {import('../../lib/types').LogSummary} LogSummary */
/** @typedef {import('../../lib/types').BlockedRule} BlockedRule */

/**
 * The URL patterns of the blocked rules, each once.
 *
 * @param {BlockedRule[] | undefined} rules
 * @returns {string[]}
 */
export function extractBlockedPatterns(rules) {
  if (!Array.isArray(rules)) return []
  const patterns = []
  for (const rule of rules) {
    const pattern =
      typeof rule === 'string' ? rule : rule && typeof rule.url === 'string' ? rule.url.trim() : ''
    if (pattern && !patterns.includes(pattern)) patterns.push(pattern)
  }
  return patterns
}

/**
 * The Requests tab: the filters, the virtualised list and the actions of
 * each card. The parent supplies the live-update signals and receives the
 * filtered count and the export function.
 *
 * @param {Object} props
 * @param {(count: number) => void} [props.onFilteredCountChange] Called with the total the server reports for the filters.
 * @param {(exportFn: () => Promise<void>) => void} [props.onExportLogs] Receives the function that downloads the export.
 * @param {number | string} [props.refreshToken] Changing it discards the list (the logs were cleared).
 * @param {(seed: import('./jsonPath').JsonPathRuleSeed) => void} [props.onCreateJsonPathRule] Called with the seed of a rule built from a JSON node.
 * @param {boolean} [props.eventsConnected] True while the event stream is open; the first-page poll is then off.
 * @param {number} [props.logsVersion] Bumped by the parent on every `log` event.
 */
function RequestLogsInner({
  onFilteredCountChange,
  onExportLogs,
  refreshToken = 0,
  onCreateJsonPathRule,
  eventsConnected = false,
  logsVersion = 0
}) {
  const { modalState, closeModal, showPrompt, showAlert } = useModal()
  const filterState = useLogFilters()
  const { filters, isDebouncing } = filterState

  /** @type {[string | null, (value: string | null | ((current: string | null) => string | null)) => void]} */
  const [expandedId, setExpandedId] = useState(null)
  const [pinnedRewritesId, setPinnedRewritesId] = useState(null)
  // Entries marked for export; a client-side flag that does not persist.
  const [exportSelection, setExportSelection] = useState(() => new Set())
  // The entry whose replay form is open, and the curl command shown when
  // the clipboard is not available; the copied state lasts two seconds.
  const [replayLog, setReplayLog] = useState(/** @type {LogSummary | null} */ (null))
  const [curlCommand, setCurlCommand] = useState(/** @type {string | null} */ (null))
  const [curlCopiedId, setCurlCopiedId] = useState(/** @type {string | null} */ (null))
  const curlTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null))
  useEffect(
    () => () => {
      if (curlTimerRef.current) clearTimeout(curlTimerRef.current)
    },
    []
  )

  const list = useLogList({
    filters,
    isDebouncing,
    refreshToken,
    logsVersion,
    eventsConnected,
    expandedId
  })

  // Clearing the logs also drops the export marks.
  const handledRefreshRef = useRef(refreshToken)
  useEffect(() => {
    if (refreshToken === handledRefreshRef.current) return
    handledRefreshRef.current = refreshToken
    setExportSelection(new Set())
  }, [refreshToken])

  const blockedQuery = useBlockedRules()
  const blockedPatterns = useMemo(
    () => extractBlockedPatterns(blockedQuery.data),
    [blockedQuery.data]
  )
  const blockedMutation = useBlockedRuleMutation()
  const { create: createResource } = useResourceMutations()

  const copyCurl = useCallback(
    /** @param {LogSummary} log */
    async log => {
      try {
        const { command } = await fetchCurlCommand(log.id)
        if (await copyText(command)) {
          setCurlCopiedId(String(log.id))
          if (curlTimerRef.current) clearTimeout(curlTimerRef.current)
          curlTimerRef.current = setTimeout(() => setCurlCopiedId(null), 2000)
        } else {
          setCurlCommand(command)
        }
      } catch (error) {
        showAlert('Copy as cURL', error instanceof Error ? error.message : String(error), 'error')
      }
    },
    [showAlert]
  )

  const closeReplay = useCallback(() => setReplayLog(null), [])
  const closeCurl = useCallback(() => setCurlCommand(null), [])

  const isBlocked = useCallback(
    /** @param {string} targetUrl */
    targetUrl => {
      if (!targetUrl) return false
      return blockedPatterns.some(pattern => targetUrl.includes(pattern))
    },
    [blockedPatterns]
  )

  const toggleBlockUrl = useCallback(
    /** @param {string} url */
    async url => {
      // A pattern contained in the URL, or containing it, counts as a match.
      const matching = blockedPatterns.find(
        pattern => url.includes(pattern) || pattern.includes(url)
      )

      if (matching) {
        try {
          await blockedMutation.mutateAsync({ action: 'remove', url: matching })
        } catch (error) {
          console.error('Error unblocking URL:', error)
        }
        return
      }

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
      )
      if (!editedUrl || !editedUrl.trim()) return

      try {
        await blockedMutation.mutateAsync({
          action: 'add',
          url: editedUrl.trim(),
          name: '',
          enabled: true
        })
      } catch (error) {
        console.error('Error blocking URL:', error)
      }
    },
    [blockedPatterns, blockedMutation, showPrompt]
  )

  const replaceResource = useCallback(
    /**
     * @param {LogSummary} log
     * @param {File} file
     */
    async (log, file) => {
      const url = log.fullUrl || log.url
      const formData = new FormData()
      formData.append('file', file)
      formData.append('url', url)

      try {
        await createResource.mutateAsync(formData)
        showAlert('Resource replaced successfully', `${url} will now serve the local file.`, 'info')
      } catch (error) {
        console.error('Error uploading resource:', error)
        showAlert(
          'Upload failed',
          error instanceof ApiError ? 'Error uploading resource' : 'Error during upload',
          'error'
        )
      }
    },
    [createResource, showAlert]
  )

  const toggleExpand = useCallback(
    /** @param {string} id */
    id => setExpandedId(current => (current === id ? null : id)),
    []
  )
  const toggleRewritesPin = useCallback(
    /** @param {string} id */
    id => setPinnedRewritesId(current => (current === id ? null : id)),
    []
  )
  const toggleExportSelection = useCallback(
    /** @param {string} id */
    id => {
      if (id === null || id === undefined) return
      const key = String(id)
      setExportSelection(previous => {
        const next = new Set(previous)
        if (next.has(key)) {
          next.delete(key)
        } else {
          next.add(key)
        }
        return next
      })
    },
    []
  )

  const exportLogs = useCallback(
    () => downloadLogsExport(filters, Array.from(exportSelection)),
    [filters, exportSelection]
  )

  const exportHar = useCallback(async () => {
    try {
      await downloadHarExport(filters, Array.from(exportSelection))
    } catch (error) {
      showAlert('Export HAR', error instanceof Error ? error.message : String(error), 'error')
    }
  }, [filters, exportSelection, showAlert])

  const importHar = useCallback(
    /** @param {import('react').ChangeEvent<HTMLInputElement>} event */
    async event => {
      const file = event.target.files && event.target.files[0]
      event.target.value = ''
      if (!file) return
      try {
        const result = await importHarFile(file)
        showAlert(
          'Import HAR',
          `${result.imported} ${result.imported === 1 ? 'entry' : 'entries'} imported` +
            (result.skipped > 0 ? `, ${result.skipped} skipped.` : '.')
        )
      } catch (error) {
        showAlert('Import HAR', error instanceof Error ? error.message : String(error), 'error')
      }
    },
    [showAlert]
  )

  const { total } = list
  useEffect(() => {
    if (onFilteredCountChange) onFilteredCountChange(total)
  }, [total, onFilteredCountChange])

  useEffect(() => {
    if (onExportLogs) onExportLogs(exportLogs)
  }, [onExportLogs, exportLogs])

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
      {replayLog && <ReplayDialog log={replayLog} onClose={closeReplay} />}
      {curlCommand !== null && <CurlCommandDialog command={curlCommand} onClose={closeCurl} />}

      <div className="space-y-4">
        <LogFilters
          searchTerm={filterState.searchTerm}
          requestBodySearch={filterState.requestBodySearch}
          responseSearchTerm={filterState.responseSearchTerm}
          onSearchTermChange={filterState.setSearchTerm}
          onRequestBodySearchChange={filterState.setRequestBodySearch}
          onResponseSearchTermChange={filterState.setResponseSearchTerm}
          requestRewrittenOnly={filters.requestRewrittenOnly}
          responseRewrittenOnly={filters.responseRewrittenOnly}
          onToggleRequestRewrittenOnly={filterState.toggleRequestRewrittenOnly}
          onToggleResponseRewrittenOnly={filterState.toggleResponseRewrittenOnly}
          selectedSources={filters.sources}
          selectedMethods={filters.methods}
          selectedFileTypes={filters.fileTypes}
          showWsConnections={filters.showWsConnections}
          onToggleSource={filterState.toggleSource}
          onToggleMethod={filterState.toggleMethod}
          onToggleFileType={filterState.toggleFileType}
          onShowWsConnectionsChange={filterState.setShowWsConnections}
        />

        {/* HAR archive: the current view (or the marked entries) out, a file in */}
        <div className="flex items-center justify-end gap-2">
          <label className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs border border-edge text-fg-body hover:bg-surface-highlight cursor-pointer transition-colors">
            <Upload className="w-3.5 h-3.5" />
            <span>Import HAR</span>
            <input
              type="file"
              name="import-har"
              accept=".har,application/json"
              className="hidden"
              aria-label="Import HAR file"
              onChange={importHar}
            />
          </label>
          <button
            type="button"
            onClick={exportHar}
            disabled={list.items.length === 0}
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs border border-edge text-fg-body hover:bg-surface-highlight disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export HAR</span>
          </button>
        </div>

        <LogList
          items={list.items}
          showLoading={list.showLoading}
          isFetching={list.isFetching}
          isFetchingNextPage={list.isFetchingNextPage}
          hasMore={list.hasMore}
          loadMore={list.loadMore}
          expandedId={expandedId}
          exportSelection={exportSelection}
          pinnedRewritesId={pinnedRewritesId}
          isBlocked={isBlocked}
          onToggleExpand={toggleExpand}
          onToggleExport={toggleExportSelection}
          onToggleBlock={toggleBlockUrl}
          onToggleRewritesPin={toggleRewritesPin}
          onReplaceResource={replaceResource}
          onReplay={setReplayLog}
          onCopyCurl={copyCurl}
          curlCopiedId={curlCopiedId}
          onCreateJsonPathRule={onCreateJsonPathRule}
        />
      </div>
    </>
  )
}

const RequestLogs = memo(RequestLogsInner)

export default RequestLogs
