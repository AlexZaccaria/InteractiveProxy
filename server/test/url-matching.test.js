'use strict'

/**
 * Characterization tests for the URL matching helpers shared by text and
 * JSONPath edit rules, plus the host pattern and display-name helpers.
 * Behavior is asserted as observed in server/index.js; oddities are marked
 * "current behavior".
 */

const { test, describe, before } = require('node:test')
const assert = require('node:assert/strict')
const { loadServer } = require('./helpers/load-server')

let internals

before(async () => {
  const loaded = await loadServer()
  internals = loaded.proxy.internals
})

describe('getCachedUrlParse', () => {
  test('returns lower-cased host and the pathname of absolute URLs, null otherwise', () => {
    assert.deepEqual(internals.getCachedUrlParse('https://Foo.COM:8443/A/B?q'), { host: 'foo.com', path: '/A/B' })
    assert.equal(internals.getCachedUrlParse('nope'), null)
    assert.equal(internals.getCachedUrlParse(''), null)
    assert.equal(internals.getCachedUrlParse(undefined), null)
  })

  test('the same URL in different case shares one cache entry', () => {
    const first = internals.getCachedUrlParse('https://cache.example.com/X')
    const second = internals.getCachedUrlParse('HTTPS://CACHE.EXAMPLE.COM/X')
    assert.equal(first, second)
  })
})

describe('buildUrlMatchCandidatesFromContext / buildUrlMatchContext', () => {
  test('absolute URLs yield host and pathname, relative paths keep the raw value as path', () => {
    const candidates = internals.buildUrlMatchCandidatesFromContext({
      requestUrl: '/v1/users/123?x=1',
      fullUrl: 'https://API.example.com/v1/users/123?x=1'
    })
    assert.deepEqual(candidates, [
      // current behavior: the relative candidate keeps the query string in its path
      { raw: '/v1/users/123?x=1', host: null, path: '/v1/users/123?x=1' },
      { raw: 'https://api.example.com/v1/users/123?x=1', host: 'api.example.com', path: '/v1/users/123' }
    ])
  })

  test('non-URL values keep raw only; unparsable http strings have no host/path; empty context gives none', () => {
    assert.deepEqual(internals.buildUrlMatchCandidatesFromContext({ requestUrl: 'Login?x' }), [{ raw: 'login?x', host: null, path: null }])
    assert.deepEqual(internals.buildUrlMatchCandidatesFromContext({ fullUrl: 'http://' }), [{ raw: 'http://', host: null, path: null }])
    assert.deepEqual(internals.buildUrlMatchCandidatesFromContext({}), [])
    assert.deepEqual(internals.buildUrlMatchCandidatesFromContext({ requestUrl: 5, fullUrl: '  ' }), [])
  })

  test('buildUrlMatchContext keeps the context fields and adds candidates', () => {
    const context = internals.buildUrlMatchContext({ requestUrl: '/a', phase: 'response' })
    assert.equal(context.phase, 'response')
    assert.equal(context.requestUrl, '/a')
    assert.deepEqual(context.candidates, [{ raw: '/a', host: null, path: '/a' }])
    assert.deepEqual(internals.buildUrlMatchContext(null).candidates, [])
  })
})

describe('urlPatternMatchesCandidates', () => {
  let candidates

  before(() => {
    candidates = internals.buildUrlMatchContext({
      requestUrl: '/v1/users/123?x=1',
      fullUrl: 'https://API.example.com/v1/users/123?x=1'
    }).candidates
  })

  const matches = pattern => internals.urlPatternMatchesCandidates(pattern, candidates)

  test('absolute patterns match by host and exact path or path prefix', () => {
    assert.equal(matches('https://api.example.com/v1/users'), true)
    assert.equal(matches('https://api.example.com/v1/users/'), true)
    assert.equal(matches('http://api.example.com/v1/users/123'), true) // scheme is ignored
    assert.equal(matches('https://api.example.com/v1/users/123?x=1'), true) // query ignored on the pattern
    assert.equal(matches('https://api.example.com/'), true)
    assert.equal(matches('https://api.example.com'), true)
    assert.equal(matches('https://api.example.com/v1/user'), false) // prefix is segment-based
  })

  test('an absolute pattern with another host still matches through the relative candidate', () => {
    // current behavior: the requestUrl candidate has host null, so the host
    // check is skipped and the path prefix alone decides
    assert.equal(matches('https://other.com/v1/users'), true)
    const absoluteOnly = internals.buildUrlMatchContext({ fullUrl: 'https://api.example.com/v1/users/123' }).candidates
    assert.equal(internals.urlPatternMatchesCandidates('https://other.com/v1/users', absoluteOnly), false)
  })

  test('path patterns match by exact path or segment prefix', () => {
    assert.equal(matches('/v1/users'), true)
    assert.equal(matches('/'), true)
    assert.equal(matches('/v1/user'), false)
    // trailing slash on the pattern requires that exact path or a deeper one
    assert.equal(matches('/v1/users/123/'), false)
    assert.equal(internals.urlPatternMatchesCandidates('/v1/users/123/', internals.buildUrlMatchContext({ fullUrl: 'https://h/v1/users/123/' }).candidates), true)
  })

  test('other patterns are case-insensitive substrings of the raw values', () => {
    assert.equal(matches('USERS'), true)
    assert.equal(matches('example.com'), true)
    assert.equal(matches('x=1'), true)
    assert.equal(matches('nomatch'), false)
  })

  test('blank pattern or no candidates never match', () => {
    assert.equal(matches('  '), false)
    assert.equal(internals.urlPatternMatchesCandidates('/v1', []), false)
    assert.equal(internals.urlPatternMatchesCandidates('/v1', null), false)
  })

  test('urlPatternMatchesContext builds the candidates itself', () => {
    assert.equal(internals.urlPatternMatchesContext('/v1/users', { requestUrl: '/v1/users/9' }), true)
    assert.equal(internals.urlPatternMatchesContext('/v1/users', {}), false)
  })
})

