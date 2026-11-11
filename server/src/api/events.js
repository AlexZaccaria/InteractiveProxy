'use strict'

/**
 * Management API: the event stream (`GET /api/events`, Server-Sent Events).
 *
 * The stores notify an event bus (new log entries, cleared logs, flag changes,
 * rule and resource changes); every open stream receives each event with a
 * monotonic id so the UI can react instead of polling. Dashboard counters
 * change with every request, so their event is coalesced to at most one per
 * `statsCoalesceMs` while traffic flows. There is no replay: a client that
 * reconnects starts from the current state (`GET /api/dashboard`, `/api/logs`).
 *
 * @module api/events
 */

const express = require('express')
const { buildClientLogSummaryView } = require('../logs/views')
const { logError } = require('../util/logger')

const DEFAULT_KEEP_ALIVE_MS = 15000
const DEFAULT_STATS_COALESCE_MS = 250
// A client that stops reading is dropped once this much output is queued.
const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024

/**
 * Keep-alive interval used by routers created without an explicit
 * `keepAliveMs`. Read whenever a stream opens, so tests can shorten it after
 * the application has been built.
 */
let defaultKeepAliveMs = DEFAULT_KEEP_ALIVE_MS

/**
 * @param {number} ms
 */
function setDefaultKeepAliveMs(ms) {
  defaultKeepAliveMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_KEEP_ALIVE_MS
}

/**
 * @typedef {object} BusEvent
 * @property {number} id Monotonic per bus, shared by every subscriber.
 * @property {string} name
 * @property {unknown} data JSON-serialisable payload.
 */

/**
 * @typedef {object} EventBus
 * @property {(name: string, data: unknown) => BusEvent} publish
 * @property {(listener: (event: BusEvent) => void) => () => void} subscribe Returns the unsubscribe function.
 */

/**
 * @returns {EventBus}
 */
