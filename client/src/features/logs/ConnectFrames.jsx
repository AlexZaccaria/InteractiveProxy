import { useEffect, useMemo, useState } from 'react'
import { JsonTree } from './JsonTree'

/**
 * The Connect/gRPC frame timelines of an entry: one collapsible section per
 * timeline (after the rewrite rules, and before them when any applied),
 * each frame with its decoded Protobuf JSON or its textual preview.
 */

/** @typedef {import('../../lib/types').ConnectFrame} ConnectFrame */
/** @typedef {import('../../lib/types').ConnectTimeline} ConnectTimeline */

/**
 * A readable text of a timeline for the raw preview: the single JSON frame
 * pretty-printed, up to eight JSON frames aggregated by index, otherwise
 * the frames' previews one after the other.
 *
 * @param {ConnectTimeline | null | undefined} connectData
 * @returns {string}
 */
export function buildConnectReadablePreview(connectData) {
  if (!connectData || typeof connectData !== 'object') return ''

  const framesSource =
    Array.isArray(connectData.originalFrames) && connectData.originalFrames.length
      ? connectData.originalFrames
      : Array.isArray(connectData.frames)
        ? connectData.frames
        : []

  const frames = Array.isArray(framesSource) ? framesSource : []
  if (!frames.length) return ''

  const jsonFrames = frames.filter(frame => {
    if (!frame || !frame.json || typeof frame.json !== 'object') return false
    try {
      return Object.keys(frame.json).length > 0
    } catch {
      return false
    }
  })

  if (jsonFrames.length === 1) {
    try {
      return JSON.stringify(jsonFrames[0].json, null, 2)
    } catch {
      // fall through
    }
  }

  if (jsonFrames.length > 1 && jsonFrames.length <= 8) {
    const aggregate = {}
    for (const frame of jsonFrames) {
      const key = typeof frame.index === 'number' ? `frame ${frame.index}` : 'frame'
      aggregate[key] = frame.json
    }
    try {
      return JSON.stringify(aggregate, null, 2)
    } catch {
      // fall through
    }
  }

  const segments = []
  for (const frame of frames) {
    if (!frame) continue

    const parts = []
    if (typeof frame.index === 'number') parts.push(`frame ${frame.index}`)
    if (typeof frame.length === 'number') parts.push(`${frame.length} bytes`)
    const header = parts.length ? `# ${parts.join('  b7 ')}` : ''

    const body =
      (typeof frame.preview === 'string' && frame.preview.trim()) ||
      (typeof frame.note === 'string' && frame.note.trim()) ||
      ''
    if (!body) continue

    if (header) segments.push(header)
    segments.push(body)
  }

  return segments.join('\n\n')
}

/**
 * @param {ConnectFrame | null | undefined} frame
 * @returns {string}
 */
function summarizeFrame(frame) {
  if (!frame) return ''
  if (frame.preview && frame.preview.trim()) return frame.preview.trim()
  if (frame.note) return frame.note
  if (typeof frame.length === 'number') return `Binary frame (${frame.length} bytes)`
  return ''
}

/**
 * One timeline. With more than three frames every frame starts collapsed;
 * the first frame carries the switch between the compact, expanded and
 * full heights.
 *
 * @param {Object} props
 * @param {string} props.title
 * @param {ConnectFrame[] | undefined} props.frames
 * @param {boolean} [props.defaultCollapsed]
 * @param {any} props.log
 * @param {(seed: import('./jsonPath').JsonPathRuleSeed) => void} [props.onCreateJsonPathRule]
 * @param {'request' | 'response'} [props.phase]
 */
