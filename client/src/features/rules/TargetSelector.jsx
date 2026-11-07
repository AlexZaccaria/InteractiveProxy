const TARGET_OPTIONS = [
  {
    key: 'request',
    label: 'Request',
    active: 'bg-blue-600/20 border-blue-500/60 text-blue-300',
    hover: 'hover:border-blue-500 hover:text-blue-300'
  },
  {
    key: 'response',
    label: 'Response',
    active: 'bg-green-600/20 border-green-500/60 text-green-300',
    hover: 'hover:border-green-500 hover:text-green-300'
  },
  {
    key: 'both',
    label: 'Both',
    active: 'bg-yellow-500/20 border-yellow-400/60 text-yellow-300',
    hover: 'hover:border-yellow-400 hover:text-yellow-300'
  }
]

/**
 * The "Apply to" buttons (Request / Response / Both).
 *
 * @param {object} props
 * @param {'request' | 'response' | 'both'} props.value
 * @param {(target: 'request' | 'response' | 'both') => void} props.onChange
 * @param {boolean} [props.stretch] Buttons share the row's width (the JSONPath layout) instead of wrapping.
 */
function TargetSelector({ value, onChange, stretch = false }) {
  return (
    <div className={stretch ? 'flex w-full gap-2' : 'flex flex-wrap gap-2'}>
      {TARGET_OPTIONS.map(option => {
        const isActive = value === option.key
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            className={`inline-flex ${stretch ? 'flex-1 ' : ''}items-center justify-center px-3 h-8 rounded-md border text-xs font-medium transition-colors ${
              isActive
                ? option.active
                : `bg-[#0a0a0a] border-[#2a2a2a] text-slate-300 ${option.hover}`
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export default TargetSelector
