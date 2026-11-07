import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import RuleCard from './RuleCard'

/** @typedef {import('../../lib/types').EditRule} EditRule */

/** @type {EditRule} */
const textRule = {
  id: 'rule-1',
  kind: 'text',
  name: 'Rename title',
  enabled: true,
  useRegex: true,
  caseSensitive: true,
  url: 'example.com',
  target: 'response',
  startVariants: ['<title>', '<title>', ' <TITLE>'],
  endVariants: ['</title>'],
  replacement: 'Proxied Domain'
}

const preset = {
  id: 'preset-1',
  name: 'Preset one',
  kind: /** @type {const} */ ('text'),
  rule: { replacement: 'Proxied Domain', target: /** @type {const} */ ('response') },
  createdAt: '2026-11-07T00:00:00.000Z'
}

function renderCard(overrides = {}) {
  const handlers = {
    onApplyPreset: vi.fn(),
    onDeletePreset: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn()
  }
  const props = {
    rule: textRule,
    usageCount: 1,
    editing: false,
    presetGroups: [],
    presetValue: '',
    presetsLoading: false,
    applyingPreset: false,
    toggling: false,
    deleting: false,
    deleteDisabled: false,
    ...handlers,
    ...overrides
  }
  const view = render(<RuleCard {...props} />)
  return { ...view, handlers }
}

describe('RuleCard', () => {
  it('shows the name, the badges, the usage count and the markers', () => {
    renderCard()
    expect(screen.getByText('Rename title')).toBeInTheDocument()
    expect(screen.getByText('Response')).toBeInTheDocument()
    expect(screen.getByTitle('Logged entries this rule modified')).toHaveTextContent('1 hit')
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument()
    expect(screen.getByText('Start markers:')).toBeInTheDocument()
    expect(screen.getAllByText('<title>')).toHaveLength(1)
    expect(screen.getByText('<TITLE>')).toBeInTheDocument()
    expect(screen.getByText('</title>')).toBeInTheDocument()
    expect(screen.getByText('Proxied Domain')).toBeInTheDocument()
    expect(screen.getByText('Regex')).toBeInTheDocument()
    expect(screen.getByText('Case Sensitive')).toBeInTheDocument()
    expect(screen.getByText('Apply preset')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply preset' })).toBeDisabled()
  })

  it('shows the disabled state, the plural count and the default name', () => {
    renderCard({
      rule: { ...textRule, name: '', enabled: false, target: undefined },
      usageCount: 3
    })
    expect(screen.getByText('Unnamed Rule')).toBeInTheDocument()
    expect(screen.getByText('Disabled')).toBeInTheDocument()
    expect(screen.getByText('Request')).toBeInTheDocument()
    expect(screen.getByTitle('Logged entries this rule modified')).toHaveTextContent('3 hits')
  })

  it('hides the usage badge until the count is known', () => {
    renderCard({ usageCount: undefined })
    expect(screen.queryByTitle('Logged entries this rule modified')).not.toBeInTheDocument()
  })

  it('shows the path and the file source of a JSONPath rule', () => {
    renderCard({
      rule: {
        id: 'rule-2',
        kind: 'jsonPath',
        name: 'User',
        enabled: true,
        target: 'both',
        path: 'data.user.name',
        valueSource: { type: 'file', path: 'C:\\data\\value.txt' }
      }
    })
    expect(screen.getByText('Both')).toBeInTheDocument()
    expect(screen.getByText('Path:')).toBeInTheDocument()
    expect(screen.getByText('data.user.name')).toBeInTheDocument()
    expect(screen.getByText('(File Content) value.txt')).toBeInTheDocument()
    expect(screen.queryByText('Start markers:')).not.toBeInTheDocument()
  })

  it('collapses a long replacement and expands it on click', () => {
    const long = 'x'.repeat(350)
    renderCard({ rule: { ...textRule, replacement: long } })
    const toggle = screen.getByRole('button', { name: /Expand/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('x'.repeat(300) + '…')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByText(long)).toBeInTheDocument()
    expect(screen.getByText('Collapse')).toBeInTheDocument()
  })

  it('calls the handlers of the actions and applies a preset', () => {
    const { handlers } = renderCard({ presetGroups: [['Response', [preset]]] })
    fireEvent.click(screen.getByTitle('Disable'))
    fireEvent.click(screen.getByTitle('Edit'))
    fireEvent.click(screen.getByTitle('Remove'))
    expect(handlers.onToggle).toHaveBeenCalledTimes(1)
    expect(handlers.onEdit).toHaveBeenCalledTimes(1)
    expect(handlers.onDelete).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }))
    fireEvent.click(screen.getByRole('option', { name: 'Preset one' }))
    expect(handlers.onApplyPreset).toHaveBeenCalledWith('preset-1')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('shows the selected preset and deletes it from the menu', () => {
    const { handlers } = renderCard({
      presetGroups: [['Response', [preset]]],
      presetValue: 'preset-1'
    })
    const trigger = screen.getByRole('button', { name: 'Preset one' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByTitle('Delete preset'))
    expect(handlers.onDeletePreset).toHaveBeenCalledWith('preset-1')
    expect(handlers.onApplyPreset).not.toHaveBeenCalled()
  })

  it('disables the actions while they are pending', () => {
    renderCard({ toggling: true, deleting: true, deleteDisabled: false })
    expect(screen.getByTitle('Disable')).toBeDisabled()
    expect(screen.getByTitle('Remove')).toBeDisabled()
  })

  it('disables the delete button while a rule is being created', () => {
    renderCard({ deleteDisabled: true })
    expect(screen.getByTitle('Remove')).toBeDisabled()
    expect(screen.getByTitle('Disable')).not.toBeDisabled()
  })
})
