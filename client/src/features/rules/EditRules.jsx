import { useState } from 'react'
import { Download, Edit3, Plus, Upload } from 'lucide-react'
import {
  useEditRuleMutations,
  useEditRulePresets,
  useEditRules,
  usePresetMutations,
  useSetFlag
} from '../../lib/queries'
import { useProxyStore } from '../../store/useProxyStore'
import HowItWorks from './HowItWorks'
import RuleForm from './RuleForm'
import RuleList from './RuleList'
import { doesPresetMatchRuleCriteria } from './presets'
import { describeImport, downloadRulesExport, importRulesFile } from './rulesTransfer'
import { buildPresetRule, buildRulePayload, useRuleForm, validateRuleForm } from './useRuleForm'
import Tooltip from '../../components/Tooltip'

/** @typedef {import('../../lib/types').EditRule} EditRule */

/** Shared empty list so that `rules` / `presets` keep one identity before the data arrives. */
const EMPTY_LIST = []

/**
 * The Edit Rules tab: the global switch, the explanatory box, the
 * create/edit form and the list of rules.
 *
 * The rules and the presets come from the `edit-rules` and `edit-rule-presets`
 * queries; the global toggle is the `editRulesEnabled` flag of the store, and
 * the form state (including the JSONPath seed handed over by the log view)
 * lives in `useRuleForm`.
 *
 * @param {Object} props
 * @param {(title: string, message: string, kind?: string) => Promise<boolean>} [props.showConfirm] Async confirm dialog helper.
 * @param {(title: string, message: string, defaultValue?: string, placeholder?: string, examples?: string[]) => Promise<string|boolean>} [props.showPrompt]
 *        Prompt helper used to name edit-rule presets.
 * @param {(title: string, message: string, kind: string) => void} [props.showAlert] Alert helper for warning/error messages.
 */
