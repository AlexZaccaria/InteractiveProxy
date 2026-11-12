import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CurlCommandDialog from './CurlCommandDialog'

const command = "curl -X POST 'https://api.test/items' \\\n  --data-raw '{}'"

describe('CurlCommandDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the command selected and copies it on request', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onClose = vi.fn()
    render(<CurlCommandDialog command={command} onClose={onClose} />)

    const textarea = screen.getByLabelText('curl command')
    expect(textarea).toHaveValue(command)
    expect(textarea).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
