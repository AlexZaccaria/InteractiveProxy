import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'

/** Delay between the pointer entering the trigger and the panel opening. */
export const TOOLTIP_OPEN_DELAY_MS = 150
/** Space between the trigger and the panel. */
const GAP = 8
/** Minimum distance between the panel and the edges of the viewport. */
const VIEWPORT_MARGIN = 8

/** @typedef {'bottom-end' | 'bottom-start' | 'top-end' | 'top-start' | 'right'} TooltipPlacement */

/**
 * Where to put the panel: the requested placement, flipped to the opposite
 * side when there is no room there, then clamped into the viewport.
 *
 * @param {{ top: number, bottom: number, left: number, right: number, height: number }} anchor
 * @param {{ width: number, height: number }} panel
 * @param {TooltipPlacement} placement
 * @param {{ width: number, height: number }} viewport
 * @returns {{ top: number, left: number }}
 */
export function computeTooltipPosition(anchor, panel, placement, viewport) {
  /** @type {(value: number, min: number, max: number) => number} */
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max))
  let top
  let left
  if (placement === 'right') {
    left = anchor.right + GAP
    const roomRight = left + panel.width <= viewport.width - VIEWPORT_MARGIN
    const leftSide = anchor.left - GAP - panel.width
    if (!roomRight && leftSide >= VIEWPORT_MARGIN) left = leftSide
    top = anchor.top + anchor.height / 2 - panel.height / 2
  } else {
    const [side, align] = placement.split('-')
    const below = anchor.bottom + GAP
    const above = anchor.top - GAP - panel.height
    const roomBelow = below + panel.height <= viewport.height - VIEWPORT_MARGIN
    const roomAbove = above >= VIEWPORT_MARGIN
    if (side === 'bottom') top = roomBelow || !roomAbove ? below : above
    else top = roomAbove || !roomBelow ? above : below
    left = align === 'start' ? anchor.left : anchor.right - panel.width
  }
  return {
    top: clamp(top, VIEWPORT_MARGIN, viewport.height - panel.height - VIEWPORT_MARGIN),
    left: clamp(left, VIEWPORT_MARGIN, viewport.width - panel.width - VIEWPORT_MARGIN)
  }
}

/**
 * The one tooltip of the UI. The trigger is wrapped in an inline span that
 * listens for the pointer and the focus, so it also works on disabled
 * buttons (which get `pointer-events: none` through `.tooltip-anchor`).
 * The panel opens 150 ms after the pointer enters, at once on keyboard
 * focus, and closes when the pointer leaves, on blur, on Escape and when
 * the trigger is pressed. It is rendered in a portal at the end of the
 * body, positioned from the trigger's bounding box, and the trigger is
 * linked to it with `aria-describedby` while it is open.
 *
 * @param {Object} props
 * @param {string} props.title
 * @param {import('react').ReactNode} [props.description] A string renders as a paragraph; any other node as-is.
 * @param {TooltipPlacement} [props.placement] Default `bottom-end`: under the trigger, right edges aligned.
 * @param {boolean} [props.open] `true` keeps the panel open, `false` keeps it closed; unset leaves it to the pointer and the focus.
 * @param {boolean} [props.inline] Wrap the trigger as plain inline text instead of an `inline-flex` box.
 * @param {string} [props.className] Extra classes of the wrapping span.
 * @param {string} [props.panelClassName] The width classes of the panel, `max-w-64` by default.
 * @param {import('react').ReactNode} props.children The trigger. A single element receives `aria-describedby`.
 */
function Tooltip({
  title,
  description,
  placement = 'bottom-end',
  open,
  inline = false,
  className = '',
  panelClassName = 'max-w-64',
  children
}) {
  const id = useId()
  const anchorRef = useRef(/** @type {HTMLSpanElement | null} */ (null))
  const panelRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const timerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null))
  // Set when the trigger is pressed with the pointer, until the pointer
  // leaves: the panel stays closed through the click and the focus it gives.
  const suppressedRef = useRef(false)
  const [shown, setShown] = useState(false)
  const [position, setPosition] = useState(
    /** @type {{ top: number, left: number } | null} */ (null)
  )

  const visible = open === true || (open !== false && shown)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])
  const hide = useCallback(() => {
    clearTimer()
    setShown(false)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  const handleMouseEnter = () => {
    if (suppressedRef.current) return
    clearTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setShown(true)
    }, TOOLTIP_OPEN_DELAY_MS)
  }
  const handleMouseLeave = () => {
    suppressedRef.current = false
    hide()
  }
  const handleFocus = () => {
    if (suppressedRef.current) return
    clearTimer()
    setShown(true)
  }
  const handleMouseDown = () => {
    suppressedRef.current = true
    hide()
  }

  // The panel is measured once rendered, then placed; it follows the
  // trigger through scrolling and resizing while it is open.
  useLayoutEffect(() => {
    if (!visible) {
      setPosition(null)
      return undefined
    }
    const update = () => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (!anchor || !panel) return
      setPosition(
        computeTooltipPosition(
          anchor.getBoundingClientRect(),
          { width: panel.offsetWidth, height: panel.offsetHeight },
          placement,
          { width: window.innerWidth, height: window.innerHeight }
        )
      )
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [visible, placement, title, description])

  useEffect(() => {
    if (!visible || open === true) return undefined
    /** @param {KeyboardEvent} event */
    const handleKeyDown = event => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [visible, open, hide])

  /** @type {{ disabled?: boolean, 'aria-describedby'?: string }} */
  const childProps = isValidElement(children) ? /** @type {any} */ (children.props) : {}
  const disabled = Boolean(childProps.disabled)
  const trigger = isValidElement(children)
    ? cloneElement(/** @type {import('react').ReactElement<any>} */ (children), {
        'aria-describedby': visible ? id : childProps['aria-describedby']
      })
    : children

  // Clicks inside the panel (the pinned rewrites list, for example) must
  // not reach the card the trigger sits in: portals bubble React events.
  /** @param {import('react').SyntheticEvent} event */
  const stopPropagation = event => event.stopPropagation()

  return (
    <>
      <span
        ref={anchorRef}
        className={`tooltip-anchor ${inline ? 'inline' : 'inline-flex'} ${
          disabled ? 'cursor-not-allowed' : ''
        } ${className}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseDown={handleMouseDown}
        onFocus={handleFocus}
        onBlur={hide}
      >
        {trigger}
      </span>
      {visible &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            className={`fixed z-9999 w-max rounded-lg border border-edge bg-surface-raised text-xs text-fg-body shadow-2xl ${
              description ? 'p-3' : 'px-2.5 py-1.5'
            } ${panelClassName}`}
            style={
              position
                ? { top: position.top, left: position.left }
                : { top: 0, left: 0, visibility: 'hidden' }
            }
            onClick={stopPropagation}
            onMouseDown={stopPropagation}
          >
            <div className={`font-semibold text-fg-base ${description ? 'mb-1' : ''}`}>{title}</div>
            {typeof description === 'string' ? <p>{description}</p> : description}
          </div>,
          document.body
        )}
    </>
  )
}

export default Tooltip
