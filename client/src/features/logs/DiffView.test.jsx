import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import DiffView from './DiffView'

describe('DiffView', () => {
  it('shows the lines side by side with the counts', () => {
    render(<DiffView before={'{\n  "a": 1\n}'} after={'{\n  "a": 2\n}'} />)
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    expect(screen.getByText('"a": 1')).toBeInTheDocument()
    expect(screen.getByText('"a": 2')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.getByText('Before rewrite')).toBeInTheDocument()
    expect(screen.getByText('After rewrite')).toBeInTheDocument()
  })

  it('says when there is nothing to show', () => {
    render(<DiffView before="same" after="same" leftLabel="Old" rightLabel="New" />)
    expect(screen.getByText('No differences.')).toBeInTheDocument()
    expect(screen.getByText('Old')).toBeInTheDocument()
  })
})
