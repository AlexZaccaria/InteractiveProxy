import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LocalResources from './LocalResources'
import { apiGet, apiPost } from '../lib/api'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api')
  return { ...actual, apiGet: vi.fn(), apiPost: vi.fn(), apiUpload: vi.fn(), apiDelete: vi.fn() }
})

const folderResource = {
  url: '/static',
  type: 'folder',
  filename: '',
  contentType: '',
  path: 'C:\\site\\dist',
  fallthrough: true,
  createdAt: '2026-11-11T10:00:00.000Z',
  enabled: true
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <LocalResources showConfirm={vi.fn().mockResolvedValue(true)} />
    </QueryClientProvider>
  )
}

describe('LocalResources folder mapping', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
  })

  it('lists a mapped folder with its path', async () => {
    vi.mocked(apiGet).mockResolvedValue([folderResource])
    renderTab()
    expect(await screen.findByText('/static')).toBeInTheDocument()
    expect(screen.getByText('Folder')).toBeInTheDocument()
    expect(screen.getByText('falls through')).toBeInTheDocument()
    expect(screen.getByText('Folder: C:\\site\\dist')).toBeInTheDocument()
  })

  it('maps a folder from the form', async () => {
    vi.mocked(apiGet).mockResolvedValue([])
    vi.mocked(apiPost).mockResolvedValue({ success: true })
    renderTab()
    await screen.findByText('No local resources')

    fireEvent.click(screen.getByRole('button', { name: 'Add Resource' }))
    fireEvent.click(screen.getByRole('button', { name: 'Folder' }))
    fireEvent.change(screen.getByLabelText('URL to intercept'), { target: { value: '/static' } })
    fireEvent.change(screen.getByLabelText("Folder on the proxy's machine"), {
      target: { value: ' C:\\site\\dist ' }
    })
    fireEvent.click(
      screen.getByLabelText(
        'Forward to the upstream when the file is missing (otherwise answer 404)'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add resource' }))

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/resources', {
        url: '/static',
        folderPath: 'C:\\site\\dist',
        fallthrough: true
      })
    )
    expect(await screen.findByText('Resource added successfully!')).toBeInTheDocument()
  })

  it('refuses an empty folder path', async () => {
    vi.mocked(apiGet).mockResolvedValue([])
    renderTab()
    await screen.findByText('No local resources')
    fireEvent.click(screen.getByRole('button', { name: 'Add Resource' }))
    fireEvent.click(screen.getByRole('button', { name: 'Folder' }))
    fireEvent.change(screen.getByLabelText('URL to intercept'), { target: { value: '/static' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add resource' }))
    expect(await screen.findByText('Enter the folder to map')).toBeInTheDocument()
    expect(apiPost).not.toHaveBeenCalled()
  })
})
