import TargetSelector from './TargetSelector'

/** @typedef {import('./useRuleForm').RuleFormData} RuleFormData */

const INPUT_CLASS =
  'w-full px-3 h-8 bg-surface border border-edge rounded-lg text-xs text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-blue-500'
const TEXTAREA_CLASS =
  'w-full px-3 py-2 bg-surface border border-edge rounded-lg text-xs text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-blue-500 resize-none'

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
          <label
            htmlFor="rule-start-markers"
            className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1"
          >
            Start markers (one per line)
          </label>
          <textarea
            id="rule-start-markers"
            name="rule-start-markers"
            value={formData.startVariantsText}
            onChange={e => onChange({ startVariantsText: e.target.value })}
            placeholder="Each line is an alternative start marker that can trigger this rule."
            rows={3}
            className={TEXTAREA_CLASS}
          />
          <p className="mt-1 text-[11px] text-fg-faint">
            All non-empty lines are treated as OR markers for the start boundary.
          </p>
        </div>

        <div>
          <label
            htmlFor="rule-end-markers"
            className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-1"
          >
            End markers (one per line)
          </label>
          <textarea
            id="rule-end-markers"
            name="rule-end-markers"
            value={formData.endVariantsText}
            onChange={e => onChange({ endVariantsText: e.target.value })}
            placeholder="Each line is an alternative end marker that can close the replacement block."
            rows={3}
            className={TEXTAREA_CLASS}
          />
          <p className="mt-1 text-[11px] text-fg-faint">
            Leave this empty to replace everything from the start marker to the end of the content.
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-end mt-2">
        <div className="sm:w-auto">
          <label className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2">
            Apply to
          </label>
          <TargetSelector value={formData.target} onChange={target => onChange({ target })} />
        </div>

        <div className="flex-1">
          <label
            htmlFor="rule-text-url"
            className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2"
          >
            URL pattern (optional)
          </label>
          <input
            type="text"
            id="rule-text-url"
            name="rule-text-url"
            value={formData.url}
            onChange={e => onChange({ url: e.target.value })}
            placeholder="es: /api/v1/users oppure https://example.com/api"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="rule-replacement"
          className="block text-xs font-semibold uppercase tracking-wide text-fg-muted mb-2"
        >
          Replacement text
        </label>
        <textarea
          id="rule-replacement"
          name="rule-replacement"
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
