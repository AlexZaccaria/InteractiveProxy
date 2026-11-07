import { memo, useState } from 'react'
import { ChevronDown, Edit3, Power, Trash2 } from 'lucide-react'
import Spinner from '../../components/Spinner'
import PresetDropdown from './PresetDropdown'
import { PREVIEW_MAX_LENGTH, buildMarkerList, getRulePreviewText } from './presets'

/** @typedef {import('../../lib/types').EditRule} EditRule */
/** @typedef {import('../../lib/types').EditRulePreset} EditRulePreset */

/**
 * One rule of the list: the name, the target and status badges, the number
 * of logged entries it modified, the per-rule preset selector, the
 * toggle/edit/delete actions and the markers, path and replacement (long
 * replacements collapsed to 300 characters with an Expand control).
 *
 * @param {object} props
 * @param {EditRule} props.rule
 * @param {number} [props.usageCount] Logged entries this rule modified; hidden until the usage query answers.
 * @param {boolean} props.editing The form is open on this rule.
 * @param {Array<[string, EditRulePreset[]]>} props.presetGroups Presets applicable to the rule, grouped.
 * @param {string} props.presetValue The id of the preset shown as selected, `''` for none.
 * @param {boolean} props.presetsLoading
 * @param {boolean} props.applyingPreset
 * @param {boolean} props.toggling
 * @param {boolean} props.deleting
 * @param {boolean} props.deleteDisabled
 * @param {(presetId: string) => void} props.onApplyPreset
 * @param {(presetId: string) => void} props.onDeletePreset
 * @param {() => void} props.onToggle
 * @param {() => void} props.onEdit
 * @param {() => void} props.onDelete
 */
