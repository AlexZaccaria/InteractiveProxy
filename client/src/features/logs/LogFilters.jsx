import { useEffect, useId, useState } from 'react'
import { Check, ChevronDown, Filter, HelpCircle, Info, Search } from 'lucide-react'
import { FILE_TYPE_OPTIONS, METHOD_OPTIONS, SOURCE_OPTIONS } from './filters'
import Tooltip from '../../components/Tooltip'

/**
 * The filter bar: the three text searches with the syntax help, the
 * rewritten-only switches, and the source, method and file-type dropdowns.
 */

/** The id of the URL search field; the `/` shortcut focuses it. */
export const URL_SEARCH_INPUT_ID = 'log-search-url'

/**
 * The help icon of the URL search, with the syntax in its tooltip.
 */
function SearchSyntaxHelp() {
  return (
    <Tooltip
      title="Search syntax"
      description={
        <>
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
          <div className="mt-2 text-fg-muted space-y-1">
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
                api<span className="text-blue-400">;</span> <span className="text-red-400">!</span>
                facebook <span className="text-purple-400">||</span> users
                <span className="text-blue-400">;</span> <span className="text-red-400">!</span>
                tracking
              </code>
            </div>
          </div>
        </>
      }
      panelClassName="w-80 max-w-[calc(100vw-1rem)]"
      className="absolute right-2.5 top-1/2 -translate-y-1/2"
    >
      <button
        type="button"
        aria-label="Search syntax"
        className="inline-flex items-center text-fg-faint cursor-help hover:text-fg-body focus:outline-hidden focus-visible:text-fg-body"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  )
}

/**
 * A "rewritten only" switch with its tooltip.
 *
 * @param {Object} props
 * @param {'request' | 'response'} props.phase
 * @param {boolean} props.pressed
 * @param {() => void} props.onToggle
 */
function RewrittenOnlySwitch({ phase, pressed, onToggle }) {
  const request = phase === 'request'
  return (
    <Tooltip
      title={request ? 'Request rewrites' : 'Response rewrites'}
      description={`Show only ${request ? 'requests' : 'responses'} where rewrite rules were applied to the body or frames.`}
      className="shrink-0"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={pressed}
        aria-label={
          request ? 'Filter: only requests with rewrites' : 'Filter: only responses with rewrites'
        }
        className={`inline-flex items-center justify-center w-8 h-8 rounded-md border text-xs transition-colors ${
          pressed
            ? request
              ? 'bg-yellow-600/20 border-yellow-500/60 text-yellow-300'
              : 'bg-green-600/20 border-green-500/60 text-green-300'
            : request
              ? 'bg-surface border-edge text-fg-muted hover:border-yellow-500 hover:text-yellow-300'
              : 'bg-surface border-edge text-fg-muted hover:border-green-500 hover:text-green-300'
        }`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
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
  const id = useId()
  return (
    <label className="group flex items-center gap-2 px-3 py-2 hover:bg-surface-highlight cursor-pointer text-sm text-fg-body transition-colors">
      <span
        className={`w-4 h-4 rounded-md border flex items-center justify-center text-[10px] transition-colors ${
          checked
            ? 'bg-fg/10 border-fg-body text-fg-strong'
            : 'bg-surface-sunken border-edge text-fg-faint group-hover:text-fg-base group-hover:border-fg-muted'
        }`}
      >
        {checked && <Check className="w-3 h-3" />}
      </span>
      <input id={id} type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
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
        className="flex items-center gap-2 px-3 h-8 text-xs bg-surface border border-edge rounded-md text-fg-muted hover:border-fg-muted hover:text-fg-base focus:outline-hidden focus:ring-1 focus:ring-fg-muted w-full"
      >
        <Filter className="w-3.5 h-3.5" />
        <span>
          {label} ({count})
        </span>
        <ChevronDown className="w-3.5 h-3.5 ml-auto" />
      </button>

      {open && (
        <div
          className={`absolute top-full left-0 mt-1 bg-surface-raised border border-edge rounded-md shadow-xl z-10 ${menuClassName}`}
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
    <div className="bg-surface-raised rounded-lg p-4 border border-edge space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-fg-muted" />
          <label htmlFor={URL_SEARCH_INPUT_ID} className="sr-only">
            Search URL
          </label>
          <input
            type="text"
            id={URL_SEARCH_INPUT_ID}
            name="search-url"
            placeholder="Search URL..."
            value={searchTerm}
            onChange={event => onSearchTermChange(event.target.value)}
            className="w-full pl-8 pr-8 h-8 text-xs bg-surface border border-edge rounded text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-blue-500"
          />
          <SearchSyntaxHelp />
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-yellow-400" />
            <label htmlFor="log-search-request" className="sr-only">
              Search in request
            </label>
            <input
              type="text"
              id="log-search-request"
              name="search-request"
              placeholder="Search in request..."
              value={requestBodySearch}
              onChange={event => onRequestBodySearchChange(event.target.value)}
              className="w-full pl-8 pr-2 h-8 text-xs bg-surface border border-edge rounded text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-yellow-500"
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
            <label htmlFor="log-search-response" className="sr-only">
              Search in response
            </label>
            <input
              type="text"
              id="log-search-response"
              name="search-response"
              placeholder="Search in response..."
              value={responseSearchTerm}
              onChange={event => onResponseSearchTermChange(event.target.value)}
              className="w-full pl-8 pr-2 h-8 text-xs bg-surface border border-edge rounded text-fg placeholder-fg-faint focus:outline-hidden focus:ring-1 focus:ring-green-500"
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
          <div className="border-t border-edge my-1"></div>
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
