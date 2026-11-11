import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Breakpoints, { phaseLabel } from './Breakpoints'
import { apiGet, apiPost } from '../../lib/api'

vi.mock('../../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }))

const rules = [
  { id: 'r1', enabled: true, name: 'Orders', url: '/orders', phase: 'request' },
  { id: 'r2', enabled: false, name: '/users', url: '/users', phase: 'both' }
]

const pending = [
  {
    id: 'bp-1',
    phase: 'response',
    rule: { id: 'r1', name: 'Orders', url: '/orders' },
    createdAt: '2026-11-11T10:00:00.000Z',
    method: 'GET',
    url: 'https://api.test/orders/1',
    headers: {},
    body: null,
    bodyBase64: null,
    bodyIsText: true,
    bodySize: 0,
    response: null
  }
]

function renderTab(props = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  const onOpenPending = vi.fn()
  const showConfirm = vi.fn().mockResolvedValue(true)
  render(
    <QueryClientProvider client={client}>
      <Breakpoints
        showConfirm={showConfirm}
        pending={[]}
        onOpenPending={onOpenPending}
        {...props}
      />
    </QueryClientProvider>
  )
  return { onOpenPending, showConfirm }
}

describe('Breakpoints tab', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
    vi.mocked(apiGet).mockResolvedValue(rules)
  })

  it('lists the rules with their phase and the paused flows', async () => {
    const { onOpenPending } = renderTab({ pending })
    expect(await screen.findByText('/orders')).toBeInTheDocument()
    expect(screen.getByText('Orders · Request')).toBeInTheDocument()
    expect(screen.getAllByText('Request and response')).toHaveLength(2)
    expect(screen.getByText('2 rules · 1 paused')).toBeInTheDocument()
    expect(screen.getByText('https://api.test/orders/1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenPending).toHaveBeenCalledWith(pending[0])
    expect(phaseLabel('response')).toBe('Response')
  })

  it('adds a rule from the form', async () => {
    vi.mocked(apiPost).mockResolvedValue({
      success: true,
      breakpointRules: [
        ...rules,
        { id: 'r3', enabled: true, name: 'Checkout', url: '/checkout', phase: 'response' }
      ]
    })
    renderTab()
    await screen.findByText('/orders')

    fireEvent.change(screen.getByLabelText('URL pattern'), { target: { value: ' /checkout ' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Checkout' } })
    fireEvent.change(screen.getByLabelText('Pause'), { target: { value: 'response' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add breakpoint' }))

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/breakpoints', {
        action: 'add',
        url: '/checkout',
        name: 'Checkout',
        phase: 'response'
      })
    )
    expect(await screen.findByText('/checkout')).toBeInTheDocument()
    expect(screen.getByLabelText('URL pattern')).toHaveValue('')
  })

  it('refuses an empty pattern, toggles and removes rules', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, breakpointRules: rules })
    const { showConfirm } = renderTab()
    await screen.findByText('/orders')

    fireEvent.click(screen.getByRole('button', { name: 'Add breakpoint' }))
    expect(screen.getByText('A URL pattern is required')).toBeInTheDocument()
    expect(apiPost).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0])
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/breakpoints', {
        action: 'update',
        id: 'r1',
        enabled: false
      })
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1])
    await waitFor(() => expect(showConfirm).toHaveBeenCalled())
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/breakpoints', { action: 'remove', id: 'r2' })
    )
  })
})
