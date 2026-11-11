import { useCallback, useState } from 'react'
import { AlertCircle, Pause, Plus, Power, Trash2 } from 'lucide-react'
import Spinner from '../../components/Spinner'
import Tooltip from '../../components/Tooltip'
import { INPUT_CLASS, LABEL_CLASS } from '../../lib/httpForm'
import { useBreakpointRuleMutation, useBreakpointRules, useSetFlag } from '../../lib/queries'
import { useProxyStore } from '../../store/useProxyStore'

/** @typedef {import('../../lib/types').BreakpointRule} BreakpointRule */
/** @typedef {import('../../lib/types').PausedBreakpoint} PausedBreakpoint */

const PHASE_OPTIONS = [
  ['both', 'Request and response'],
  ['request', 'Request'],
  ['response', 'Response']
]

/**
 * @param {string} phase
 * @returns {string}
 */
export function phaseLabel(phase) {
  const option = PHASE_OPTIONS.find(([value]) => value === phase)
  return option ? option[1] : 'Request and response'
}

const EMPTY_FORM = { url: '', name: '', phase: 'both' }

/**
 * The Breakpoints tab: the global switch, the flows paused right now, the
 * form that adds a rule and the list of rules.
 *
 * @param {Object} props
 * @param {(title: string, message: string) => Promise<boolean>} [props.showConfirm]
 * @param {PausedBreakpoint[]} props.pending The flows held at a breakpoint.
 * @param {(item: PausedBreakpoint) => void} props.onOpenPending Opens the editor of a paused flow.
 */
