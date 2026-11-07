import { Copy, Info } from 'lucide-react'
import { useFilePicker } from '../../lib/queries'
import { coerceJsonPathScalar } from './presets'
import TargetSelector from './TargetSelector'

/** @typedef {import('./useRuleForm').RuleFormData} RuleFormData */

const INPUT_CLASS =
  'w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-amber-500'

const VALUE_MODES = [
  { key: 'text', label: 'Manual' },
  { key: 'file', label: 'File' }
]

/**
 * The fields of a JSONPath rule: the URL pattern, the target, the path and
 * the value, typed by hand (its type detected while typing) or taken from a
 * file on the proxy's host chosen through the native picker.
 *
 * @param {object} props
 * @param {RuleFormData} props.formData
 * @param {(patch: Partial<RuleFormData>) => void} props.onChange
 * @param {(title: string, message: string, kind: string) => void} [props.showAlert]
 */
function JsonPathEditor({ formData, onChange, showAlert }) {
  const filePicker = useFilePicker()
  const isPickingFile = filePicker.isPending

  /** @param {React.ChangeEvent<HTMLInputElement>} event */
  const handleValueTextChange = event => {
    const rawText = event.target.value
    const { valueType } = coerceJsonPathScalar(rawText)
    onChange({ value: rawText, valueType, jsonValueMode: 'text' })
  }

  const handleFilePick = async () => {
    try {
      const selectedPath = await filePicker.mutateAsync({
        title: 'Select JSONPath value file',
        filter: 'Text files (*.txt)|*.txt|All files (*.*)|*.*'
      })
      if (!selectedPath) return
      const filename = selectedPath.split(/[\\/]/).pop() || selectedPath
      onChange({
        value: '',
        valueType: 'string',
        jsonValueMode: 'file',
        jsonValueFileName: filename,
        jsonValueFileToken: selectedPath
      })
    } catch (error) {
      const message = error?.message || 'Unable to open the file picker.'
      if (showAlert) {
        showAlert('File picker error', String(message), 'error')
      } else {
        alert('Unable to open the file picker: ' + message)
      }
    }
  }

  /** @param {'text' | 'file'} mode */
  const handleModeChange = mode => {
    if (mode === 'file') {
      onChange({ jsonValueMode: 'file' })
    } else {
      onChange({ jsonValueMode: 'text', jsonValueFileName: '', jsonValueFileToken: '' })
    }
  }

  const handleCopyValue = () => {
    if (!formData.value || typeof navigator === 'undefined' || !navigator.clipboard) return
    try {
      navigator.clipboard.writeText(formData.value)
    } catch (error) {
      console.error('Failed to copy value to clipboard:', error)
    }
  }

  return (
    <>
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
          URL pattern
        </label>
        <input
          type="text"
          value={formData.url}
          onChange={e => onChange({ url: e.target.value })}
          placeholder="es: /api/v1/users oppure https://example.com/api"
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-start">
        <div className="sm:w-64">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            Apply to
          </label>
          <TargetSelector
            value={formData.target}
            onChange={target => onChange({ target })}
            stretch
          />
        </div>

        <div className="flex-1">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            JSON path
          </label>
          <input
            type="text"
            value={formData.path}
            onChange={e => onChange({ path: e.target.value })}
            placeholder="es: root.data[0].user.name"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-start">
        <div className="sm:w-64">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            Input Type
          </label>
          <div className="flex w-full gap-2">
            {VALUE_MODES.map(option => {
              const isActive = formData.jsonValueMode === option.key
              const activeClasses =
                option.key === 'file'
                  ? 'bg-green-600/20 border-green-500/60 text-green-400'
                  : 'bg-amber-600/20 border-amber-500/60 text-amber-200'
              const inactiveClasses =
                option.key === 'file'
                  ? 'bg-[#0a0a0a] border-[#2a2a2a] text-slate-300 hover:border-green-500 hover:text-green-400'
                  : 'bg-[#0a0a0a] border-[#2a2a2a] text-slate-300 hover:border-amber-500 hover:text-amber-200'
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => handleModeChange(option.key)}
                  className={`inline-flex flex-1 items-center justify-center px-3 h-8 rounded-md border text-xs font-medium transition-colors ${
                    isActive ? activeClasses : inactiveClasses
                  }`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex-1">
          <div className="flex items-start gap-1.5 mb-2">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Value
            </label>
            <div className="relative group/json-value-help inline-flex items-center">
              <Info className="w-3.5 h-3.5 text-slate-500 cursor-help hover:text-slate-300" />
              <div
                className="invisible group-hover/json-value-help:visible absolute left-0 bottom-full mb-2 w-72 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-[11px] text-slate-300 shadow-2xl"
                style={{ zIndex: 99999 }}
              >
                <div className="font-semibold mb-1 text-slate-200">JSON-aware replacement</div>
                <p>
                  When the target field is an object or array, the proxy will try to parse this
                  value as JSON. If parsing succeeds, the entire object will be replaced with the
                  new one (for example by pasting a stringified JSON object).
                </p>
              </div>
            </div>
            <span className="text-[11px] text-slate-500">
              [Detected type:{' '}
              <span className="text-amber-200 font-semibold">{formData.valueType}</span>]
            </span>
          </div>
          {formData.jsonValueMode === 'file' ? (
            <div className="flex items-center gap-2 min-h-[32px]">
              <button
                type="button"
                onClick={handleFilePick}
                disabled={isPickingFile}
                className="inline-flex items-center justify-center px-3 h-8 rounded-md border border-green-500/60 bg-green-600/20 text-green-400 text-xs font-medium hover:bg-green-600/30 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isPickingFile ? 'Picking...' : 'Choose file'}
              </button>
              <div className="flex-1 min-w-0 px-3 h-8 rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] text-[11px] text-slate-400 flex items-center">
                <span className="truncate">
                  {formData.jsonValueFileToken
                    ? formData.jsonValueFileToken
                    : 'Select a file to use at runtime'}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 min-h-[32px]">
              <input
                type="text"
                value={formData.value}
                onChange={handleValueTextChange}
                placeholder="Insert a value"
                className="flex-1 px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-amber-500"
              />
              <button
                type="button"
                onClick={handleCopyValue}
                disabled={!formData.value}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-[#2a2a2a] bg-[#0a0a0a] text-slate-400 hover:border-amber-500 hover:text-amber-300 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Copy current value"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default JsonPathEditor
