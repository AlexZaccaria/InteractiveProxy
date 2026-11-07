/**
 * The headers of a request or a response, one row per name; array values
 * are joined with commas.
 *
 * @param {{ headers: Record<string, string | string[]> | null | undefined }} props
 */
export default function HeaderList({ headers }) {
  if (!headers || typeof headers !== 'object') {
    return <div className="text-xs text-slate-400">No headers.</div>
  }

  const entries = Object.entries(headers)
  if (!entries.length) {
    return <div className="text-xs text-slate-400">No headers.</div>
  }

  return (
    <div className="border border-[#2a2a2a] rounded bg-[#0f0f0f] divide-y divide-[#1e1e1e]">
      {entries.map(([key, rawValue]) => {
        const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue)

        return (
          <div key={key} className="px-3 py-2 flex flex-col sm:flex-row sm:items-start gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 sm:w-48 shrink-0">
              {key}
            </div>
            <div className="text-[11px] text-slate-200 font-mono break-all flex-1 leading-relaxed">
              {value}
            </div>
          </div>
        )
      })}
    </div>
  )
}
