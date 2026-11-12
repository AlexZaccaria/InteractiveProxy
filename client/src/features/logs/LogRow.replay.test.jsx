import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LogRow, { isReplayableLog } from './LogRow'

vi.mock('./LogDetail', () => ({ default: () => <div data-testid="log-detail" /> }))

const httpLog = {
  id: 'log-1',
  timestamp: '2026-11-11T10:20:30.000Z',
  method: 'GET',
  source: 'proxied',
  url: 'http://a.test/x',
  fullUrl: 'http://a.test/x',
  statusCode: 200
}

const wsLog = {
  id: 'ws-1',
  timestamp: '2026-11-11T10:20:31.000Z',
  method: 'WS',
  source: 'websocket',
  url: 'wss://a.test/socket',
  direction: 'client->server'
}

function renderRow(log, extra = {}) {
  const handlers = {
    onToggleExpand: vi.fn(),
    onToggleExport: vi.fn(),
    onToggleBlock: vi.fn(),
    onToggleRewritesPin: vi.fn(),
    onReplaceResource: vi.fn(),
    onReplay: vi.fn(),
    onCopyCurl: vi.fn(),
    onCreateJsonPathRule: vi.fn()
  }
  render(
    <LogRow
      log={log}
      expanded={false}
      selectedForExport={false}
      blocked={false}
      rewritesPinned={false}
      {...handlers}
      {...extra}
    />
  )
  return handlers
}

describe('LogRow replay actions', () => {
  it('offers replay and curl on HTTP entries', () => {
    const handlers = renderRow(httpLog)
    fireEvent.click(screen.getByRole('button', { name: 'Replay request' }))
    expect(handlers.onReplay).toHaveBeenCalledWith(httpLog)
    fireEvent.click(screen.getByRole('button', { name: 'Copy as cURL' }))
    expect(handlers.onCopyCurl).toHaveBeenCalledWith(httpLog)
    // The clicks on the actions do not toggle the card.
    expect(handlers.onToggleExpand).not.toHaveBeenCalled()
  })

  it('shows the copied state of the curl button', () => {
    renderRow(httpLog, { curlCopied: true })
    expect(screen.getByRole('button', { name: 'Copied as cURL' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy as cURL' })).not.toBeInTheDocument()
  })

  it('hides them on WebSocket entries', () => {
    renderRow(wsLog)
    expect(screen.queryByRole('button', { name: 'Replay request' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy as cURL' })).not.toBeInTheDocument()
    expect(isReplayableLog(wsLog)).toBe(false)
    expect(isReplayableLog({ ...httpLog, isConnectionLog: true })).toBe(false)
    expect(isReplayableLog(httpLog)).toBe(true)
  })

  it('marks the entries that are replays', () => {
    renderRow({ ...httpLog, replayOf: 'log-0' })
    expect(screen.getByText('REPLAY')).toBeInTheDocument()
  })
})

describe('LogRow breakpoint badge', () => {
  it('marks the entries that went through a breakpoint', () => {
    renderRow({ ...httpLog, breakpoint: { request: 'edited', response: 'continued' } })
    expect(screen.getByText('BREAKPOINT')).toBeInTheDocument()
  })
})

describe('LogRow network badge', () => {
  it('marks the entries a network-condition rule slowed down', () => {
    renderRow({
      ...httpLog,
      network: { ruleId: 'n1', ruleName: 'Slow', delayMs: 300, throttleKbps: 64 }
    })
    expect(screen.getByText('SLOW')).toBeInTheDocument()
  })
})

describe('LogRow passthrough badge', () => {
  it('marks the tunnels a passthrough rule kept raw', () => {
    renderRow({
      ...httpLog,
      method: 'CONNECT',
      source: 'tunnel',
      passthrough: { ruleId: 'p1', ruleName: 'Bank' }
    })
    expect(screen.getByText('PASSTHROUGH')).toBeInTheDocument()
  })
})
