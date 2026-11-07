import { JsonBeforeAfter, JsonPanel } from './JsonTree'

/**
 * The preview of a WebSocket message: the JSON the server decoded (after
 * and before the rewrite rules when any applied; rules seeded from it
 * target both directions), or the text as it was relayed.
 *
 * @param {Object} props
 * @param {import('../../lib/types').LogDetail} props.effectiveLog
 * @param {string} props.bodyToShow The message as text, for the fallback.
 * @param {(seed: import('./jsonPath').JsonPathRuleSeed) => void} [props.onCreateJsonPathRule]
 */
export function WsMessagePreview({ effectiveLog, bodyToShow, onCreateJsonPathRule }) {
  const jsonData = effectiveLog.wsBodyJsonAfter || effectiveLog.wsBodyJsonBefore
  const isJSON = Boolean(jsonData) && !bodyToShow.includes('[Binary')

  if (!isJSON) {
    return (
      <pre className="bg-[#0f0f0f] border border-[#2a2a2a] p-3 rounded text-xs text-slate-300 overflow-x-auto max-h-96">
        {bodyToShow || 'No content available'}
      </pre>
    )
  }

  const hasRewrites = Array.isArray(effectiveLog.rewrites) && effectiveLog.rewrites.length > 0
  const urlPattern = effectiveLog.fullUrl || effectiveLog.url || ''

  if (hasRewrites && effectiveLog.wsBodyJsonBefore) {
    return (
      <JsonBeforeAfter
        after={effectiveLog.wsBodyJsonAfter || jsonData}
        before={effectiveLog.wsBodyJsonBefore}
        contextLabel="Response JSON body"
        urlPattern={urlPattern}
        target="both"
        onCreateJsonPathRule={onCreateJsonPathRule}
      />
    )
  }

  return (
    <div className="text-xs text-slate-200">
      <JsonPanel
        data={jsonData}
        contextLabel="Response JSON body"
        urlPattern={urlPattern}
        target="both"
        onCreateJsonPathRule={onCreateJsonPathRule}
      />
    </div>
  )
}