export default function Breakpoints({ showConfirm, pending, onOpenPending }) {
  const enabled = useProxyStore(state => state.breakpointsEnabled)
  const setBreakpointsMode = useSetFlag('breakpoints-mode')
  const rulesQuery = useBreakpointRules()
  const rules = rulesQuery.data || []
  const { mutateAsync: mutateRule } = useBreakpointRuleMutation()
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState(/** @type {string | null} */ (null))
  const [busyId, setBusyId] = useState(/** @type {string | null} */ (null))

  /** @param {import('react').FormEvent} event */
  const addRule = async event => {
    event.preventDefault()
    const url = form.url.trim()
    if (!url) {
      setFormError('A URL pattern is required')
      return
    }
    try {
      await mutateRule({ action: 'add', url, name: form.name.trim(), phase: form.phase })
      setForm(EMPTY_FORM)
      setFormError(null)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleRule = useCallback(
    /** @param {BreakpointRule} rule */
    async rule => {
      try {
        setBusyId(rule.id)
        await mutateRule({ action: 'update', id: rule.id, enabled: !rule.enabled })
      } catch (error) {
        console.error('Error updating breakpoint rule:', error)
      } finally {
        setBusyId(null)
      }
    },
    [mutateRule]
  )

  const removeRule = useCallback(
    /** @param {BreakpointRule} rule */
    async rule => {
      if (showConfirm) {
        const confirmed = await showConfirm(
          'Remove breakpoint',
          `Requests matching ${rule.url} will no longer be paused.`
        )
        if (!confirmed) return
      }
      try {
        setBusyId(rule.id)
        await mutateRule({ action: 'remove', id: rule.id })
      } catch (error) {
        console.error('Error removing breakpoint rule:', error)
      } finally {
        setBusyId(null)
      }
    },
    [mutateRule, showConfirm]
  )

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-lg p-4 border border-edge">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <Tooltip
              title="Breakpoints"
              description={
                enabled
                  ? 'Breakpoint rules are active: matching requests wait for you.'
                  : 'Breakpoint rules are off: nothing is paused.'
              }
              placement="bottom-start"
            >
              <button
                type="button"
                onClick={() => setBreakpointsMode.mutate(!enabled)}
                className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border transition-colors ${
                  enabled
                    ? 'bg-amber-600/20 border-amber-500/40 text-amber-200'
                    : 'bg-accent-neutral/40 border-fg-dim/50 text-fg-muted'
                }`}
                aria-pressed={!!enabled}
              >
                <Pause className="w-4 h-4" />
                <span className="text-xs font-medium tracking-wide">{enabled ? 'ON' : 'OFF'}</span>
              </button>
            </Tooltip>
            <div>
              <h3 className="text-base font-semibold text-fg">Breakpoints</h3>
              <p className="text-xs text-fg-muted">
                {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
                {pending.length > 0 && ` · ${pending.length} paused`}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm text-fg-base">
            <p className="font-medium text-amber-300 mb-1">How breakpoints work</p>
            <p>
              A request whose URL contains one of the patterns below is held before it is forwarded
              (request phase) or before its response goes back to the client (response phase). An
              editor opens with the method, URL, headers and body, or the status, headers and body
              of the response: send it on as it is, send it with your edits, or abort it. A flow
              nobody resumes continues unchanged after the timeout, and nothing is paused while this
              page is closed.
            </p>
          </div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="bg-surface-raised rounded-lg p-4 border border-amber-500/50 space-y-2">
          <h4 className="text-sm font-semibold text-amber-200">Paused now</h4>
          {pending.map(item => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 bg-surface rounded-lg border border-edge px-3 py-2"
            >
              <div className="min-w-0 text-xs">
                <span className="uppercase tracking-wide text-amber-300 mr-2">{item.phase}</span>
                <span className="font-medium text-fg-strong mr-2">{item.method}</span>
                <span className="font-mono text-fg-body break-all">{item.url}</span>
              </div>
              <button
                type="button"
                onClick={() => onOpenPending(item)}
                className="shrink-0 px-3 h-8 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-500 transition-colors"
              >
                Open
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={addRule}
        className="bg-surface-raised rounded-lg p-4 border border-edge space-y-3"
        aria-label="Add a breakpoint"
      >
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] gap-3 items-end">
          <div>
            <label htmlFor="breakpoint-url" className={LABEL_CLASS}>
              URL pattern
            </label>
            <input
              id="breakpoint-url"
              name="url"
              type="text"
              value={form.url}
              onChange={event => setForm(current => ({ ...current, url: event.target.value }))}
              className={`${INPUT_CLASS} font-mono`}
              placeholder="api.example.com/orders"
              spellCheck={false}
            />
          </div>
          <div>
            <label htmlFor="breakpoint-name" className={LABEL_CLASS}>
              Name
            </label>
            <input
              id="breakpoint-name"
              name="name"
              type="text"
              value={form.name}
              onChange={event => setForm(current => ({ ...current, name: event.target.value }))}
              className={INPUT_CLASS}
              placeholder="Optional"
            />
          </div>
          <div>
            <label htmlFor="breakpoint-phase" className={LABEL_CLASS}>
              Pause
            </label>
            <select
              id="breakpoint-phase"
              name="phase"
              value={form.phase}
              onChange={event => setForm(current => ({ ...current, phase: event.target.value }))}
              className={INPUT_CLASS}
            >
              {PHASE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-500 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add breakpoint
          </button>
        </div>
        {formError && <p className="text-xs text-red-300">{formError}</p>}
      </form>

      {rulesQuery.isLoading && rules.length === 0 ? (
        <div className="bg-surface-raised rounded-lg p-12 border border-edge flex flex-col items-center justify-center text-center">
          <Spinner size="md" />
          <p className="mt-3 text-sm text-fg-muted">Loading breakpoints...</p>
        </div>
      ) : rules.length === 0 ? (
        <div className="bg-surface-raised rounded-lg p-8 border border-edge text-center">
          <Pause className="w-12 h-12 text-fg-dim mx-auto mb-3" />
          <p className="text-fg-muted">No breakpoints yet</p>
        </div>
      ) : (
        <div className="bg-surface-raised rounded-lg p-4 border border-edge space-y-3">
          {rules.map(rule => (
            <div
              key={rule.id}
              className="bg-surface rounded-lg border border-edge p-4 hover:border-amber-500/60 transition-colors"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-fg-faint mb-1">
                    {rule.name && rule.name !== rule.url ? `${rule.name} · ` : ''}
                    {phaseLabel(rule.phase)}
                  </p>
                  <p className="text-sm text-fg-base font-mono break-all">{rule.url}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Tooltip title={rule.enabled ? 'Disable' : 'Enable'}>
                    <button
                      type="button"
                      onClick={() => toggleRule(rule)}
                      disabled={busyId === rule.id}
                      aria-label={rule.enabled ? 'Disable' : 'Enable'}
                      aria-pressed={rule.enabled}
                      className={`flex items-center px-3 py-2 rounded-lg border transition-colors ${
                        rule.enabled
                          ? 'bg-amber-500/20 border-amber-500/60 text-amber-200 hover:bg-amber-500/30'
                          : 'bg-accent-neutral/20 border-fg-dim/50 text-fg-muted hover:bg-accent-neutral/30'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {busyId === rule.id ? <Spinner size="sm" /> : <Power className="w-4 h-4" />}
                    </button>
                  </Tooltip>
                  <Tooltip title="Remove">
                    <button
                      type="button"
                      onClick={() => removeRule(rule)}
                      disabled={busyId === rule.id}
                      aria-label="Remove"
                      className="flex items-center px-3 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
