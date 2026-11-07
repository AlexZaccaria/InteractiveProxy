import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LogRow from './LogRow'

vi.mock('./LogDetail', () => ({
  default: ({ log }) => <div data-testid="log-detail">details of {log.id}</div>
}))

const baseLog = {
  id: 'log-1',
  timestamp: '2026-11-07T10:20:30.000Z',
  method: 'POST',
  source: 'mitm',
  url: 'https://api.test/v1/users',
  fullUrl: 'https://api.test/v1/users?page=2',
  statusCode: 201,
  fileType: 'json',
  responseHeaders: { 'content-type': 'application/json' },
  rewrites: [{ id: 'r1', name: 'Rename user', kind: 'jsonPath', target: 'response' }]
}

function renderRow(overrides = {}) {
  const handlers = {
    onToggleExpand: vi.fn(),
    onToggleExport: vi.fn(),
    onToggleBlock: vi.fn(),
    onToggleRewritesPin: vi.fn(),
    onReplaceResource: vi.fn(),
    onCreateJsonPathRule: vi.fn()
  }
  const props = {
    log: baseLog,
    expanded: false,
    selectedForExport: false,
    blocked: false,
    rewritesPinned: false,
    ...handlers,
    ...overrides
  }
  const view = render(<LogRow {...props} />)
  return { ...view, handlers }
}

describe('LogRow', () => {
  it('shows the badges, the URL and the time', () => {
    renderRow({ rewritesPinned: true })
    expect(screen.getByText('POST')).toBeInTheDocument()
    expect(screen.getByText('MITM')).toBeInTheDocument()
    expect(screen.getByText('201')).toBeInTheDocument()
    expect(screen.getByText('JSON')).toBeInTheDocument()
    expect(screen.getByText('https://api.test/v1/users?page=2')).toBeInTheDocument()
    expect(screen.getByText('Rewrites')).toBeInTheDocument()
    expect(screen.getByText('Rename user')).toBeInTheDocument()
    expect(screen.getByText('Scope: response')).toBeInTheDocument()
    expect(
      screen.getByText(new Date(baseLog.timestamp).toLocaleString('it-IT'))
    ).toBeInTheDocument()
    expect(screen.queryByTestId('log-detail')).not.toBeInTheDocument()
  })

  it('replaces "server" with the host in a WebSocket direction and hides the source badge for WS', () => {
    renderRow({
      log: {
        ...baseLog,
        method: 'WS',
        source: 'websocket',
        direction: 'server → client',
        fullUrl: 'wss://chat.test/socket',
        responseHeaders: undefined,
        rewrites: undefined
      }
    })
    expect(screen.getByText('chat.test → client')).toBeInTheDocument()
    expect(screen.queryByText('WEBSOCKET')).not.toBeInTheDocument()
  })

  it('reports the card actions with the entry id or URL', () => {
    const { handlers } = renderRow()
    fireEvent.click(screen.getByText('https://api.test/v1/users?page=2'))
    expect(handlers.onToggleExpand).toHaveBeenCalledWith('log-1')

    fireEvent.click(screen.getByRole('button', { name: 'Mark for export' }))
    expect(handlers.onToggleExport).toHaveBeenCalledWith('log-1')

    fireEvent.click(screen.getByRole('button', { name: 'Block URL pattern' }))
    expect(handlers.onToggleBlock).toHaveBeenCalledWith('https://api.test/v1/users?page=2')

    fireEvent.click(screen.getByText('Rewrites'))
    expect(handlers.onToggleRewritesPin).toHaveBeenCalledWith('log-1')
    // The action buttons do not also toggle the card.
    expect(handlers.onToggleExpand).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Expand request details' }))
    expect(handlers.onToggleExpand).toHaveBeenCalledTimes(2)
  })

  it('reflects the export mark and the blocked state', () => {
    renderRow({ selectedForExport: true, blocked: true })
    expect(screen.getByRole('button', { name: 'Mark for export' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Unblock URL pattern' })).toBeInTheDocument()
  })

  it('hands the chosen file to the replace handler', () => {
    const { handlers, container } = renderRow()
    const input = container.querySelector('input[type="file"]')
    const file = new File(['{}'], 'reply.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(handlers.onReplaceResource).toHaveBeenCalledWith(baseLog, file)
  })

  it('loads the details when expanded', async () => {
    renderRow({ expanded: true })
    expect(await screen.findByTestId('log-detail')).toHaveTextContent('details of log-1')
    expect(screen.getByRole('button', { name: 'Collapse request details' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })
})
