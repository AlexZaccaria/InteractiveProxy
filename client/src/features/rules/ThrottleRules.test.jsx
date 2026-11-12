import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ThrottleRules, { describeConditions } from './ThrottleRules'
import { apiGet, apiPost } from '../../lib/api'

vi.mock('../../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }))

const rules = [
  { id: 'n1', enabled: true, name: 'Search', url: '/search', delayMs: 300, throttleKbps: 0 },
  { id: 'n2', enabled: false, name: '/images', url: '/images', delayMs: 0, throttleKbps: 64 }
]

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  const showConfirm = vi.fn().mockResolvedValue(true)
  render(
    <QueryClientProvider client={client}>
      <ThrottleRules showConfirm={showConfirm} />
    </QueryClientProvider>
  )
  return { showConfirm }
}

describe('ThrottleRules', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
    vi.mocked(apiGet).mockResolvedValue(rules)
  })

  it('lists the rules with their conditions', async () => {
    renderCard()
    expect(await screen.findByText('/search')).toBeInTheDocument()
    expect(screen.getByText('Search · +300 ms')).toBeInTheDocument()
    expect(screen.getByText('64 kbps')).toBeInTheDocument()
    expect(describeConditions({ delayMs: 100, throttleKbps: 8 })).toBe('+100 ms · 8 kbps')
  })

  it('validates the form and adds a rule', async () => {
    vi.mocked(apiPost).mockResolvedValue({
      success: true,
      throttleRules: [
        ...rules,
        { id: 'n3', enabled: true, name: 'Slow API', url: '/api', delayMs: 500, throttleKbps: 32 }
      ]
    })
    renderCard()
    await screen.findByText('/search')

    fireEvent.click(screen.getByRole('button', { name: 'Add conditions' }))
    expect(screen.getByText('A URL pattern is required')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('URL pattern'), { target: { value: '/api' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add conditions' }))
    expect(screen.getByText('A latency or a bandwidth cap is required')).toBeInTheDocument()
    expect(apiPost).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Slow API' } })
    fireEvent.change(screen.getByLabelText('Latency (ms)'), { target: { value: '500' } })
    fireEvent.change(screen.getByLabelText('Bandwidth (kbps)'), { target: { value: '32' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add conditions' }))

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/throttle', {
        action: 'add',
        url: '/api',
        name: 'Slow API',
        delayMs: 500,
        throttleKbps: 32
      })
    )
    expect(await screen.findByText('/api')).toBeInTheDocument()
    expect(screen.getByLabelText('URL pattern')).toHaveValue('')
  })

  it('toggles and removes rules', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, throttleRules: rules })
    const { showConfirm } = renderCard()
    await screen.findByText('/search')

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/throttle', {
        action: 'update',
        id: 'n1',
        enabled: false
      })
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1])
    await waitFor(() => expect(showConfirm).toHaveBeenCalled())
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/throttle', { action: 'remove', id: 'n2' })
    )
  })
})
