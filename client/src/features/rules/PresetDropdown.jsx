import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Trash2 } from 'lucide-react'

/** @typedef {import('../../lib/types').EditRulePreset} EditRulePreset */

const targetMeta = {
  Request: {
    label: 'Request',
    badge: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
    dot: 'bg-blue-400'
  },
  Response: {
    label: 'Response',
    badge: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
    dot: 'bg-purple-400'
  },
  Both: {
    label: 'Both',
    badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    dot: 'bg-emerald-400'
  }
}

/**
 * Preset dropdown menu with inline delete actions. The groups are the output
 * of `buildGroupedPresets` (one per target); the menu closes on a click
 * outside of it.
 *
 * @param {object} props
 * @param {string} props.value The selected preset id, `''` for none.
 * @param {string} props.placeholder
 * @param {Array<[string, EditRulePreset[]]>} props.groups
 * @param {boolean} props.loading
 * @param {boolean} props.disabled
 * @param {(presetId: string) => void} props.onSelect
 * @param {(presetId: string) => void} props.onDelete
 * @param {string} [props.buttonClassName]
 * @param {string} [props.menuClassName]
 */
function PresetDropdown({
  value,
  placeholder,
  groups,
  loading,
  disabled,
  onSelect,
  onDelete,
  buttonClassName = '',
  menuClassName = ''
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)

  const selectedPreset = useMemo(() => {
    if (!value) return null
    for (const [, items] of groups) {
      const match = items.find(preset => String(preset.id) === String(value))
      if (match) return match
    }
    return null
  }, [groups, value])

  const selectedLabel = selectedPreset?.name ?? ''
  const buttonLabel = selectedLabel || placeholder
  const isPlaceholder = !selectedLabel
  const totalPresets = useMemo(
    () => groups.reduce((sum, [, items]) => sum + items.length, 0),
    [groups]
  )

  useEffect(() => {
    if (!open) return undefined
    const handleClickOutside = event => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleSelect = presetId => {
    setOpen(false)
    if (onSelect) onSelect(String(presetId))
  }

  const hasPresets = groups.some(([, items]) => items.length > 0)

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`group inline-flex w-full min-w-[220px] items-center justify-between gap-2 rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-3 h-8 text-left text-xs text-slate-100 transition-colors hover:border-blue-500/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500/30 ${
          open ? 'border-blue-500/60 shadow-[0_0_0_1px_rgba(59,130,246,0.25)]' : ''
        } ${buttonClassName}`}
      >
        <span className={`truncate ${isPlaceholder ? 'text-slate-400' : 'text-slate-100'}`}>
          {buttonLabel}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform duration-150 ${
            open ? 'rotate-180 text-slate-200' : 'text-slate-400'
          }`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className={`absolute right-0 mt-2 w-64 overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#101010] shadow-2xl ${menuClassName}`}
        >
          <div className="flex items-center justify-between border-b border-[#1e1e1e] px-3 py-2 text-[10px] uppercase tracking-wide text-slate-500">
            <span>Presets</span>
            <span>{totalPresets}</span>
          </div>
          <div className="max-h-[280px] overflow-y-auto py-1">
            {loading ? (
              <div className="px-3 py-2 text-[11px] text-slate-400">Loading presets...</div>
            ) : !hasPresets ? (
              <div className="px-3 py-2 text-[11px] text-slate-500">No presets saved yet</div>
            ) : (
              groups.map(([groupLabel, items]) => {
                const meta = targetMeta[groupLabel] || {
                  label: groupLabel,
                  badge: 'border-slate-600/40 bg-slate-700/20 text-slate-400',
                  dot: 'bg-slate-400'
                }
                return (
                  <div key={groupLabel} className="py-1">
                    <div className="flex items-center justify-between px-3 py-1">
                      <span className="text-[10px] uppercase tracking-wide text-slate-600">
                        Target
                      </span>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${meta.badge}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                        {meta.label}
                      </span>
                    </div>
                    {items.map(preset => {
                      const isSelected = String(preset.id) === String(value)
                      return (
                        <div
                          key={preset.id}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md transition-colors ${
                            isSelected ? 'bg-[#141414]' : 'hover:bg-[#141414]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => handleSelect(preset.id)}
                            className="flex-1 text-left text-[11px] text-slate-100 truncate"
                            aria-selected={isSelected}
                            role="option"
                          >
                            {preset.name}
                          </button>
                          {isSelected && <Check className="w-3.5 h-3.5 text-blue-400" />}
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation()
                              if (onDelete) onDelete(String(preset.id))
                            }}
                            className="p-1 rounded text-slate-500 transition-colors hover:bg-red-600/20 hover:text-red-300"
                            title="Delete preset"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default PresetDropdown
