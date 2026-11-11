import { useCallback, useState } from 'react'
import { Gauge, Plus, Power, Trash2 } from 'lucide-react'
import Spinner from '../../components/Spinner'
import Tooltip from '../../components/Tooltip'
import { INPUT_CLASS, LABEL_CLASS } from '../../lib/httpForm'
import { useSetFlag, useThrottleRuleMutation, useThrottleRules } from '../../lib/queries'
import { useProxyStore } from '../../store/useProxyStore'

/** @typedef {import('../../lib/types').ThrottleRule} ThrottleRule */

const EMPTY_FORM = { url: '', name: '', delayMs: '', throttleKbps: '' }

/**
 * The conditions of a rule in one short phrase.
 *
 * @param {{ delayMs: number, throttleKbps: number }} rule
 * @returns {string}
 */
export function describeConditions(rule) {
  const parts = []
  if (rule.delayMs > 0) parts.push(`+${rule.delayMs} ms`)
  if (rule.throttleKbps > 0) parts.push(`${rule.throttleKbps} kbps`)
  return parts.join(' · ')
}

/**
 * The network-condition rules of the Edited tab: the global switch, the
 * form that adds a rule (URL pattern, latency, bandwidth cap) and the list.
 *
 * @param {Object} props
 * @param {(title: string, message: string) => Promise<boolean>} [props.showConfirm]
 */
export default function ThrottleRules({ showConfirm }) {
  const enabled = useProxyStore(state => state.throttlingEnabled)
  const setThrottlingMode = useSetFlag('throttling-mode')
  const rulesQuery = useThrottleRules()
  const rules = rulesQuery.data || []
  const { mutateAsync: mutateRule } = useThrottleRuleMutation()
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState(/** @type {string | null} */ (null))
  const [busyId, setBusyId] = useState(/** @type {string | null} */ (null))

  /**
   * @param {keyof typeof EMPTY_FORM} key
   * @param {string} value
   */
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }))

  /** @param {import('react').FormEvent} event */
  const addRule = async event => {
    event.preventDefault()
    const url = form.url.trim()
    if (!url) {
      setFormError('A URL pattern is required')
      return
    }
    const delayMs = form.delayMs.trim() === '' ? 0 : Number(form.delayMs)
    const throttleKbps = form.throttleKbps.trim() === '' ? 0 : Number(form.throttleKbps)
    if (
      !Number.isFinite(delayMs) ||
      delayMs < 0 ||
      !Number.isFinite(throttleKbps) ||
      throttleKbps < 0
    ) {
      setFormError('Latency and bandwidth must be numbers of zero or more')
      return
    }
    if (delayMs <= 0 && throttleKbps <= 0) {
      setFormError('A latency or a bandwidth cap is required')
      return
    }
    try {
      await mutateRule({ action: 'add', url, name: form.name.trim(), delayMs, throttleKbps })
      setForm(EMPTY_FORM)
      setFormError(null)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleRule = useCallback(
    /** @param {ThrottleRule} rule */
    async rule => {
      try {
        setBusyId(rule.id)
        await mutateRule({ action: 'update', id: rule.id, enabled: !rule.enabled })
      } catch (error) {
        console.error('Error updating network-condition rule:', error)
      } finally {
        setBusyId(null)
      }
    },
    [mutateRule]
  )

  const removeRule = useCallback(
    /** @param {ThrottleRule} rule */
    async rule => {
      if (showConfirm) {
        const confirmed = await showConfirm(
          'Remove network conditions',
          `Requests matching ${rule.url} will no longer be slowed down.`
        )
        if (!confirmed) return
      }
      try {
        setBusyId(rule.id)
        await mutateRule({ action: 'remove', id: rule.id })
      } catch (error) {
        console.error('Error removing network-condition rule:', error)
      } finally {
        setBusyId(null)
      }
    },
    [mutateRule, showConfirm]
  )

  return (
    <div className="bg-surface-raised rounded-lg p-4 border border-edge space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <Tooltip
            title="Network conditions"
            description={
              enabled
                ? 'Latency and bandwidth rules are active on matching requests.'
                : 'Latency and bandwidth rules are off.'
            }
            placement="bottom-start"
          >
            <button
              type="button"
              onClick={() => setThrottlingMode.mutate(!enabled)}
              className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border transition-colors ${
                enabled
                  ? 'bg-pink-600/20 border-pink-500/40 text-pink-200'
                  : 'bg-accent-neutral/40 border-fg-dim/50 text-fg-muted'
              }`}
              aria-pressed={!!enabled}
            >
              <Gauge className="w-4 h-4" />
              <span className="text-xs font-medium tracking-wide">{enabled ? 'ON' : 'OFF'}</span>
            </button>
          </Tooltip>
          <div>
            <h3 className="text-base font-semibold text-fg">Latency and throttling</h3>
            <p className="text-xs text-fg-muted">
              {rules.length} {rules.length === 1 ? 'rule' : 'rules'}: a delay before the request is
              forwarded, a bandwidth cap on the response
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={addRule} className="space-y-2" aria-label="Add network conditions">
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_7rem_7rem_auto] gap-3 items-end">
          <div>
            <label htmlFor="throttle-url" className={LABEL_CLASS}>
              URL pattern
            </label>
            <input
              id="throttle-url"
              name="url"
              type="text"
              value={form.url}
              onChange={event => update('url', event.target.value)}
              className={`${INPUT_CLASS} font-mono`}
              placeholder="api.example.com/search"
              spellCheck={false}
            />
          </div>
          <div>
            <label htmlFor="throttle-name" className={LABEL_CLASS}>
              Name
            </label>
            <input
              id="throttle-name"
              name="name"
              type="text"
              value={form.name}
              onChange={event => update('name', event.target.value)}
              className={INPUT_CLASS}
              placeholder="Optional"
            />
          </div>
          <div>
            <label htmlFor="throttle-delay" className={LABEL_CLASS}>
              Latency (ms)
            </label>
            <input
              id="throttle-delay"
              name="delayMs"
              type="number"
              min={0}
              step={50}
              value={form.delayMs}
              onChange={event => update('delayMs', event.target.value)}
              className={INPUT_CLASS}
              placeholder="0"
            />
          </div>
          <div>
            <label htmlFor="throttle-kbps" className={LABEL_CLASS}>
              Bandwidth (kbps)
            </label>
            <input
              id="throttle-kbps"
              name="throttleKbps"
              type="number"
              min={0}
              step={8}
              value={form.throttleKbps}
              onChange={event => update('throttleKbps', event.target.value)}
              className={INPUT_CLASS}
              placeholder="unlimited"
            />
          </div>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium bg-pink-600 text-white hover:bg-pink-500 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add conditions
          </button>
        </div>
        {formError && <p className="text-xs text-red-300">{formError}</p>}
      </form>

      {rulesQuery.isLoading && rules.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner size="sm" />
          <span>Loading network conditions...</span>
        </div>
      ) : rules.length === 0 ? (
        <p className="text-xs text-fg-muted">No network conditions yet</p>
      ) : (
        <div className="space-y-2">
          {rules.map(rule => (
            <div
              key={rule.id}
              className="bg-surface rounded-lg border border-edge px-4 py-3 hover:border-pink-500/60 transition-colors"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-fg-faint mb-1">
                    {rule.name && rule.name !== rule.url ? `${rule.name} · ` : ''}
                    {describeConditions(rule)}
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
                          ? 'bg-pink-500/20 border-pink-500/60 text-pink-200 hover:bg-pink-500/30'
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
