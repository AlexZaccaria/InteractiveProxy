import TargetSelector from './TargetSelector'

/** @typedef {import('./useRuleForm').RuleFormData} RuleFormData */

const INPUT_CLASS =
  'w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500'
const TEXTAREA_CLASS =
  'w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 resize-none'

/**
 * The fields of a text rule: the start/end marker lists, the target, the
 * optional URL pattern and the replacement.
 *
 * @param {object} props
 * @param {RuleFormData} props.formData
 * @param {(patch: Partial<RuleFormData>) => void} props.onChange
 */
function TextRuleFields({ formData, onChange }) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
            Start markers (one per line)
          </label>
          <textarea
            value={formData.startVariantsText}
            onChange={e => onChange({ startVariantsText: e.target.value })}
            placeholder="Each line is an alternative start marker that can trigger this rule."
            rows={3}
            className={TEXTAREA_CLASS}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            All non-empty lines are treated as OR markers for the start boundary.
          </p>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
            End markers (one per line)
          </label>
          <textarea
            value={formData.endVariantsText}
            onChange={e => onChange({ endVariantsText: e.target.value })}
            placeholder="Each line is an alternative end marker that can close the replacement block."
            rows={3}
            className={TEXTAREA_CLASS}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Leave this empty to replace everything from the start marker to the end of the content.
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-end mt-2">
        <div className="sm:w-auto">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            Apply to
          </label>
          <TargetSelector value={formData.target} onChange={target => onChange({ target })} />
        </div>

        <div className="flex-1">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            URL pattern (optional)
          </label>
          <input
            type="text"
            value={formData.url}
            onChange={e => onChange({ url: e.target.value })}
            placeholder="es: /api/v1/users oppure https://example.com/api"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
          Replacement text
        </label>
        <textarea
          value={formData.replacement}
          onChange={e => onChange({ replacement: e.target.value })}
          placeholder="New text to insert"
          rows={3}
          className={TEXTAREA_CLASS}
        />
      </div>
    </>
  )
}

export default TextRuleFields
