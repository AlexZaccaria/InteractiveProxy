import { AlertCircle } from 'lucide-react'

/** The explanatory box of the edit-rules tab (static). */
function HowItWorks() {
  return (
    <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-lg p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
        <div className="text-sm text-slate-300">
          <p className="font-medium text-cyan-400 mb-1">How it works</p>
          <p>
            Rules are applied across headers, bodies, Connect frames, and WebSocket messages for
            traffic that passes through the proxy pipeline. Text rules use{' '}
            <span className="font-semibold">start/end markers</span> to match text patterns:
            everything from the start marker through the end marker (inclusive) is replaced with
            your value. Markers are entered as lists (one per line) and all non-empty lines are
            treated as <span className="font-semibold">OR variants</span>, so a single rule can
            cover many similar cases. JSON Path rules target structured fields and support Manual
            values or File values read from a local path at runtime (no upload). Presets are scoped
            by Apply To (target), URL pattern, and JSON path (when applicable) to prevent mismatched
            usage.
          </p>
          <p className="mt-2 text-xs text-slate-400">
            <strong>Note:</strong> If you provide only start markers and leave end markers empty,
            the replacement will continue to the end of the content. This allows you to replace
            everything from a marker onwards without needing to specify where to stop. When both
            start and end marker lists are provided, the proxy applies the rule to every matching
            start/end combination. JSON Path rules require both a URL pattern and JSON path; File
            input requires a local file selection and is read at runtime. Saving a preset also saves
            the rule.
          </p>
        </div>
      </div>
    </div>
  )
}

export default HowItWorks