function RuleCard({
  rule,
  usageCount,
  editing,
  presetGroups,
  presetValue,
  presetsLoading,
  applyingPreset,
  toggling,
  deleting,
  deleteDisabled,
  onApplyPreset,
  onDeletePreset,
  onToggle,
  onEdit,
  onDelete
}) {
  const [expanded, setExpanded] = useState(false)

  const startMarkers = buildMarkerList(rule.startVariants)
  const endMarkers = buildMarkerList(rule.endVariants)
  const fullReplacementText = getRulePreviewText(rule, { truncate: false })
  const isTruncatable = fullReplacementText.length > PREVIEW_MAX_LENGTH
  const replacementText =
    expanded || !isTruncatable ? fullReplacementText : getRulePreviewText(rule)

  return (
    <div
      className={`bg-[#0a0a0a] rounded-lg border p-4 transition-colors ${
        editing ? 'border-cyan-500/70' : 'border-[#2a2a2a] hover:border-cyan-500/60'
      }`}
    >
      <div className="space-y-2">
        {/* Header row: title + badges + actions */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h4 className="text-white font-medium truncate">{rule.name || 'Unnamed Rule'}</h4>
            {(rule.kind === 'jsonPath' || rule.kind === 'text') && (
              <div className="flex items-center gap-1">
                {(!rule.target || rule.target === 'request') && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-blue-500/20 border border-blue-500/40 text-blue-300">
                    Request
                  </span>
                )}
                {rule.target === 'response' && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-green-500/20 border border-green-500/40 text-green-300">
                    Response
                  </span>
                )}
                {rule.target === 'both' && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-yellow-500/20 border border-yellow-500/40 text-yellow-300">
                    Both
                  </span>
                )}
              </div>
            )}
            {typeof usageCount === 'number' && (
              <span
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-slate-500/10 border border-slate-500/30 text-slate-400 whitespace-nowrap"
                title="Logged entries this rule modified"
              >
                {usageCount} {usageCount === 1 ? 'hit' : 'hits'}
              </span>
            )}
            {!rule.enabled && (
              <span className="px-2 py-1 rounded text-xs font-medium border bg-slate-500/20 text-slate-400 border-slate-500/30 whitespace-nowrap">
                Disabled
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PresetDropdown
              value={presetValue}
              placeholder="Apply preset"
              groups={presetGroups}
              loading={presetsLoading}
              disabled={presetsLoading || applyingPreset || presetGroups.length === 0}
              onSelect={onApplyPreset}
              onDelete={onDeletePreset}
              buttonClassName="min-w-[180px] h-8 px-2.5 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] text-[11px] text-slate-100 inline-flex items-center justify-between gap-2 hover:border-blue-500/60 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              menuClassName="absolute right-0 mt-2 w-56 bg-[#101010] border border-[#2a2a2a] rounded-lg shadow-2xl z-50"
            />
            <button
              onClick={onToggle}
              disabled={toggling}
              className={`inline-flex items-center justify-center gap-2 px-3 h-8 rounded-lg transition-colors text-xs font-medium ${
                rule.enabled
                  ? 'bg-cyan-600/20 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-600/30'
                  : 'bg-slate-700/20 border border-slate-600/50 text-slate-400 hover:bg-slate-700/30'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
              title={rule.enabled ? 'Disable' : 'Enable'}
            >
              {toggling ? <Spinner size="sm" /> : <Power className="w-4 h-4" />}
            </button>
            <button
              onClick={onEdit}
              className="inline-flex items-center justify-center gap-2 px-3 h-8 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-600/30 rounded-lg transition-colors text-xs font-medium"
              title="Edit"
            >
              <Edit3 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleteDisabled || deleting}
              className="inline-flex items-center justify-center gap-2 px-3 h-8 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-600/30 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium"
              title="Remove"
            >
              {deleting ? <Spinner size="sm" /> : <Trash2 className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Full-width description content */}
        <div className="space-y-1 text-sm text-slate-400">
          {startMarkers.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-slate-500 shrink-0 w-24 text-left">Start markers:</span>
              <div className="flex flex-col gap-0.5">
                {startMarkers.map((marker, idx) => (
                  <code key={idx} className="text-slate-300 break-all">
                    {marker}
                  </code>
                ))}
              </div>
            </div>
          )}
          {endMarkers.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-slate-500 shrink-0 w-24 text-left">End markers:</span>
              <div className="flex flex-col gap-0.5">
                {endMarkers.map((marker, idx) => (
                  <code key={idx} className="text-slate-300 break-all">
                    {marker}
                  </code>
                ))}
              </div>
            </div>
          )}
          {rule.kind === 'jsonPath' && rule.path && (
            <div className="flex items-start gap-2">
              <span className="text-slate-500 shrink-0 w-24 text-left">Path:</span>
              <code className="text-slate-300 break-all">{rule.path}</code>
            </div>
          )}
          <div className="flex items-baseline gap-2">
            <span className="text-slate-500 shrink-0 w-24 text-left">Replace with:</span>
            <div className="flex-1 min-w-0">
              <button
                type="button"
                onClick={() => isTruncatable && setExpanded(prev => !prev)}
                aria-expanded={expanded}
                className={`group inline-flex w-full items-start gap-2 rounded-md border border-transparent px-0 py-0 text-left transition-colors ${
                  isTruncatable
                    ? 'cursor-pointer hover:border-cyan-500/40 hover:bg-cyan-500/5'
                    : 'cursor-default'
                }`}
              >
                <code className="text-cyan-300 break-all whitespace-pre-wrap text-xs flex-1">
                  {replacementText}
                </code>
                {isTruncatable && (
                  <span className="flex items-center gap-1 text-[11px] text-slate-500 group-hover:text-slate-200 shrink-0 pl-1">
                    <span>{expanded ? 'Collapse' : 'Expand'}</span>
                    <ChevronDown
                      className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                  </span>
                )}
              </button>
            </div>
          </div>
          {(rule.useRegex || rule.caseSensitive) && (
            <div className="flex items-center gap-3 mt-2">
              {rule.useRegex && <span className="text-xs text-blue-400">Regex</span>}
              {rule.caseSensitive && (
                <span className="text-xs text-purple-400">Case Sensitive</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default memo(RuleCard)
