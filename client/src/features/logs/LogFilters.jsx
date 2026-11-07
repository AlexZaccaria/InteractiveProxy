import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Filter, HelpCircle, Info, Search } from 'lucide-react'
import { FILE_TYPE_OPTIONS, METHOD_OPTIONS, SOURCE_OPTIONS } from './filters'

/**
 * The filter bar: the three text searches with the syntax help, the
 * rewritten-only switches, and the source, method and file-type dropdowns.
 */

/**
 * The help tooltip of the URL search, rendered in a portal under its icon.
 */
function SearchSyntaxHelp() {
  const [show, setShow] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const anchorRef = useRef(null)
  const hideTimeoutRef = useRef(null)

  const updatePosition = useCallback(() => {
    const element = anchorRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const tooltipWidth = 256 // w-64
    const margin = 8
    setPosition({ top: rect.bottom + margin, left: Math.max(8, rect.right - tooltipWidth) })
  }, [])

  const cancelHide = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
  }, [])

  const scheduleHide = useCallback(() => {
    cancelHide()
    hideTimeoutRef.current = setTimeout(() => setShow(false), 150)
  }, [cancelHide])

  useEffect(() => cancelHide, [cancelHide])

  return (
    <>
      <div
        className="absolute right-2.5 top-1/2 transform -translate-y-1/2"
        ref={anchorRef}
        onMouseEnter={() => {
          cancelHide()
          updatePosition()
          setShow(true)
        }}
        onMouseLeave={scheduleHide}
      >
        <HelpCircle className="w-3.5 h-3.5 text-slate-500 cursor-help hover:text-slate-300" />
      </div>
      {show &&
        createPortal(
          <div
            className="fixed w-80 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-3 text-[11px] text-slate-300 shadow-2xl"
            style={{ zIndex: 99999, top: position.top, left: position.left }}
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
          >
            <div className="font-semibold mb-2">Search syntax:</div>
            <div className="space-y-1">
              <div>
                <code className="text-blue-400">;</code> - AND (all terms in a group)
              </div>
              <div>
                <code className="text-red-400">!</code> - NOT (exclude term)
              </div>
              <div>
                <code className="text-purple-400">||</code> - OR (between groups)
              </div>
            </div>
            <div className="mt-2 text-slate-400 space-y-1">
              <div className="whitespace-nowrap">
                Eg (AND/NOT):{' '}
                <code>
                  <span className="text-red-400">!</span>facebook
                  <span className="text-blue-400">;</span> <span className="text-red-400">!</span>
                  scontent
                  <span className="text-blue-400">;</span> api
                </code>
              </div>
              <div className="whitespace-nowrap">
                Eg (OR):{' '}
                <code>
                  api<span className="text-blue-400">;</span>{' '}
                  <span className="text-red-400">!</span>facebook{' '}
                  <span className="text-purple-400">||</span> users
                  <span className="text-blue-400">;</span> <span className="text-red-400">!</span>
                  tracking
                </code>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

/**
 * A "rewritten only" switch with its hover tooltip. The Tailwind group
 * names must be literal, hence one branch per colour.
 *
 * @param {Object} props
 * @param {'request' | 'response'} props.phase
 * @param {boolean} props.pressed
 * @param {() => void} props.onToggle
 */
function RewrittenOnlySwitch({ phase, pressed, onToggle }) {
  if (phase === 'request') {
    return (
      <div className="relative group/request-rewrites shrink-0">
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={pressed}
          aria-label="Filter: only requests with rewrites"
          className={`inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
            pressed
              ? 'bg-yellow-600/20 border-yellow-500/60 text-yellow-300'
              : 'bg-[#0a0a0a] border-[#2a2a2a] text-slate-400 hover:border-yellow-500 hover:text-yellow-300'
          }`}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
        <div
          className="invisible group-hover/request-rewrites:visible absolute right-0 top-full mt-1 w-60 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-2 text-[11px] text-slate-300 shadow-2xl"
          style={{ zIndex: 99999 }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide text-yellow-400 mb-1">
            Request rewrites
          </div>
          <div>Show only requests where rewrite rules were applied to the body or frames.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative group/response-rewrites shrink-0">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={pressed}
        aria-label="Filter: only responses with rewrites"
        className={`inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
          pressed
            ? 'bg-green-600/20 border-green-500/60 text-green-300'
            : 'bg-[#0a0a0a] border-[#2a2a2a] text-slate-400 hover:border-green-500 hover:text-green-300'
        }`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      <div
        className="invisible group-hover/response-rewrites:visible absolute right-0 top-full mt-1 w-60 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-2 text-[11px] text-slate-300 shadow-2xl"
        style={{ zIndex: 99999 }}
      >
        <div className="text-[10px] font-semibold uppercase tracking-wide text-green-400 mb-1">
          Response rewrites
        </div>
        <div>Show only responses where rewrite rules were applied to the body or frames.</div>
      </div>
    </div>
  )
}

/**
 * A checkbox row of a dropdown menu.
 *
 * @param {Object} props
 * @param {string} props.label
 * @param {boolean} props.checked
 * @param {() => void} props.onChange
 * @param {string} [props.labelClassName]
 */
function CheckboxOption({ label, checked, onChange, labelClassName = '' }) {
  return (
    <label className="group flex items-center gap-2 px-3 py-2 hover:bg-[#2a2a2a] cursor-pointer text-sm text-slate-300 transition-colors">
      <span
        className={`w-4 h-4 rounded-md border flex items-center justify-center text-[10px] transition-colors ${
          checked
            ? 'bg-slate-100/10 border-slate-300 text-slate-100'
            : 'bg-[#050508] border-[#2a2a2a] text-slate-500 group-hover:text-slate-200 group-hover:border-slate-400'
        }`}
      >
        {checked && <Check className="w-3 h-3" />}
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
      <span className={labelClassName}>{label}</span>
    </label>
  )
}

/**
 * A dropdown of checkboxes; `children` are extra rows after the options.
 *
 * @param {Object} props
 * @param {string} props.label
 * @param {number} props.count
 * @param {boolean} props.open
 * @param {() => void} props.onToggleOpen
 * @param {string} props.menuClassName
 * @param {import('react').ReactNode} props.children
 */
function FilterDropdown({ label, count, open, onToggleOpen, menuClassName, children }) {
  return (
    <div className="relative dropdown-container">
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={open}
        className="flex items-center gap-2 px-3 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded-md text-slate-400 hover:border-slate-400 hover:text-slate-200 focus:outline-hidden focus:ring-1 focus:ring-slate-400 w-full"
      >
        <Filter className="w-3.5 h-3.5" />
        <span>
          {label} ({count})
        </span>
        <ChevronDown className="w-3.5 h-3.5 ml-auto" />
      </button>

      {open && (
        <div
          className={`absolute top-full left-0 mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-md shadow-xl z-10 ${menuClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * @param {Object} props
 * @param {string} props.searchTerm
 * @param {string} props.requestBodySearch
 * @param {string} props.responseSearchTerm
 * @param {(value: string) => void} props.onSearchTermChange
 * @param {(value: string) => void} props.onRequestBodySearchChange
 * @param {(value: string) => void} props.onResponseSearchTermChange
 * @param {boolean} props.requestRewrittenOnly
 * @param {boolean} props.responseRewrittenOnly
 * @param {() => void} props.onToggleRequestRewrittenOnly
 * @param {() => void} props.onToggleResponseRewrittenOnly
 * @param {string[]} props.selectedSources
 * @param {string[]} props.selectedMethods
 * @param {string[]} props.selectedFileTypes
 * @param {boolean} props.showWsConnections
 * @param {(source: string) => void} props.onToggleSource
 * @param {(method: string) => void} props.onToggleMethod
 * @param {(fileType: string) => void} props.onToggleFileType
 * @param {(value: boolean) => void} props.onShowWsConnectionsChange
 */
export default function LogFilters({
  searchTerm,
  requestBodySearch,
  responseSearchTerm,
  onSearchTermChange,
  onRequestBodySearchChange,
  onResponseSearchTermChange,
  requestRewrittenOnly,
  responseRewrittenOnly,
  onToggleRequestRewrittenOnly,
  onToggleResponseRewrittenOnly,
  selectedSources,
  selectedMethods,
  selectedFileTypes,
  showWsConnections,
  onToggleSource,
  onToggleMethod,
  onToggleFileType,
  onShowWsConnectionsChange
}) {
  /** @type {[('sources' | 'methods' | 'fileTypes' | null), Function]} */
  const [openDropdown, setOpenDropdown] = useState(null)

  // A click outside any dropdown closes the open one.
  useEffect(() => {
    const handleMouseDown = event => {
      if (!(event.target instanceof Element) || !event.target.closest('.dropdown-container')) {
        setOpenDropdown(null)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [])

  const toggleDropdown = name => setOpenDropdown(current => (current === name ? null : name))

  return (
    <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a] space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search URL..."
            aria-label="Search URL"
            value={searchTerm}
            onChange={event => onSearchTermChange(event.target.value)}
            className="w-full pl-8 pr-8 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500"
          />
          <SearchSyntaxHelp />
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-yellow-400" />
            <input
              type="text"
              placeholder="Search in request..."
              aria-label="Search in request"
              value={requestBodySearch}
              onChange={event => onRequestBodySearchChange(event.target.value)}
              className="w-full pl-8 pr-2 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-yellow-500"
            />
          </div>
          <RewrittenOnlySwitch
            phase="request"
            pressed={requestRewrittenOnly}
            onToggle={onToggleRequestRewrittenOnly}
          />
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-green-400" />
            <input
              type="text"
              placeholder="Search in response..."
              aria-label="Search in response"
              value={responseSearchTerm}
              onChange={event => onResponseSearchTermChange(event.target.value)}
              className="w-full pl-8 pr-2 h-8 text-xs bg-[#0a0a0a] border border-[#2a2a2a] rounded text-white placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-green-500"
            />
          </div>
          <RewrittenOnlySwitch
            phase="response"
            pressed={responseRewrittenOnly}
            onToggle={onToggleResponseRewrittenOnly}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <FilterDropdown
          label="Sources"
          count={selectedSources.length}
          open={openDropdown === 'sources'}
          onToggleOpen={() => toggleDropdown('sources')}
          menuClassName="min-w-[160px]"
        >
          {SOURCE_OPTIONS.map(source => (
            <CheckboxOption
              key={source.key}
              label={source.label}
              checked={selectedSources.includes(source.key)}
              onChange={() => onToggleSource(source.key)}
            />
          ))}
        </FilterDropdown>

        <FilterDropdown
          label="Methods"
          count={selectedMethods.length}
          open={openDropdown === 'methods'}
          onToggleOpen={() => toggleDropdown('methods')}
          menuClassName="min-w-[180px]"
        >
          {METHOD_OPTIONS.map(method => (
            <CheckboxOption
              key={method}
              label={method}
              checked={selectedMethods.includes(method)}
              onChange={() => onToggleMethod(method)}
            />
          ))}
          <div className="border-t border-[#2a2a2a] my-1"></div>
          <CheckboxOption
            label="WS Connection Status"
            labelClassName="text-xs"
            checked={showWsConnections}
            onChange={() => onShowWsConnectionsChange(!showWsConnections)}
          />
        </FilterDropdown>

        <FilterDropdown
          label="Types"
          count={selectedFileTypes.length}
          open={openDropdown === 'fileTypes'}
          onToggleOpen={() => toggleDropdown('fileTypes')}
          menuClassName="min-w-[140px]"
        >
          {FILE_TYPE_OPTIONS.map(type => (
            <CheckboxOption
              key={type.key}
              label={type.label}
              checked={selectedFileTypes.includes(type.key)}
              onChange={() => onToggleFileType(type.key)}
            />
          ))}
        </FilterDropdown>
      </div>
    </div>
  )
}
