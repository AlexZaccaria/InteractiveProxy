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
 * @typedef {Object} AuditSnapshot
 * @property {Record<string, number>} errorBuckets
 * @property {number} totalErrors
 * @property {Array<{ host: string, count: number, avgDuration: number }>} hostStats
 */

export {}
