import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReplayDialog, { formatBytes, formatHeaderLines, parseHeaderLines } from './ReplayDialog'
import { apiGet, apiPost } from '../../lib/api'

vi.mock('../../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }))

const log = {
  id: 'log-1',
  timestamp: '2026-11-11T10:00:00.000Z',
  method: 'POST',
  source: 'mitm',
  url: '/items'
}

const textDescription = {
  method: 'POST',
  url: 'https://api.test/items',
  headers: { 'content-type': 'application/json', 'x-custom': 'a' },
  body: '{"name":"one"}',
  bodyBase64: null,
  bodyIsText: true,
  bodySize: 14,
  bodyCaptured: true,
  bodyExpected: true,
  bodyNotKeptBytes: 0
}

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <ReplayDialog log={log} onClose={onClose} />
    </QueryClientProvider>
  )
  return { onClose }
}

describe('parseHeaderLines', () => {
  it('reads name: value lines and skips blank ones', () => {
    expect(parseHeaderLines('a: 1\n\n  b:  two words \r\n')).toEqual({
      headers: { a: '1', b: 'two words' },
      error: null
    })
    expect(parseHeaderLines('')).toEqual({ headers: {}, error: null })
  })

  it('reports the line that is not a header', () => {
    expect(parseHeaderLines('a: 1\nnocolon').error).toBe('Line 2 is not "name: value"')
    expect(parseHeaderLines('bad name: 1').error).toBe(
      'Line 1: "bad name" is not a valid header name'
    )
  })

  it('formats headers back into lines', () => {
    expect(formatHeaderLines({ a: '1', b: '2' })).toBe('a: 1\nb: 2')
    expect(formatHeaderLines(undefined)).toBe('')
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('ReplayDialog', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
  })

  it('fills the form from the entry and sends the edits', async () => {
    vi.mocked(apiGet).mockResolvedValue(textDescription)
    vi.mocked(apiPost).mockResolvedValue({
      success: true,
      statusCode: 201,
      responseBytes: 2048,
      durationMs: 42,
      logId: 'log-2'
    })
    renderDialog()

    const url = await screen.findByLabelText('URL')
    expect(apiGet).toHaveBeenCalledWith('/api/logs/log-1/replay', expect.anything())
    expect(url).toHaveValue('https://api.test/items')
    expect(screen.getByLabelText('Method')).toHaveValue('POST')
    expect(screen.getByLabelText('Headers')).toHaveValue(
      'content-type: application/json\nx-custom: a'
    )
    expect(screen.getByLabelText('Body')).toHaveValue('{"name":"one"}')

    fireEvent.change(screen.getByLabelText('Headers'), {
      target: { value: 'content-type: application/json\nx-custom: b' }
    })
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '{"name":"two"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/logs/log-1/replay', {
        method: 'POST',
        url: 'https://api.test/items',
        headers: { 'content-type': 'application/json', 'x-custom': 'b' },
        body: '{"name":"two"}'
      })
    )
    expect(await screen.findByText('Sent: 201 · 2.0 KB · 42 ms')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send again' })).toBeInTheDocument()
  })

  it('rejects a malformed header line without sending', async () => {
    vi.mocked(apiGet).mockResolvedValue(textDescription)
    renderDialog()
    await screen.findByLabelText('URL')

    fireEvent.change(screen.getByLabelText('Headers'), { target: { value: 'nocolon' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('Line 1 is not "name: value"')).toBeInTheDocument()
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('sends a binary body as captured and says so', async () => {
    vi.mocked(apiGet).mockResolvedValue({
      ...textDescription,
      body: null,
      bodyBase64: 'AAEC',
      bodyIsText: false,
      bodySize: 3
    })
    vi.mocked(apiPost).mockResolvedValue({
      success: true,
      statusCode: 200,
      responseBytes: 10,
      durationMs: 5,
      logId: null
    })
    renderDialog()
    await screen.findByLabelText('URL')

    expect(screen.getByText(/Binary body of 3 B/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/logs/log-1/replay', {
        method: 'POST',
        url: 'https://api.test/items',
        headers: { 'content-type': 'application/json', 'x-custom': 'a' },
        bodyBase64: 'AAEC'
      })
    )
  })

  it('points out a body that was not kept and sends without one', async () => {
    vi.mocked(apiGet).mockResolvedValue({
      ...textDescription,
      body: null,
      bodyCaptured: false,
      bodySize: 0,
      bodyNotKeptBytes: 4 * 1024 * 1024
    })
    vi.mocked(apiPost).mockResolvedValue({
      success: true,
      statusCode: 200,
      responseBytes: 0,
      durationMs: 1,
      logId: null
    })
    renderDialog()
    await screen.findByLabelText('URL')

    expect(
      screen.getByText(/was not kept \(4\.0 MB, over the retention limit\)/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/logs/log-1/replay',
        expect.objectContaining({ body: null })
      )
    )
  })

  it('shows the failure of a replay', async () => {
    vi.mocked(apiGet).mockResolvedValue(textDescription)
    vi.mocked(apiPost).mockRejectedValue(new Error('Replay failed: connect ECONNREFUSED'))
    renderDialog()
    await screen.findByLabelText('URL')

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Replay failed: connect ECONNREFUSED')).toBeInTheDocument()
  })

  it('closes with Escape and with the close button', async () => {
    vi.mocked(apiGet).mockResolvedValue(textDescription)
    const { onClose } = renderDialog()
    await screen.findByLabelText('URL')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close the replay form' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
