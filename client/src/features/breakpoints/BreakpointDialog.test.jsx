import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BreakpointDialog from './BreakpointDialog'
import { ApiError, apiPost } from '../../lib/api'

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual('../../lib/api')
  return { ...actual, apiPost: vi.fn() }
})

const requestItem = {
  id: 'bp-1',
  phase: 'request',
  rule: { id: 'r1', name: 'Orders', url: '/orders' },
  createdAt: '2026-11-11T10:00:00.000Z',
  method: 'POST',
  url: 'https://api.test/orders',
  headers: { 'content-type': 'application/json' },
  body: '{"qty":1}',
  bodyBase64: null,
  bodyIsText: true,
  bodySize: 9,
  response: null
}

const responseItem = {
  ...requestItem,
  id: 'bp-2',
  phase: 'response',
  response: {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'x-upstream': 'yes' },
    body: '{"ok":true}',
    bodyBase64: null,
    bodyIsText: true,
    bodySize: 11,
    bodyDecoded: false
  }
}

function renderDialog(item) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <BreakpointDialog item={item} onClose={onClose} />
    </QueryClientProvider>
  )
  return { onClose }
}

describe('BreakpointDialog', () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset()
    vi.mocked(apiPost).mockResolvedValue({ success: true })
  })

  it('sends a paused request on with the edits', async () => {
    const { onClose } = renderDialog(requestItem)
    expect(screen.getByText('Request paused at a breakpoint')).toBeInTheDocument()
    expect(screen.getByLabelText('Method')).toHaveValue('POST')
    expect(screen.getByLabelText('URL')).toHaveValue('https://api.test/orders')
    expect(screen.getByLabelText('Body')).toHaveValue('{"qty":1}')

    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '{"qty":2}' } })
    fireEvent.change(screen.getByLabelText('Headers'), {
      target: { value: 'content-type: application/json\nx-bp: 1' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/breakpoints/pending/bp-1/resume', {
        headers: { 'content-type': 'application/json', 'x-bp': '1' },
        method: 'POST',
        url: 'https://api.test/orders',
        body: '{"qty":2}'
      })
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('sends a paused response on with a new status', async () => {
    const { onClose } = renderDialog(responseItem)
    expect(screen.getByText('Response paused at a breakpoint')).toBeInTheDocument()
    expect(screen.getByLabelText('Status code')).toHaveValue(200)
    expect(screen.getByLabelText('Body')).toHaveValue('{"ok":true}')

    fireEvent.change(screen.getByLabelText('Status code'), { target: { value: '418' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send response' }))

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/breakpoints/pending/bp-2/resume', {
        headers: { 'content-type': 'application/json', 'x-upstream': 'yes' },
        statusCode: 418,
        body: '{"ok":true}'
      })
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('aborts the flow', async () => {
    const { onClose } = renderDialog(requestItem)
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/breakpoints/pending/bp-1/abort'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('explains a flow that is no longer paused and keeps the editor open', async () => {
    vi.mocked(apiPost).mockRejectedValue(new ApiError(404, { error: 'gone' }, 'gone'))
    const { onClose } = renderDialog(requestItem)
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    expect(
      await screen.findByText(
        'This flow is no longer paused: it was resumed elsewhere or timed out.'
      )
    ).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('rejects malformed header lines and closes with Escape', () => {
    const { onClose } = renderDialog(requestItem)
    fireEvent.change(screen.getByLabelText('Headers'), { target: { value: 'nocolon' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    expect(screen.getByText('Line 1 is not "name: value"')).toBeInTheDocument()
    expect(apiPost).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
