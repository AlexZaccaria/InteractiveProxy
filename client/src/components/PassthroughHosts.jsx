import { useCallback, useState } from 'react'
import { Lock, Plus, Power, Trash2 } from 'lucide-react'
import Spinner from './Spinner'
import Tooltip from './Tooltip'
import { INPUT_CLASS, LABEL_CLASS } from '../lib/httpForm'
import { usePassthroughRuleMutation, usePassthroughRules } from '../lib/queries'

/** @typedef {import('../lib/types').PassthroughRule} PassthroughRule */

const EMPTY_FORM = { host: '', name: '' }

/**
 * The TLS passthrough hosts of the Redirected tab: the CONNECT tunnels to
 * these hosts (and their subdomains) are relayed as raw bytes, without the
 * proxy's certificate, for clients that pin their certificates.
 *
 * @param {Object} props
 * @param {(title: string, message: string) => Promise<boolean>} [props.showConfirm]
 */
export default function PassthroughHosts({ showConfirm }) {
  const rulesQuery = usePassthroughRules()
  const rules = rulesQuery.data || []
  const { mutateAsync: mutateRule } = usePassthroughRuleMutation()
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState(/** @type {string | null} */ (null))
  const [busyId, setBusyId] = useState(/** @type {string | null} */ (null))

  /** @param {import('react').FormEvent} event */
  const addRule = async event => {
    event.preventDefault()
    const host = form.host.trim()
    if (!host) {
      setFormError('A host name is required')
      return
    }
    try {
      await mutateRule({ action: 'add', host, name: form.name.trim() })
      setForm(EMPTY_FORM)
      setFormError(null)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleRule = useCallback(
    /** @param {PassthroughRule} rule */
    async rule => {
      try {
        setBusyId(rule.id)
        await mutateRule({ action: 'update', id: rule.id, enabled: !rule.enabled })
      } catch (error) {
        console.error('Error updating passthrough rule:', error)
      } finally {
        setBusyId(null)
      }
    },
    [mutateRule]
  )

  const removeRule = useCallback(
    /** @param {PassthroughRule} rule */
    async rule => {
      if (showConfirm) {
        const confirmed = await showConfirm(
          'Remove passthrough host',
          `HTTPS traffic to ${rule.host} will be intercepted again.`
        )
        if (!confirmed) return
      }
      try {
        setBusyId(rule.id)
        await mutateRule({ action: 'remove', id: rule.id })
      } catch (error) {
        console.error('Error removing passthrough rule:', error)
      } finally {
        setBusyId(null)
      }
    },
    [mutateRule, showConfirm]
  )

  return (
    <div className="bg-surface-raised rounded-lg p-4 border border-edge space-y-4">
      <div className="flex items-center space-x-3">
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-200">
          <Lock className="w-4 h-4" />
        </span>
        <div>
          <h3 className="text-base font-semibold text-fg">TLS passthrough hosts</h3>
          <p className="text-xs text-fg-muted">
            {rules.length} {rules.length === 1 ? 'host' : 'hosts'}: their HTTPS tunnels are relayed
            as they are, without the proxy's certificate, so apps that pin their certificates keep
            working (nothing of that traffic is logged or rewritten)
          </p>
        </div>
      </div>

      <form onSubmit={addRule} className="space-y-2" aria-label="Add a passthrough host">
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] gap-3 items-end">
          <div>
            <label htmlFor="passthrough-host" className={LABEL_CLASS}>
              Host (subdomains included)
            </label>
            <input
              id="passthrough-host"
              name="host"
              type="text"
              value={form.host}
              onChange={event => setForm(current => ({ ...current, host: event.target.value }))}
              className={`${INPUT_CLASS} font-mono`}
              placeholder="bank.example"
              spellCheck={false}
            />
          </div>
          <div>
            <label htmlFor="passthrough-name" className={LABEL_CLASS}>
              Name
            </label>
            <input
              id="passthrough-name"
              name="name"
              type="text"
              value={form.name}
              onChange={event => setForm(current => ({ ...current, name: event.target.value }))}
              className={INPUT_CLASS}
              placeholder="Optional"
            />
          </div>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add host
          </button>
        </div>
        {formError && <p className="text-xs text-red-300">{formError}</p>}
      </form>

      {rulesQuery.isLoading && rules.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner size="sm" />
          <span>Loading passthrough hosts...</span>
        </div>
      ) : rules.length === 0 ? (
        <p className="text-xs text-fg-muted">No passthrough hosts yet</p>
      ) : (
        <div className="space-y-2">
          {rules.map(rule => (
            <div
              key={rule.id}
              className="bg-surface rounded-lg border border-edge px-4 py-3 hover:border-blue-500/60 transition-colors"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {rule.name && rule.name !== rule.host && (
                    <p className="text-xs text-fg-faint mb-1">{rule.name}</p>
                  )}
                  <p className="text-sm text-fg-base font-mono break-all">{rule.host}</p>
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
                          ? 'bg-blue-500/20 border-blue-500/60 text-blue-200 hover:bg-blue-500/30'
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
