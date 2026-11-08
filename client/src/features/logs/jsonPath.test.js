import { describe, expect, it } from 'vitest'
import {
  buildJsonPathFromKeyPath,
  buildJsonPathRuleSeed,
  extractEndpointNameFromUrlPattern,
  formatJsonValueForRule,
  isJsonTreeRootNode,
  isNumericJsonKey,
  resolveJsonValueFromKeyPath
} from './jsonPath'

describe('isNumericJsonKey', () => {
  it('accepts non-negative integers and digit strings', () => {
    expect(isNumericJsonKey(0)).toBe(true)
    expect(isNumericJsonKey(7)).toBe(true)
    expect(isNumericJsonKey('12')).toBe(true)
    expect(isNumericJsonKey(' 3 ')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isNumericJsonKey(-1)).toBe(false)
    expect(isNumericJsonKey(1.5)).toBe(false)
    expect(isNumericJsonKey('')).toBe(false)
    expect(isNumericJsonKey('1a')).toBe(false)
    expect(isNumericJsonKey(null)).toBe(false)
  })
})

describe('buildJsonPathFromKeyPath', () => {
  it('drops the root label and prefixes root', () => {
    expect(buildJsonPathFromKeyPath(['root'])).toBe('root')
    expect(buildJsonPathFromKeyPath(['f1', 'root'])).toBe('root.f1')
  })

  it('turns numeric keys into indexes', () => {
    expect(buildJsonPathFromKeyPath(['0', 'items', 'root'])).toBe('root.items[0]')
    expect(buildJsonPathFromKeyPath(['name', 2, 'items', 'data', 'root'])).toBe(
      'root.data.items[2].name'
    )
  })

  it('answers root for an empty or invalid key path', () => {
    expect(buildJsonPathFromKeyPath([])).toBe('root')
    expect(buildJsonPathFromKeyPath(/** @type {any} */ (undefined))).toBe('root')
  })
})

describe('resolveJsonValueFromKeyPath', () => {
  const data = { items: [{ name: 'a' }, { name: 'b' }], flag: false, nothing: null }

  it('walks objects and arrays', () => {
    expect(resolveJsonValueFromKeyPath(data, ['name', 1, 'items', 'root'])).toBe('b')
    expect(resolveJsonValueFromKeyPath(data, ['flag', 'root'])).toBe(false)
    expect(resolveJsonValueFromKeyPath(data, ['nothing', 'root'])).toBe(null)
  })

  it('answers the root for an empty key path and undefined for a missing one', () => {
    expect(resolveJsonValueFromKeyPath(data, [])).toBe(data)
    expect(resolveJsonValueFromKeyPath(data, ['missing', 'root'])).toBeUndefined()
    expect(resolveJsonValueFromKeyPath(data, ['x', 5, 'items', 'root'])).toBeUndefined()
    expect(resolveJsonValueFromKeyPath(data, ['x', 'flag', 'root'])).toBeUndefined()
    expect(resolveJsonValueFromKeyPath(null, ['flag', 'root'])).toBeUndefined()
  })
})

describe('extractEndpointNameFromUrlPattern', () => {
  it('takes the last path segment without query and hash', () => {
    expect(extractEndpointNameFromUrlPattern('https://h/api/GetChatMessage?x=1#f')).toBe(
      'GetChatMessage'
    )
    expect(extractEndpointNameFromUrlPattern('/api/v1/users/')).toBe('users')
  })

  it('answers the empty string for non-strings and the cleaned pattern without segments', () => {
    expect(extractEndpointNameFromUrlPattern('')).toBe('')
    expect(extractEndpointNameFromUrlPattern(undefined)).toBe('')
    expect(extractEndpointNameFromUrlPattern('///')).toBe('')
  })
})

describe('isJsonTreeRootNode', () => {
  it('recognises the synthetic root labels only at the top', () => {
    expect(isJsonTreeRootNode(['root'])).toBe(true)
    expect(isJsonTreeRootNode(['$'])).toBe(true)
    expect(isJsonTreeRootNode(['root', 'root'])).toBe(false)
    expect(isJsonTreeRootNode(['name'])).toBe(false)
  })
})

describe('formatJsonValueForRule', () => {
  it('keeps primitives, pretty-prints objects, blanks null', () => {
    expect(formatJsonValueForRule('x')).toBe('x')
    expect(formatJsonValueForRule(3)).toBe('3')
    expect(formatJsonValueForRule(true)).toBe('true')
    expect(formatJsonValueForRule(null)).toBe('')
    expect(formatJsonValueForRule({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

describe('buildJsonPathRuleSeed', () => {
  const rootData = { user: { name: 'Ann', tags: ['x'] } }

  it('names the rule after the endpoint and defaults the target to request', () => {
    const seed = buildJsonPathRuleSeed({
      keyPath: ['name', 'user', 'root'],
      rootData,
      urlPattern: 'https://api.test/v1/GetUser?x=1',
      contextLabel: 'Request JSON body'
    })
    expect(seed).toEqual({
      kind: 'jsonPath',
      path: 'root.user.name',
      valueType: 'string',
      value: 'Ann',
      name: 'GetUser: root.user.name',
      url: 'https://api.test/v1/GetUser?x=1',
      target: 'request'
    })
  })

  it('falls back to the context label and keeps response and both targets', () => {
    const seed = buildJsonPathRuleSeed({
      keyPath: ['tags', 'user', 'root'],
      rootData,
      urlPattern: '',
      contextLabel: 'Response JSON body',
      target: 'both'
    })
    expect(seed.name).toBe('Response JSON body: root.user.tags')
    expect(seed.value).toBe('[\n  "x"\n]')
    expect(seed.target).toBe('both')
    expect(
      buildJsonPathRuleSeed({ keyPath: ['a', 'root'], rootData, target: 'response' }).target
    ).toBe('response')
    expect(
      buildJsonPathRuleSeed({ keyPath: ['a', 'root'], rootData, target: 'other' }).target
    ).toBe('request')
  })
})
