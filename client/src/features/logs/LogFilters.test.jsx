import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LogFilters from './LogFilters'

function renderFilters(overrides = {}) {
  const handlers = {
    onSearchTermChange: vi.fn(),
    onRequestBodySearchChange: vi.fn(),
    onResponseSearchTermChange: vi.fn(),
    onToggleRequestRewrittenOnly: vi.fn(),
    onToggleResponseRewrittenOnly: vi.fn(),
    onToggleSource: vi.fn(),
    onToggleMethod: vi.fn(),
    onToggleFileType: vi.fn(),
    onShowWsConnectionsChange: vi.fn()
  }
  const props = {
    searchTerm: '',
    requestBodySearch: '',
    responseSearchTerm: '',
    requestRewrittenOnly: false,
    responseRewrittenOnly: false,
    selectedSources: ['proxied', 'mitm', 'websocket', 'imported'],
    selectedMethods: ['GET', 'POST'],
    selectedFileTypes: ['json'],
    showWsConnections: false,
    ...handlers,
    ...overrides
  }
  const view = render(<LogFilters {...props} />)
  return { ...view, handlers }
}

describe('LogFilters', () => {
  it('shows the three searches with their values and reports typing', () => {
    const { handlers } = renderFilters({ searchTerm: 'api', requestBodySearch: 'tok' })
    expect(screen.getByLabelText('Search URL')).toHaveValue('api')
    expect(screen.getByLabelText('Search in request')).toHaveValue('tok')
    expect(screen.getByLabelText('Search in response')).toHaveValue('')

    fireEvent.change(screen.getByLabelText('Search in response'), { target: { value: 'ok' } })
    expect(handlers.onResponseSearchTermChange).toHaveBeenCalledWith('ok')
    fireEvent.change(screen.getByLabelText('Search URL'), { target: { value: 'x' } })
    expect(handlers.onSearchTermChange).toHaveBeenCalledWith('x')
  })

  it('shows the counts of the dropdowns', () => {
    renderFilters()
    expect(screen.getByRole('button', { name: 'Sources (4)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Methods (2)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Types (1)' })).toBeInTheDocument()
  })

  it('opens one dropdown at a time and toggles its options', () => {
    const { handlers } = renderFilters()
    expect(screen.queryByLabelText('OPTIONS')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Methods (2)' }))
    expect(screen.getByLabelText('GET')).toBeChecked()
    expect(screen.getByLabelText('OPTIONS')).not.toBeChecked()

    fireEvent.click(screen.getByLabelText('OPTIONS'))
    expect(handlers.onToggleMethod).toHaveBeenCalledWith('OPTIONS')

    fireEvent.click(screen.getByLabelText('WS Connection Status'))
    expect(handlers.onShowWsConnectionsChange).toHaveBeenCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: 'Sources (4)' }))
    expect(screen.queryByLabelText('OPTIONS')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('HTTPS'))
    expect(handlers.onToggleSource).toHaveBeenCalledWith('mitm')

    fireEvent.mouseDown(document.body)
    expect(screen.queryByLabelText('HTTPS')).not.toBeInTheDocument()
  })

  it('exposes the rewritten-only switches as pressed buttons', () => {
    const { handlers } = renderFilters({ responseRewrittenOnly: true })
    const requestSwitch = screen.getByRole('button', {
      name: 'Filter: only requests with rewrites'
    })
    const responseSwitch = screen.getByRole('button', {
      name: 'Filter: only responses with rewrites'
    })
    expect(requestSwitch).toHaveAttribute('aria-pressed', 'false')
    expect(responseSwitch).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(requestSwitch)
    expect(handlers.onToggleRequestRewrittenOnly).toHaveBeenCalledTimes(1)
  })
})
