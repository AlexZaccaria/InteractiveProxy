import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { JsonBeforeAfter } from './JsonTree'

describe('JsonBeforeAfter', () => {
  it('switches between the trees and the diff', () => {
    render(
      <JsonBeforeAfter
        before={{ title: 'old' }}
        after={{ title: 'new' }}
        contextLabel="Response JSON body"
        urlPattern="https://a.test/x"
        target="response"
      />
    )
    expect(screen.getByText('After rewrite')).toBeInTheDocument()
    expect(screen.getByText('Before rewrite')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Diff' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('"title": "old"')).toBeInTheDocument()
    expect(screen.getByText('"title": "new"')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Diff' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Trees' }))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
