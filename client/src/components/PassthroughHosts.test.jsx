import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PassthroughHosts from './PassthroughHosts'
import { apiGet, apiPost } from '../lib/api'

vi.mock('../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }))

const rules = [
  { id: 'p1', enabled: true, name: 'Bank', host: 'bank.example' },
  { id: 'p2', enabled: false, name: 'pinned.test', host: 'pinned.test' }
]

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  const showConfirm = vi.fn().mockResolvedValue(true)
  render(
    <QueryClientProvider client={client}>
      <PassthroughHosts showConfirm={showConfirm} />
    </QueryClientProvider>
  )
  return { showConfirm }
}

describe('PassthroughHosts', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
    vi.mocked(apiGet).mockResolvedValue(rules)
  })

  it('lists the hosts and adds one from the form', async () => {
    vi.mocked(apiPost).mockResolvedValue({
      success: true,
      passthroughRules: [
        ...rules,
        { id: 'p3', enabled: true, name: 'api.pinned', host: 'api.pinned' }
      ]
    })
    renderCard()
    expect(await screen.findByText('bank.example')).toBeInTheDocument()
    expect(screen.getByText('Bank')).toBeInTheDocument()
    expect(screen.getByText(/2 hosts/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add host' }))
    expect(screen.getByText('A host name is required')).toBeInTheDocument()
    expect(apiPost).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Host (subdomains included)'), {
      target: { value: ' api.pinned ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }))
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/passthrough', {
        action: 'add',
        host: 'api.pinned',
        name: ''
      })
    )
    expect(await screen.findByText('api.pinned')).toBeInTheDocument()
  })

  it('toggles and removes hosts', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, passthroughRules: rules })
    const { showConfirm } = renderCard()
    await screen.findByText('bank.example')

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/passthrough', {
        action: 'update',
        id: 'p2',
        enabled: true
      })
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    await waitFor(() => expect(showConfirm).toHaveBeenCalled())
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/passthrough', { action: 'remove', id: 'p1' })
    )
  })
})