function EditRules({ showConfirm, showPrompt, showAlert }) {
  const editRulesEnabled = useProxyStore(state => state.editRulesEnabled)
  const setEditRulesMode = useSetFlag('edit-rules-mode')
  const rulesQuery = useEditRules()
  const presetsQuery = useEditRulePresets()
  const ruleMutations = useEditRuleMutations()
  const presetMutations = usePresetMutations()
  const { mutateAsync: createRule } = ruleMutations.create
  const { mutateAsync: updateRule } = ruleMutations.update
  const { mutateAsync: deleteRule } = ruleMutations.remove
  const { mutateAsync: createPreset } = presetMutations.create
  const { mutateAsync: deletePreset } = presetMutations.remove
  const rules = rulesQuery.data || EMPTY_LIST
  const loading = rulesQuery.isLoading
  const presets = presetsQuery.data || EMPTY_LIST
  const presetsLoading = presetsQuery.isLoading

  const form = useRuleForm({ presets })
  const { formData, isCreating, editingRuleId } = form

  const [deletingId, setDeletingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [togglingId, setTogglingId] = useState(null)
  const [rulePresetSelections, setRulePresetSelections] = useState({})
  const [updatingPresetRuleId, setUpdatingPresetRuleId] = useState(null)

  /**
   * Apply a preset directly to an existing rule from the recap list.
   *
   * @param {EditRule} rule
   * @param {string} presetId
   */
  const handleQuickPresetChange = async (rule, presetId) => {
    if (!rule || !presetId) return
    const preset = presets.find(item => item && String(item.id) === String(presetId))
    if (!preset || !doesPresetMatchRuleCriteria(preset, rule)) return

    const presetRule = preset.rule && typeof preset.rule === 'object' ? preset.rule : {}
    const patch =
      rule.kind === 'jsonPath'
        ? {
            ...rule,
            value: Object.prototype.hasOwnProperty.call(presetRule, 'value')
              ? presetRule.value
              : '',
            valueType: presetRule.valueType || rule.valueType,
            valueSource: presetRule.valueSource || null
          }
        : { ...rule, replacement: presetRule.replacement || '' }

    try {
      setUpdatingPresetRuleId(rule.id)
      await updateRule({ id: rule.id, patch })
      setRulePresetSelections(prev => ({ ...prev, [rule.id]: String(presetId) }))
    } catch (error) {
      console.error('Error applying preset to rule:', error)
      const message = error?.message || 'Unknown error'
      if (showAlert) {
        showAlert('Failed to apply preset', String(message), 'error')
      } else {
        alert('Failed to apply preset: ' + message)
      }
    } finally {
      setUpdatingPresetRuleId(null)
    }
  }

  /** @param {EditRule} rule */
  const handleToggleEnabled = async rule => {
    if (!rule) return
    try {
      setTogglingId(rule.id)
      await updateRule({ id: rule.id, patch: { ...rule, enabled: !rule.enabled } })
    } catch (error) {
      console.error('Error toggling rule:', error)
      if (showAlert) {
        showAlert(
          'Failed to toggle rule',
          'An error occurred while toggling this edit rule. Please try again.',
          'error'
        )
      } else {
        alert('Failed to toggle rule')
      }
    } finally {
      setTogglingId(null)
    }
  }

  /** @param {string} ruleId */
  const handleDelete = async ruleId => {
    let confirmed = true

    if (showConfirm) {
      try {
        confirmed = await showConfirm(
          'Delete edit rule',
          'Are you sure you want to delete this rule? This action cannot be undone.'
        )
      } catch (error) {
        console.error('Error showing confirmation modal:', error)
        confirmed = false
      }
    }

    if (!confirmed) return

    try {
      setDeletingId(ruleId)
      await deleteRule(ruleId)
    } catch (error) {
      console.error('Error deleting rule:', error)
    } finally {
      setDeletingId(null)
    }
  }

  /** Persist the form, creating or updating a rule, then close it. */
  const handleExportRules = async () => {
    try {
      await downloadRulesExport()
    } catch (error) {
      showAlert('Export rules', error instanceof Error ? error.message : String(error), 'error')
    }
  }

  /** @param {import('react').ChangeEvent<HTMLInputElement>} event */
  const handleImportRules = async event => {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (!file) return
    try {
      const result = await importRulesFile(file)
      showAlert('Import rules', describeImport(result))
    } catch (error) {
      showAlert('Import rules', error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const handleSave = async () => {
    const validationError = validateRuleForm(formData)
    if (validationError) {
      if (showAlert) {
        showAlert(validationError.title, validationError.message, 'warning')
      } else {
        alert(validationError.fallback)
      }
      return
    }

    const payload = buildRulePayload(formData)

    try {
      setSaving(true)
      if (isCreating) {
        await createRule(payload)
      } else if (editingRuleId) {
        await updateRule({ id: editingRuleId, patch: payload })
      }

      form.cancel()
    } catch (error) {
      console.error('Error saving rule:', error)
      const message = error?.message || 'Unknown error'
      if (showAlert) {
        showAlert('Failed to save rule', String(message), 'error')
      } else {
        alert('Failed to save rule: ' + message)
      }
    } finally {
      setSaving(false)
    }
  }

  /** Save the form as a reusable preset, then save the rule itself. */
  const handleSavePreset = async () => {
    const defaultName =
      formData.name || (formData.kind === 'jsonPath' ? 'JSONPath preset' : 'Text preset')
    const promptResult = showPrompt
      ? await showPrompt(
          'Save preset',
          'Choose a name for this preset.',
          defaultName,
          'Preset name'
        )
      : window.prompt('Preset name', defaultName)

    if (!promptResult || typeof promptResult !== 'string' || !promptResult.trim()) {
      return
    }

    const payload = {
      name: promptResult.trim(),
      kind: formData.kind === 'jsonPath' ? 'jsonPath' : 'text',
      rule: buildPresetRule(formData)
    }

    try {
      const response = await createPreset(payload)
      const created = response?.preset
      if (created?.id) {
        form.setSelectedPresetId(String(created.id))
      }
      await handleSave()
    } catch (error) {
      console.error('Error saving edit rule preset:', error)
      const message = error?.message || 'Unknown error'
      if (showAlert) {
        showAlert('Failed to save preset', String(message), 'error')
      } else {
        alert('Failed to save preset: ' + message)
      }
    }
  }

  /** @param {string} presetId */
  const handleDeletePreset = async presetId => {
    const targetId = String(presetId || '')
    if (!targetId) return

    const confirmed = showConfirm
      ? await showConfirm(
          'Delete preset',
          'Are you sure you want to delete this preset? This cannot be undone.'
        )
      : window.confirm('Delete this preset?')

    if (!confirmed) return

    try {
      await deletePreset(targetId)
      form.setSelectedPresetId(prev => (String(prev) === targetId ? '' : prev))
      setRulePresetSelections(prev => {
        const next = { ...prev }
        Object.keys(next).forEach(key => {
          if (String(next[key]) === targetId) {
            delete next[key]
          }
        })
        return next
      })
    } catch (error) {
      console.error('Error deleting preset:', error)
      const message = error?.message || 'Unknown error'
      if (showAlert) {
        showAlert('Failed to delete preset', String(message), 'error')
      } else {
        alert('Failed to delete preset: ' + message)
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-surface-raised rounded-lg p-4 border border-edge">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <Tooltip
              title="Live edit rules"
              description={
                editRulesEnabled
                  ? 'Live edit rules are active and may modify matching traffic.'
                  : 'Live edit rules are disabled. All rules are ignored without changing their individual switches.'
              }
              placement="bottom-start"
            >
              <button
                type="button"
                onClick={() => setEditRulesMode.mutate(!editRulesEnabled)}
                className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border transition-colors ${
                  editRulesEnabled
                    ? 'bg-cyan-600/20 border-cyan-600/30 text-cyan-300'
                    : 'bg-accent-neutral/40 border-fg-dim/50 text-fg-muted'
                }`}
                aria-pressed={!!editRulesEnabled}
              >
                <Edit3 className="w-4 h-4" />
                <span className="text-xs font-medium tracking-wide">
                  {editRulesEnabled ? 'ON' : 'OFF'}
                </span>
              </button>
            </Tooltip>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-fg">Live Editing Rules</h3>
              </div>
              <p className="text-xs text-fg-muted">
                {rules.length} {rules.length === 1 ? 'rule' : 'rules'} configured
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip
              title="Export rules"
              description="Download every rule kind (edit rules and presets, blocked, filter and breakpoint rules) as one JSON file."
            >
              <button
                type="button"
                onClick={handleExportRules}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-edge text-fg-body hover:bg-surface-highlight transition-colors text-xs"
              >
                <Download className="w-4 h-4" />
                <span>Export rules</span>
              </button>
            </Tooltip>
            <Tooltip
              title="Import rules"
              description="Add the rules of a file exported here; a rule with the id of an existing one replaces it."
            >
              <label className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-edge text-fg-body hover:bg-surface-highlight cursor-pointer transition-colors text-xs">
                <Upload className="w-4 h-4" />
                <span>Import rules</span>
                <input
                  type="file"
                  name="import-rules"
                  accept=".json,application/json"
                  className="hidden"
                  aria-label="Import rules file"
                  onChange={handleImportRules}
                />
              </label>
            </Tooltip>
            <button
              onClick={form.startCreate}
              disabled={form.isOpen}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg bg-cyan-600/20 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-600/30 hover:text-fg disabled:bg-surface-highlight disabled:text-fg-faint disabled:border-fg-dim/50 transition-colors text-xs font-medium"
            >
              <Plus className="w-4 h-4" />
              <span>Add Rule</span>
            </button>
          </div>
        </div>
      </div>

      <HowItWorks />

      {form.isOpen && (
        <RuleForm
          formData={formData}
          onChange={form.updateForm}
          isCreating={isCreating}
          editingRuleId={editingRuleId}
          presetGroups={form.groupedPresets}
          presetsLoading={presetsLoading}
          selectedPresetId={form.selectedPresetId}
          onSelectPreset={form.selectPreset}
          onDeletePreset={handleDeletePreset}
          saving={saving}
          onSave={handleSave}
          onSavePreset={handleSavePreset}
          onCancel={form.cancel}
          showAlert={showAlert}
        />
      )}

      <RuleList
        rules={rules}
        loading={loading}
        isCreating={isCreating}
        editingRuleId={editingRuleId}
        presets={presets}
        presetsLoading={presetsLoading}
        rulePresetSelections={rulePresetSelections}
        updatingPresetRuleId={updatingPresetRuleId}
        togglingId={togglingId}
        deletingId={deletingId}
        onApplyPreset={handleQuickPresetChange}
        onDeletePreset={handleDeletePreset}
        onToggle={handleToggleEnabled}
        onEdit={form.startEdit}
        onDelete={handleDelete}
      />
    </div>
  )
}

export default EditRules