export function ConnectFramesSection({
  title,
  frames,
  defaultCollapsed = true,
  log,
  onCreateJsonPathRule,
  phase = 'request'
}) {
  const frameList = useMemo(() => frames ?? [], [frames])
  const frameCount = frameList.length
  const [timelineView, setTimelineView] = useState('compact')
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)

  const informativeIndex = useMemo(() => {
    if (!frameList.length) return 0

    return (
      [...frameList]
        .map((frame, idx) => ({ frame, idx }))
        .reverse()
        .find(({ frame }) => {
          if (frame.json && Object.keys(frame.json).length > 0) return true
          if (frame.preview && frame.preview.trim().length > 0) return true
          return false
        })?.idx ?? frameList.length - 1
    )
  }, [frameList])

  const [openFrameStates, setOpenFrameStates] = useState({})

  useEffect(() => {
    setOpenFrameStates({})
  }, [frameList])

  const toggleTimelineView = () => {
    setTimelineView(prev => {
      if (prev === 'compact') return 'expanded'
      if (prev === 'expanded') return 'full'
      return 'compact'
    })
  }

  const timelineButtonLabel =
    timelineView === 'compact' ? 'Expand' : timelineView === 'expanded' ? 'Show all' : 'Collapse'

  const timelineHeightClass =
    timelineView === 'compact'
      ? 'max-h-[1200px]'
      : timelineView === 'expanded'
        ? 'max-h-[4000px]'
        : 'max-h-none'

  const summaryHeightClass =
    timelineView === 'compact'
      ? 'max-h-[640px]'
      : timelineView === 'expanded'
        ? 'max-h-[1500px]'
        : 'max-h-none'

  if (!frameList.length) {
    return (
      <details
        className="bg-surface-inset border border-edge rounded self-start"
        open={!defaultCollapsed}
      >
        <summary className="cursor-pointer px-3 py-2 text-xs text-fg-muted flex items-center justify-between">
          <span>{title}</span>
          <span className="text-fg-dim">(empty)</span>
        </summary>
      </details>
    )
  }

  const urlPattern = log?.fullUrl || log?.url || ''

  return (
    <details
      className="bg-surface-inset border border-edge rounded self-start"
      open={!isCollapsed}
      onToggle={event => {
        if (event.currentTarget !== event.target) return
        setIsCollapsed(!event.currentTarget.open)
      }}
    >
      <summary className="cursor-pointer px-3 py-2 text-xs text-fg-muted hover:text-fg-base flex items-center justify-between">
        <span>{title}</span>
        <span className="text-fg-faint">
          {frameCount} frame{frameCount === 1 ? '' : 's'}
        </span>
      </summary>

      {!isCollapsed && (
        <div className="space-y-3 px-3 pb-3 pt-2">
          <div className={`space-y-1 overflow-y-auto ${timelineHeightClass}`}>
            {frameList.map((frame, idx) => {
              const summary = summarizeFrame(frame)
              const highlight = idx === informativeIndex
              const isFirstVisibleFrame = idx === 0
              const hasJson = frame && frame.json && Object.keys(frame.json).length > 0
              const frameLabel = `Frame ${frame.index}${frame.endStream ? ' • End' : ''}${frame.compressed ? ' • Compressed' : ''}`
              const manyFrames = frameCount > 3
              const frameKey = `${frame.index}-${frame.length}-${idx}`
              const isFrameOpen = !manyFrames || !!openFrameStates[frameKey]

              return (
                <div
                  key={`summary-${frame.index}-${frame.length}`}
                  className={`rounded border border-edge ${highlight ? 'bg-surface-hover' : 'bg-surface-inset'} p-2 text-xs text-fg-body`}
                >
                  <details
                    open={isFrameOpen}
                    onToggle={
                      manyFrames
                        ? event => {
                            const isOpen = event.target.open
                            setOpenFrameStates(prev => ({ ...prev, [frameKey]: isOpen }))
                          }
                        : undefined
                    }
                  >
                    <summary className="cursor-pointer list-none">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="font-semibold text-fg-base">{frameLabel}</span>
                        <div className="flex items-center gap-3 text-fg-faint">
                          <span>{frame.length} bytes</span>
                          {isFirstVisibleFrame && (
                            <button
                              type="button"
                              onClick={toggleTimelineView}
                              className="text-blue-400 hover:text-blue-200 transition-colors"
                            >
                              {timelineButtonLabel}
                            </button>
                          )}
                        </div>
                      </div>
                    </summary>

                    {isFrameOpen && (
                      <div className="mt-1">
                        {hasJson ? (
                          <div className={`text-fg-base overflow-y-auto ${summaryHeightClass}`}>
                            <div className="bg-surface-inset rounded px-3 py-2 border border-edge">
                              <JsonTree
                                title="Decoded Protobuf JSON"
                                data={frame.json}
                                contextLabel={`${title || 'Connect'} frame #${frame.index}`}
                                urlPattern={urlPattern}
                                target={phase}
                                onCreateJsonPathRule={onCreateJsonPathRule}
                              />
                            </div>
                          </div>
                        ) : summary ? (
                          <div
                            className={`text-fg-muted whitespace-pre-wrap break-words overflow-y-auto ${summaryHeightClass}`}
                          >
                            {summary}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </details>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </details>
  )
}

/**
 * The timelines of a request or a response: side by side when both the
 * rewritten and the original frames exist, stacked otherwise.
 *
 * @param {Object} props
 * @param {ConnectTimeline | null | undefined} props.connectData
 * @param {'request' | 'response'} props.phase
 * @param {any} props.log
 * @param {(seed: import('./jsonPath').JsonPathRuleSeed) => void} [props.onCreateJsonPathRule]
 */
export function ConnectTimelines({ connectData, phase, log, onCreateJsonPathRule }) {
  if (!connectData) return null

  const beforeFrames = Array.isArray(connectData.originalFrames) ? connectData.originalFrames : []
  const afterFrames = Array.isArray(connectData.frames) ? connectData.frames : []

  const hasBefore = beforeFrames.length > 0
  const hasAfter = afterFrames.length > 0
  if (!hasBefore && !hasAfter) return null

  const shared = { defaultCollapsed: true, log, onCreateJsonPathRule, phase }

  if (hasBefore && hasAfter) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ConnectFramesSection title="Timeline (after rewrite)" frames={afterFrames} {...shared} />
        <ConnectFramesSection title="Timeline (before rewrite)" frames={beforeFrames} {...shared} />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {hasAfter && (
        <ConnectFramesSection title="Timeline (after rewrite)" frames={afterFrames} {...shared} />
      )}
      {hasBefore && (
        <ConnectFramesSection title="Timeline (before rewrite)" frames={beforeFrames} {...shared} />
      )}
    </div>
  )
}