function createEventBus() {
  let nextId = 1
  /** @type {Set<(event: BusEvent) => void>} */
  const listeners = new Set()

  return {
    publish(name, data) {
      /** @type {BusEvent} */
      const event = { id: nextId++, name, data }
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (error) {
          logError('events', 'Event listener failed', error)
        }
      }
      return event
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/**
 * Serialise an event in the SSE wire format. Events without an id (the
 * per-client `hello`) carry no `id:` line.
 *
 * @param {{ id?: number, name: string, data: unknown }} event
 * @returns {string}
 */
function formatEvent(event) {
  const lines = []
  if (typeof event.id === 'number') lines.push(`id: ${event.id}`)
  lines.push(`event: ${event.name}`)
  // JSON never contains a raw newline, so one data line is enough.
  lines.push(`data: ${JSON.stringify(event.data === undefined ? null : event.data)}`)
  return lines.join('\n') + '\n\n'
}

/**
 * @typedef {object} EventsRoutesDeps
 * @property {import('../logs/store').LogStore} logStore
 * @property {import('../logs/stats').Stats} stats
 * @property {import('../state/config-store').ConfigStore} configStore
 * @property {import('../rules/store').RuleStore} ruleStore
 * @property {import('../proxy/router').Router} router
 * @property {import('../resources/store').ResourceStore} resourceStore
 * @property {import('./index').BypassCounter} bypassCounter
 * @property {import('../rules/breakpoint-store').BreakpointStore} [breakpointStore] Its saves publish `rules` events of kind `breakpoints`.
 * @property {import('../proxy/breakpoints').BreakpointGate} [breakpointGate] Its pauses and resumptions publish `breakpoint` events.
 * @property {StreamPresence} [streamPresence] Kept equal to the number of open streams.
 * @property {number} [keepAliveMs] Interval of the `: ping` comment lines (default 15 s).
 * @property {number} [statsCoalesceMs] Minimum spacing of `stats` events while traffic flows (default 250 ms).
 */

/**
 * The number of open event streams, shared with the parts of the proxy that
 * act only when a UI is listening (the breakpoints).
 *
 * @typedef {{ clients: number }} StreamPresence
 */

/**
 * @param {EventsRoutesDeps} deps
 * @returns {import('express').Router}
 */
function createEventsRoutes({
  logStore,
  stats,
  configStore,
  ruleStore,
  router: proxyRouter,
  resourceStore,
  bypassCounter,
  breakpointStore,
  breakpointGate,
  streamPresence,
  keepAliveMs,
  statsCoalesceMs = DEFAULT_STATS_COALESCE_MS
}) {
  const bus = createEventBus()
  /** @type {Set<import('express').Response>} */
  const clients = new Set()

  function updatePresence() {
    if (streamPresence) streamPresence.clients = clients.size
  }
  /** @type {NodeJS.Timeout | null} */
  let keepAliveTimer = null
  /** @type {NodeJS.Timeout | null} */
  let statsTimer = null

  const keepAliveInterval = () =>
    Number.isFinite(keepAliveMs) && Number(keepAliveMs) > 0
      ? Number(keepAliveMs)
      : defaultKeepAliveMs

  // ---- counters -----------------------------------------------------------

  /**
   * The dashboard payload as `/api/dashboard` returns it, minus the resource
   * and blocked lists (those travel as `rules` events).
   */
  function dashboardData() {
    const {
      stats: dashboard,
      editedRequests,
      performance,
      payloads,
      routes
    } = stats.getDashboardSnapshot()
    return {
      stats: dashboard,
      performance,
      payloads,
      routes,
      editedRequests,
      filterMetrics: {
        totalFiltered: bypassCounter.get(),
        activeRules: proxyRouter.getBypassUrls().length
      }
    }
  }

  function publishStats() {
    if (statsTimer) {
      clearTimeout(statsTimer)
      statsTimer = null
    }
    if (clients.size === 0) return
    bus.publish('stats', dashboardData())
  }

  /** Trailing coalescing: one `stats` event per window while entries keep coming. */
  function scheduleStats() {
    if (statsTimer || clients.size === 0) return
    statsTimer = setTimeout(publishStats, statsCoalesceMs)
    statsTimer.unref()
  }

  // ---- store subscriptions (live as long as the router) -------------------

  logStore.onEntryAdded(entry => {
    if (clients.size === 0) return
    bus.publish('log', buildClientLogSummaryView(entry))
    scheduleStats()
  })

  logStore.onCleared(() => {
    if (clients.size === 0) return
    bus.publish('logs-cleared', {})
    // The route resets the counters right after clearing the window; publish
    // once that has happened so the event carries the zeroed snapshot.
    setImmediate(publishStats)
  })

  // Aggregates that change outside the add/remove cycle of the window (the
  // size of a streamed response, known when its transfer ends).
  stats.onChange(() => {
    scheduleStats()
  })

  configStore.onChange(snapshot => {
    bus.publish('config', snapshot)
  })

  ruleStore.onChange(change => {
    if (change.kind === 'enabled') {
      bus.publish('config', configStore.snapshot())
    } else {
      bus.publish('rules', { kind: 'edit' })
    }
  })

  proxyRouter.onChange(change => {
    bus.publish('rules', { kind: change.kind })
  })

  resourceStore.onChange(() => {
    bus.publish('rules', { kind: 'resources' })
  })

  if (breakpointStore) {
    breakpointStore.onChange(() => {
      bus.publish('rules', { kind: 'breakpoints' })
    })
  }

  if (breakpointGate) {
    breakpointGate.onChange(event => {
      bus.publish('breakpoint', event)
    })
  }

  // ---- clients ------------------------------------------------------------

  /**
   * @param {import('express').Response} res
   */
  function dropClient(res) {
    if (!clients.delete(res)) return
    updatePresence()
    try {
      res.end()
    } catch {
      // Best-effort: the response may already be closed by the client.
    }
    stopKeepAliveIfIdle()
  }

  /**
   * @param {import('express').Response} res
   * @param {string} chunk
   */
  function writeTo(res, chunk) {
    if (res.destroyed || res.writableEnded) {
      clients.delete(res)
      updatePresence()
      stopKeepAliveIfIdle()
      return
    }
    // Never buffer without bound for a client that stopped reading.
    if (res.writableLength > MAX_CLIENT_BUFFER_BYTES) {
      dropClient(res)
      return
    }
    res.write(chunk)
  }

  /**
   * @param {string} chunk
   */
  function broadcast(chunk) {
    for (const res of Array.from(clients)) {
      writeTo(res, chunk)
    }
  }

  function startKeepAlive() {
    if (keepAliveTimer) return
    keepAliveTimer = setInterval(() => broadcast(': ping\n\n'), keepAliveInterval())
    // Open streams must not keep the process alive on their own: stop()
    // closes the connections and the interval goes away with the last client.
    keepAliveTimer.unref()
  }

  function stopKeepAliveIfIdle() {
    if (clients.size > 0) return
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }
    if (statsTimer) {
      clearTimeout(statsTimer)
      statsTimer = null
    }
  }

  bus.subscribe(event => broadcast(formatEvent(event)))

  // ---- route ----------------------------------------------------------------

  const router = express.Router()

  router.get('/events', (req, res) => {
    // Headers set earlier by the cors middleware are kept; these take precedence.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.flushHeaders()

    clients.add(res)
    updatePresence()
    startKeepAlive()

    writeTo(
      res,
      formatEvent({
        name: 'hello',
        data: {
          interactiveModeEnabled: configStore.interactiveModeEnabled,
          serverTime: new Date().toISOString()
        }
      })
    )

    res.on('close', () => {
      clients.delete(res)
      updatePresence()
      stopKeepAliveIfIdle()
    })
  })

  return router
}

module.exports = {
  DEFAULT_KEEP_ALIVE_MS,
  DEFAULT_STATS_COALESCE_MS,
  MAX_CLIENT_BUFFER_BYTES,
  createEventBus,
  formatEvent,
  setDefaultKeepAliveMs,
  createEventsRoutes
}
