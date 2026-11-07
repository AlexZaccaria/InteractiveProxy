import {
  AlertCircle,
  File,
  FileCode,
  FileJson,
  FileText,
  Film,
  Globe,
  HardDrive,
  Image,
  Link as LinkIcon,
  Music,
  ShieldAlert
} from 'lucide-react'

/**
 * The icons and the colour classes of a card's badges.
 */

/** @param {{ source: string }} props */
export function SourceIcon({ source }) {
  switch (source) {
    case 'local':
      return <HardDrive className="w-4 h-4 text-green-400" />
    case 'proxied':
      return <Globe className="w-4 h-4 text-purple-400" />
    case 'websocket':
      return <Globe className="w-4 h-4 text-yellow-400" />
    case 'tunnel':
      return <Globe className="w-4 h-4 text-blue-400" />
    case 'blocked':
      return <ShieldAlert className="w-4 h-4 text-orange-400" />
    case 'error':
      return <AlertCircle className="w-4 h-4 text-red-400" />
    default:
      return <LinkIcon className="w-4 h-4 text-slate-400" />
  }
}

const SOURCE_BADGES = {
  local: 'bg-green-500/20 text-green-400 border-green-500/30',
  proxied: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  mitm: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  tunnel: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  blocked: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  error: 'bg-red-500/20 text-red-400 border-red-500/30',
  websocket: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
}

/**
 * @param {string} source
 * @returns {string}
 */
export function getSourceBadgeClass(source) {
  return SOURCE_BADGES[source] || SOURCE_BADGES.websocket
}

const METHOD_BADGES = {
  GET: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  POST: 'bg-green-500/20 text-green-400 border-green-500/30',
  PUT: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  DELETE: 'bg-red-500/20 text-red-400 border-red-500/30',
  PATCH: 'bg-orange-500/20 text-orange-400 border-orange-500/30'
}

/**
 * @param {string} method
 * @returns {string}
 */
export function getMethodBadgeClass(method) {
  return METHOD_BADGES[method] || 'bg-slate-500/20 text-slate-400 border-slate-500/30'
}

/**
 * @param {string | undefined} statusCode
 * @returns {string}
 */
export function getStatusBadgeClass(statusCode) {
  const code = Number(statusCode)
  return code >= 200 && code < 300
    ? 'bg-green-500/20 text-green-400 border-green-500/30'
    : 'bg-red-500/20 text-red-400 border-red-500/30'
}

/**
 * The icon, the label and the colour of the content-type badge.
 *
 * @param {{ fileType?: string }} log
 * @returns {{ icon: import('react').ComponentType<{ className?: string }>, label: string, color: string }}
 */
export function getContentTypeInfo(log) {
  switch (log.fileType || 'other') {
    case 'json':
      return { icon: FileJson, label: 'JSON', color: 'text-yellow-400' }
    case 'html':
      return { icon: FileText, label: 'HTML', color: 'text-orange-400' }
    case 'css':
      return { icon: FileCode, label: 'CSS', color: 'text-blue-400' }
    case 'js':
      return { icon: FileCode, label: 'JS', color: 'text-amber-400' }
    case 'image':
      return { icon: Image, label: 'IMG', color: 'text-purple-400' }
    case 'video':
      return { icon: Film, label: 'VIDEO', color: 'text-pink-400' }
    case 'audio':
      return { icon: Music, label: 'AUDIO', color: 'text-green-400' }
    case 'font':
      return { icon: FileText, label: 'FONT', color: 'text-pink-400' }
    default:
      return { icon: File, label: 'FILE', color: 'text-slate-400' }
  }
}

/**
 * The direction badge of a WebSocket entry, with the host in place of
 * "server".
 *
 * @param {{ direction?: string, fullUrl?: string, url: string }} log
 * @returns {string}
 */
export function formatDirection(log) {
  const direction = log.direction || ''
  if (!direction.includes('→')) return direction
  try {
    const { hostname } = new URL(log.fullUrl || log.url)
    return direction.replace('server', hostname)
  } catch {
    return direction
  }
}
