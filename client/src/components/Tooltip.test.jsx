import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Tooltip, { TOOLTIP_OPEN_DELAY_MS, computeTooltipPosition } from './Tooltip'

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const advance = ms => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  function renderTooltip(props = {}) {
    return render(
      <Tooltip title="Export logs" description="Writes the current view to a file." {...props}>
        <button type="button" aria-label="Export logs">
          E
        </button>
      </Tooltip>
    )
  }

  it('opens after the hover delay and links the trigger to the panel', () => {
    renderTooltip()
    const trigger = screen.getByRole('button', { name: 'Export logs' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(trigger.parentElement)
    advance(TOOLTIP_OPEN_DELAY_MS - 1)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    advance(1)

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Export logs')
    expect(tooltip).toHaveTextContent('Writes the current view to a file.')
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)
    expect(tooltip.parentElement).toBe(document.body)
  })

  it('does not open when the pointer leaves before the delay, and closes on leave', () => {
    renderTooltip()
    const anchor = screen.getByRole('button', { name: 'Export logs' }).parentElement
    fireEvent.mouseEnter(anchor)
    advance(50)
    fireEvent.mouseLeave(anchor)
    advance(TOOLTIP_OPEN_DELAY_MS)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(anchor)
    advance(TOOLTIP_OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.mouseLeave(anchor)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('opens at once on focus and closes on blur or Escape', () => {
    renderTooltip()
    const trigger = screen.getByRole('button', { name: 'Export logs' })
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.blur(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(trigger).not.toHaveAttribute('aria-describedby')
  })

  it('stays closed through a pointer press and the focus it gives', () => {
    renderTooltip()
    const trigger = screen.getByRole('button', { name: 'Export logs' })
    const anchor = trigger.parentElement
    fireEvent.mouseEnter(anchor)
    advance(TOOLTIP_OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseDown(trigger)
    fireEvent.focus(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // Leaving and coming back arms the tooltip again.
    fireEvent.mouseLeave(anchor)
    fireEvent.mouseEnter(anchor)
    advance(TOOLTIP_OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('shows on a disabled trigger through the wrapping span', () => {
    render(
      <Tooltip title="Export logs" description="Nothing to export yet.">
        <button type="button" disabled aria-label="Export logs">
          E
        </button>
      </Tooltip>
    )
    const anchor = screen.getByRole('button', { name: 'Export logs' }).parentElement
    expect(anchor).toHaveClass('tooltip-anchor', 'cursor-not-allowed')
    fireEvent.mouseEnter(anchor)
    advance(TOOLTIP_OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Nothing to export yet.')
  })

  it('renders a title-only panel and a custom description node', () => {
    render(
      <>
        <Tooltip title="Remove" open>
          <button type="button">a</button>
        </Tooltip>
        <Tooltip title="Applied rewrites" description={<ul data-testid="list" />} open>
          <button type="button">b</button>
        </Tooltip>
      </>
    )
    const [plain, custom] = screen.getAllByRole('tooltip')
    expect(plain).toHaveTextContent('Remove')
    expect(plain.querySelector('p')).toBeNull()
    expect(custom).toContainElement(screen.getByTestId('list'))
  })

  it('follows the open prop: true keeps it open, false keeps it closed', () => {
    const { rerender } = renderTooltip({ open: true })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    rerender(
      <Tooltip title="Export logs" open={false}>
        <button type="button" aria-label="Export logs">
          E
        </button>
      </Tooltip>
    )
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: 'Export logs' }))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('does not let clicks inside the panel reach the trigger container', () => {
    const onClick = vi.fn()
    render(
      <div onClick={onClick}>
        <Tooltip title="Applied rewrites" description={<button type="button">inner</button>} open>
          <button type="button">badge</button>
        </Tooltip>
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'inner' }))
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'badge' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('computeTooltipPosition', () => {
  const viewport = { width: 1000, height: 600 }
  const panel = { width: 200, height: 80 }
  const anchor = { top: 100, bottom: 130, left: 500, right: 540, height: 30 }

  it('places bottom-end under the trigger with the right edges aligned', () => {
    expect(computeTooltipPosition(anchor, panel, 'bottom-end', viewport)).toEqual({
      top: 138,
      left: 340
    })
  })

  it('aligns the left edges for the start placements', () => {
    expect(computeTooltipPosition(anchor, panel, 'bottom-start', viewport).left).toBe(500)
    expect(computeTooltipPosition(anchor, panel, 'top-start', viewport)).toEqual({
      top: 12,
      left: 500
    })
  })

  it('flips above when there is no room below, and below when there is none above', () => {
    const low = { top: 560, bottom: 590, left: 500, right: 540, height: 30 }
    expect(computeTooltipPosition(low, panel, 'bottom-end', viewport).top).toBe(472)
    const high = { top: 10, bottom: 40, left: 500, right: 540, height: 30 }
    expect(computeTooltipPosition(high, panel, 'top-end', viewport).top).toBe(48)
  })

  it('clamps into the viewport margins', () => {
    const edge = { top: 100, bottom: 130, left: 0, right: 40, height: 30 }
    expect(computeTooltipPosition(edge, panel, 'bottom-end', viewport).left).toBe(8)
    const farRight = { top: 100, bottom: 130, left: 980, right: 1000, height: 30 }
    expect(computeTooltipPosition(farRight, panel, 'bottom-start', viewport).left).toBe(792)
  })

  it('places right next to the trigger, centred, and swaps sides when there is no room', () => {
    expect(computeTooltipPosition(anchor, panel, 'right', viewport)).toEqual({
      top: 75,
      left: 548
    })
    const farRight = { top: 100, bottom: 130, left: 900, right: 940, height: 30 }
    expect(computeTooltipPosition(farRight, panel, 'right', viewport).left).toBe(692)
  })
})
