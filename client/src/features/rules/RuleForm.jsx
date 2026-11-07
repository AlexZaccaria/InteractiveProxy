import { useEffect, useRef } from 'react'
import { Code, Power, Save, Type, X } from 'lucide-react'
import Spinner from '../../components/Spinner'
import JsonPathEditor from './JsonPathEditor'
import PresetDropdown from './PresetDropdown'
import TextRuleFields from './TextRuleFields'
import Tooltip from '../../components/Tooltip'

/** @typedef {import('./useRuleForm').RuleFormData} RuleFormData */
/** @typedef {import('../../lib/types').EditRulePreset} EditRulePreset */

/** Height of the sticky header the form scrolls under. */
const HEADER_OFFSET = 96

/**
 * The create/edit card: the preset picker and the toggles in the header, the
 * name, the fields of the rule's kind and the save/cancel row. Scrolls
 * itself into view when it opens or switches rule.
 *
 * @param {object} props
 * @param {RuleFormData} props.formData
 * @param {(patch: Partial<RuleFormData>) => void} props.onChange
 * @param {boolean} props.isCreating
 * @param {string | null} props.editingRuleId
 * @param {Array<[string, EditRulePreset[]]>} props.presetGroups Presets scoped to the form's target, URL and path.
 * @param {boolean} props.presetsLoading
 * @param {string} props.selectedPresetId
 * @param {(presetId: string) => void} props.onSelectPreset
 * @param {(presetId: string) => void} props.onDeletePreset
 * @param {boolean} props.saving
 * @param {() => void} props.onSave
 * @param {() => void} props.onSavePreset
 * @param {() => void} props.onCancel
 * @param {(title: string, message: string, kind: string) => void} [props.showAlert]
 */
function RuleForm({
  formData,
  onChange,
  isCreating,
  editingRuleId,
  presetGroups,
  presetsLoading,
  selectedPresetId,
  onSelectPreset,
  onDeletePreset,
  saving,
  onSave,
  onSavePreset,
  onCancel,
  showAlert
}) {
  const formRef = useRef(null)

  useEffect(() => {
    if (!formRef.current || typeof window === 'undefined') return
    const rect = formRef.current.getBoundingClientRect()
    const targetY = window.scrollY + rect.top - HEADER_OFFSET - 16

    try {
      window.scrollTo({
        top: Math.max(targetY, 0),
        behavior: 'smooth'
      })
    } catch {
      window.scrollTo(0, Math.max(targetY, 0))
    }
  }, [isCreating, editingRuleId])

  return (
    <div ref={formRef} className="bg-surface-raised rounded-lg p-5 border border-edge">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h4 className="text-sm font-semibold text-fg">
            {isCreating ? 'Create rule' : 'Edit rule'}
          </h4>
          <p className="text-xs text-fg-muted">
            Presets are scoped by Apply To (target), URL pattern, and JSON path (when applicable)
            and apply to all traffic that passes through the proxy pipeline.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs sm:text-sm">
          <div className="flex items-center gap-2">
            <PresetDropdown
              value={selectedPresetId}
              placeholder="Select preset"
              groups={presetGroups}
              loading={presetsLoading}
              disabled={false}
              onSelect={onSelectPreset}
              onDelete={onDeletePreset}
              buttonClassName="min-w-[240px]"
              menuClassName="z-50"
            />
          </div>
          {formData.kind === 'text' && (
            <>
              {/* Regex toggle */}
              <Tooltip
                title="Regex mode"
                description="Use regular expressions to match patterns across headers, bodies, and frames."
              >
                <button
                  type="button"
                  onClick={() => onChange({ useRegex: !formData.useRegex })}
                  className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
                    formData.useRegex
                      ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                      : 'border-edge bg-surface text-fg-muted hover:border-blue-500 hover:text-blue-300'
                  }`}
                  aria-pressed={formData.useRegex}
                  aria-label="Toggle regex mode"
                >
                  <Code className="w-4 h-4" />
                </button>
              </Tooltip>

              {/* Case sensitivity toggle */}
              <Tooltip
                title="Case sensitive"
                description="When enabled, matches will respect letter casing. Otherwise, matching is case-insensitive."
              >
                <button
                  type="button"
                  onClick={() => onChange({ caseSensitive: !formData.caseSensitive })}
                  className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
                    formData.caseSensitive
                      ? 'border-blue-500 bg-blue-600/20 text-blue-300'
                      : 'border-edge bg-surface text-fg-muted hover:border-blue-500 hover:text-blue-300'
                  }`}
                  aria-pressed={formData.caseSensitive}
                  aria-label="Toggle case sensitivity"
                >
                  <Type className="w-4 h-4" />
                </button>
              </Tooltip>
            </>
          )}

          {/* Enabled toggle */}
          <Tooltip
            title="Rule enabled"
            description="Toggle whether this rule is active. Disabled rules are ignored but kept for later."
          >
            <button
              type="button"
              onClick={() => onChange({ enabled: !formData.enabled })}
              className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
                formData.enabled
                  ? 'border-emerald-500 bg-emerald-600/20 text-emerald-300'
                  : 'border-edge bg-surface text-fg-muted hover:border-emerald-500 hover:text-emerald-300'
              }`}
              aria-pressed={formData.enabled}
              aria-label="Toggle rule enabled"
            >
              <Power className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label
            htmlFor="rule-name"
            className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2"
          >
            Rule name
          </label>
          <input
            type="text"
            id="rule-name"
            name="rule-name"
            value={formData.name}
            onChange={e => onChange({ name: e.target.value })}
            placeholder="e.g., Replace API Key"
            className="w-full px-3 h-8 bg-surface border border-edge rounded-lg text-xs text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {formData.kind === 'jsonPath' && (
          <JsonPathEditor formData={formData} onChange={onChange} showAlert={showAlert} />
        )}

        {formData.kind === 'text' && <TextRuleFields formData={formData} onChange={onChange} />}

        <div className="flex items-center gap-3 pt-4 border-t border-edge">
          <button
            type="button"
            onClick={onSavePreset}
            className="inline-flex items-center justify-center gap-2 px-4 h-8 rounded-lg bg-blue-600/10 border border-blue-500/30 text-blue-200 hover:bg-blue-600/20 hover:text-fg transition-colors text-xs font-medium"
          >
            <Save className="w-4 h-4" />
            <span>Save as preset</span>
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-300 hover:bg-blue-600/30 hover:text-fg disabled:bg-surface-highlight disabled:text-fg-faint disabled:border-fg-dim/50 transition-colors text-xs font-medium"
          >
            {saving ? (
              <>
                <Spinner size="sm" />
                <span>Saving...</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                <span>Save</span>
              </>
            )}
          </button>
          <button
            onClick={onCancel}
            className="inline-flex items-center justify-center px-4 h-8 rounded-lg bg-surface border border-edge text-xs font-medium text-fg-body hover:bg-surface-raised hover:text-fg transition-colors flex items-center gap-2"
          >
            <X className="w-4 h-4" />
            <span>Cancel</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default RuleForm