describe('textRuleMatchesUrl / jsonPathRuleMatchesUrl', () => {
  test('text rules without a URL match everything, JSONPath rules without a URL match nothing', () => {
    const context = internals.buildUrlMatchContext({ requestUrl: '/v1/x' })
    assert.equal(internals.textRuleMatchesUrl({ url: '' }, context), true)
    assert.equal(internals.textRuleMatchesUrl(null, context), true)
    assert.equal(internals.textRuleMatchesUrl({ url: '  ' }, {}), true)
    assert.equal(internals.jsonPathRuleMatchesUrl({ url: '' }, context), false)
  })

  test('both accept a precomputed match context or a raw context', () => {
    const context = internals.buildUrlMatchContext({ requestUrl: '/v1/users/9' })
    assert.equal(internals.textRuleMatchesUrl({ url: '/v1' }, context), true)
    assert.equal(internals.textRuleMatchesUrl({ url: '/v1' }, { requestUrl: '/v1/x' }), true)
    assert.equal(internals.textRuleMatchesUrl({ url: '/v1' }, {}), false)
    assert.equal(internals.jsonPathRuleMatchesUrl({ url: 'users' }, context), true)
    assert.equal(internals.jsonPathRuleMatchesUrl({ url: 'users' }, { requestUrl: '/v1/users' }), true)
    assert.equal(internals.jsonPathRuleMatchesUrl({ url: 'users' }, { requestUrl: '/v1/x' }), false)
  })
})

describe('deriveDisplayNameFromUrlPattern', () => {
  test('uses the last two host labels, capitalized; paths give an empty name', () => {
    assert.equal(internals.deriveDisplayNameFromUrlPattern('https://api.example.com/v1/users'), 'Example.com')
    assert.equal(internals.deriveDisplayNameFromUrlPattern('example.com'), 'Example.com')
    assert.equal(internals.deriveDisplayNameFromUrlPattern('api.example.co.uk/path'), 'Co.uk')
    assert.equal(internals.deriveDisplayNameFromUrlPattern('localhost:3000/foo'), 'Localhost')
    assert.equal(internals.deriveDisplayNameFromUrlPattern('login'), 'Login')
    assert.equal(internals.deriveDisplayNameFromUrlPattern('/v1/users'), '')
    assert.equal(internals.deriveDisplayNameFromUrlPattern(''), '')
    assert.equal(internals.deriveDisplayNameFromUrlPattern(null), '')
  })
})

describe('hostPatternMatches', () => {
  test('matches the host itself and its subdomains; ".suffix" form is equivalent; no wildcards; case-sensitive', () => {
    assert.equal(internals.hostPatternMatches('example.com', 'example.com'), true)
    assert.equal(internals.hostPatternMatches('example.com', 'api.example.com'), true)
    assert.equal(internals.hostPatternMatches('.example.com', 'example.com'), true)
    assert.equal(internals.hostPatternMatches('.example.com', 'api.example.com'), true)
    assert.equal(internals.hostPatternMatches('example.com', 'notexample.com'), false)
    assert.equal(internals.hostPatternMatches('*.example.com', 'api.example.com'), false)
    assert.equal(internals.hostPatternMatches('Example.COM', 'example.com'), false)
    assert.equal(internals.hostPatternMatches('', 'x'), false)
    assert.equal(internals.hostPatternMatches('x', ''), false)
  })
})
