/**
 * Shapes of the management API payloads used by the client (see docs/API.md).
 * JSDoc-only module: it exports nothing at runtime.
 */

/**
 * @typedef {'ignore' | 'focus'} FilterMode
 */

/**
 * @typedef {Object} ConfigSnapshot
 * @property {boolean} interactiveModeEnabled
 * @property {boolean} editRulesEnabled
 * @property {boolean} localResourcesEnabled
 * @property {boolean} filterRulesEnabled
 * @property {boolean} blockedRulesEnabled
 * @property {FilterMode} filterMode
 * @property {number} [filteredRequestCount]
 */

/**
 * @typedef {Object} DashboardStats
 * @property {number} total
 * @property {number} served
 * @property {number} proxied
 * @property {number} blocked
 * @property {number} processed
 * @property {number} errors
 */

/**
 * @typedef {Object} DashboardAverage
 * @property {number} avg
 * @property {number} max
 */

/**
 * @typedef {Object} DashboardRoute
 * @property {string} host
 * @property {string} path
 * @property {number} avgMs
 * @property {number} maxMs
 * @property {number} count
 * @property {number} avgBytes
 * @property {number} kbPerSecond
 * @property {'processed' | 'redirected' | 'blocked' | 'served'} handling
 */

/**
 * @typedef {Object} DashboardRoutes
 * @property {DashboardRoute[]} slowest
 * @property {{ processed: DashboardRoute[], redirected: DashboardRoute[], blocked: DashboardRoute[], served: DashboardRoute[] }} byHandling
 */

/**
 * The payload of GET /api/dashboard. The `stats` event of the event stream
 * carries the same fields without `resources` and `blocked`.
 *
 * @typedef {Object} DashboardPayload
 * @property {DashboardStats} stats
 * @property {{ upstreamMs: DashboardAverage, totalMs: DashboardAverage, proxyOverheadMs: DashboardAverage }} performance
 * @property {{ requestBytes: DashboardAverage, responseBytes: DashboardAverage }} payloads
 * @property {DashboardRoutes} routes
 * @property {LocalResource[]} [resources]
 * @property {string[]} [blocked]
 * @property {{ totalFiltered: number, activeRules: number }} filterMetrics
 * @property {number} editedRequests
 */

/**
 * @typedef {Object} EditRule
 * @property {string} id
 * @property {boolean} enabled
 * @property {'text' | 'jsonPath'} kind
 * @property {string} name
 * @property {string} [url]
 * @property {'request' | 'response' | 'both'} [target]
 * @property {string[]} [startVariants]
 * @property {string[]} [endVariants]
 * @property {string} [replacement]
 * @property {boolean} [useRegex]
 * @property {boolean} [caseSensitive]
 * @property {string} [path]
 * @property {any} [value]
 * @property {'string' | 'number' | 'boolean' | 'null' | 'json'} [valueType]
 * @property {{ type: 'file', filename?: string, path?: string, originalName?: string } | null} [valueSource]
 */

/**
 * @typedef {Object} EditRulePreset
 * @property {string} id
 * @property {string} name
 * @property {'text' | 'jsonPath'} kind
 * @property {Partial<EditRule>} rule
 * @property {string} createdAt
 */

/**
 * @typedef {Object} EditRuleUsage
 * @property {Record<string, number>} usage Logged entries each rule touched, by rule id.
 * @property {number} totalRulesWithUsage
 */

/**
 * @typedef {Object} BlockedRule
 * @property {string} id
 * @property {boolean} enabled
 * @property {string} name
 * @property {string} url
 */

/**
 * @typedef {Object} FilterRule
 * @property {string} id
 * @property {boolean} enabled
 * @property {string} name
 * @property {string} url
 * @property {FilterMode} mode
 */

/**
 * @typedef {Object} FilterSuggestion
 * @property {string} pattern
 * @property {number} count
 * @property {string} [lastSeen]
 * @property {Array<{ path: string, count: number }>} [paths]
 * @property {Array<{ path: string, count: number }>} [samplePaths]
 */

/**
 * @typedef {Object} LocalResource
 * @property {string} url
 * @property {'file' | 'text'} type
 * @property {string} filename
 * @property {string} [originalName]
 * @property {string} contentType
 * @property {number} size
 * @property {string} createdAt
 * @property {boolean} enabled
 */

/**
 * A rule that applied to a logged entry.
 *
 * @typedef {Object} LogRewrite
 * @property {string} id
 * @property {string} [name]
 * @property {string} [kind]
 * @property {string} [url]
 * @property {string} [target]
 * @property {string} [appliedScope]
 */

/**
 * One entry of `GET /api/logs?view=summary` (and of the `log` event).
 *
 * @typedef {Object} LogSummary
 * @property {string} id
 * @property {string} timestamp
 * @property {string} method
 * @property {string} source `proxied`, `mitm`, `websocket`, `local`, `blocked`, `error`, ...
 * @property {string} url
 * @property {string} [fullUrl]
 * @property {number} [statusCode]
 * @property {number} [responseSize]
 * @property {string} [fileType]
 * @property {string} [localResource]
 * @property {string} [error]
 * @property {string} [direction] WebSocket direction (`client → server` / `server → client`).
 * @property {number} [requestBytes]
 * @property {number} [responseBytes]
 * @property {Record<string, string | string[]>} [headers]
 * @property {Record<string, string | string[]>} [responseHeaders]
 * @property {string} [requestBodySummary]
 * @property {string} [responseBodySummary]
 * @property {LogRewrite[]} [rewrites]
 * @property {string} [connectSummary]
 * @property {Record<string, any>} [wsSummary]
 * @property {any} [responseBody] Present in the summary of some entries; the full view always has it.
 * @property {any} [body]
 */

/**
 * A decoded Connect/gRPC frame.
 *
 * @typedef {Object} ConnectFrame
 * @property {number} index
 * @property {number} length
 * @property {boolean} [endStream]
 * @property {boolean} [compressed]
 * @property {Record<string, any>} [json]
 * @property {string} [preview]
 * @property {string} [note]
 */

/**
 * @typedef {Object} ConnectTimeline
 * @property {ConnectFrame[]} [frames] After the rewrite rules.
 * @property {ConnectFrame[]} [originalFrames] Before the rewrite rules, when any applied.
 */

/**
 * The full view of one entry (`GET /api/logs/:id`): the summary plus the
 * bodies, the JSON views before and after rewriting, the raw previews and
 * the Connect frames.
 *
 * @typedef {LogSummary & {
 *   requestBodyJson?: any,
 *   requestBodyJsonBefore?: any,
 *   responseBodyJson?: any,
 *   responseBodyJsonBefore?: any,
 *   wsBodyJsonAfter?: any,
 *   wsBodyJsonBefore?: any,
 *   rawRequestBodyPreview?: string,
 *   rawRequestBodyBase64?: string,
 *   rawResponseBodyPreview?: string,
 *   rawResponseBodyBase64?: string,
 *   connectRequest?: ConnectTimeline,
 *   connectResponse?: ConnectTimeline
 * }} LogDetail
 */

/**
 * One page of `GET /api/logs`.
 *
 * @typedef {Object} LogsPage
 * @property {LogSummary[]} items
 * @property {number} total
 * @property {boolean} hasMore
 * @property {number} offset
 * @property {number} limit
 */

/**
 * @typedef {Object} AuditSnapshot
 * @property {Record<string, number>} errorBuckets
 * @property {number} totalErrors
 * @property {Array<{ host: string, count: number, avgDuration: number }>} hostStats
 */

export {}
