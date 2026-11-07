import { Edit3 } from 'lucide-react'
import Spinner from '../../components/Spinner'
import { useEditRuleUsage } from '../../lib/queries'
import RuleCard from './RuleCard'
import { findMatchingPresetId, groupPresetsForRule } from './presets'

/** @typedef {import('../../lib/types').EditRule} EditRule */
/** @typedef {import('../../lib/types').EditRulePreset} EditRulePreset */

/**
 * The rules, one card each, with the loading and empty states. Reads the
 * usage counts (`GET /api/edit-rules/usage`) and scopes the presets to each
 * rule; the preset shown as selected is the one last applied from the card,
 * else the first applicable one whose definition the rule matches.
 *
 * @param {object} props
 * @param {EditRule[]} props.rules
 * @param {boolean} props.loading
 * @param {boolean} props.isCreating
 * @param {string | null} props.editingRuleId
 * @param {EditRulePreset[]} props.presets
 * @param {boolean} props.presetsLoading
 * @param {Record<string, string>} props.rulePresetSelections Preset id applied from the card, by rule id.
 * @param {string | null} props.updatingPresetRuleId
 * @param {string | null} props.togglingId
 * @param {string | null} props.deletingId
 * @param {(rule: EditRule, presetId: string) => void} props.onApplyPreset
 * @param {(presetId: string) => void} props.onDeletePreset
 * @param {(rule: EditRule) => void} props.onToggle
 * @param {(rule: EditRule) => void} props.onEdit
 * @param {(ruleId: string) => void} props.onDelete
 */
function RuleList({
  rules,
  loading,
  isCreating,
  editingRuleId,
  presets,
  presetsLoading,
  rulePresetSelections,
  updatingPresetRuleId,
  togglingId,
  deletingId,
  onApplyPreset,
  onDeletePreset,
  onToggle,
  onEdit,
  onDelete
}) {
  const usageQuery = useEditRuleUsage()
  const usage = usageQuery.data ? usageQuery.data.usage : null

  if (loading && rules.length === 0) {
    return (
      <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] flex flex-col items-center justify-center text-center">
        <Spinner size="md" />
        <p className="mt-3 text-sm text-slate-400">Loading edit rules...</p>
      </div>
    )
  }

  if (rules.length === 0 && !isCreating) {
    return (
      <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] text-center">
        <Edit3 className="w-16 h-16 text-slate-600 mx-auto mb-4" />
        <h3 className="text-xl font-semibold text-white mb-2">No editing rules</h3>
        <p className="text-slate-400 mb-6">
          Create rules to modify intercepted requests and responses in real-time
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {rules.map(rule => (
        <RuleCard
          key={rule.id}
          rule={rule}
          usageCount={usage ? usage[rule.id] || 0 : undefined}
          editing={editingRuleId === rule.id}
          presetGroups={groupPresetsForRule(presets, rule)}
          presetValue={rulePresetSelections[rule.id] || findMatchingPresetId(presets, rule)}
          presetsLoading={presetsLoading}
          applyingPreset={updatingPresetRuleId === rule.id}
          toggling={togglingId === rule.id}
          deleting={deletingId === rule.id}
          deleteDisabled={isCreating}
          onApplyPreset={presetId => onApplyPreset(rule, presetId)}
          onDeletePreset={onDeletePreset}
          onToggle={() => onToggle(rule)}
          onEdit={() => onEdit(rule)}
          onDelete={() => onDelete(rule.id)}
        />
      ))}
    </div>
  )
}

export default RuleList
