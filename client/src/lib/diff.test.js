import { describe, expect, it } from 'vitest'
import { diffLines, splitLines, stringifyForDiff } from './diff'

describe('diffLines', () => {
  it('pairs a changed line and keeps the common head and tail', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc')
    expect(diff.tooLarge).toBe(false)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.rows).toEqual([
      { kind: 'equal', left: 'a', right: 'a', leftNumber: 1, rightNumber: 1 },
      { kind: 'changed', left: 'b', right: 'B', leftNumber: 2, rightNumber: 2 },
      { kind: 'equal', left: 'c', right: 'c', leftNumber: 3, rightNumber: 3 }
    ])
  })

  it('shows additions and removals on their side only', () => {
    const added = diffLines('a\nc', 'a\nb\nc')
    expect(added.rows).toEqual([
      { kind: 'equal', left: 'a', right: 'a', leftNumber: 1, rightNumber: 1 },
      { kind: 'added', left: null, right: 'b', leftNumber: null, rightNumber: 2 },
      { kind: 'equal', left: 'c', right: 'c', leftNumber: 2, rightNumber: 3 }
    ])
    const removed = diffLines('a\nb\nc', 'a\nc')
    expect(removed.rows?.[1]).toEqual({
      kind: 'removed',
      left: 'b',
      right: null,
      leftNumber: 2,
      rightNumber: null
    })
    expect(removed.removed).toBe(1)
    expect(removed.added).toBe(0)
  })

  it('handles identical, empty and wholly different texts', () => {
    expect(diffLines('x\ny', 'x\ny')).toEqual({
      rows: [
        { kind: 'equal', left: 'x', right: 'x', leftNumber: 1, rightNumber: 1 },
        { kind: 'equal', left: 'y', right: 'y', leftNumber: 2, rightNumber: 2 }
      ],
      tooLarge: false,
      added: 0,
      removed: 0
    })
    expect(diffLines('', 'new')).toEqual({
      rows: [{ kind: 'added', left: null, right: 'new', leftNumber: null, rightNumber: 1 }],
      tooLarge: false,
      added: 1,
      removed: 0
    })
    const replaced = diffLines('one\ntwo', 'three')
    expect(replaced.rows).toEqual([
      { kind: 'changed', left: 'one', right: 'three', leftNumber: 1, rightNumber: 1 },
      { kind: 'removed', left: 'two', right: null, leftNumber: 2, rightNumber: null }
    ])
  })

  it('uses the longest common subsequence in the middle', () => {
    const diff = diffLines('h\n1\n2\n3\nt', 'h\n2\n4\n3\nt')
    expect(diff.rows?.map(row => row.kind)).toEqual([
      'equal',
      'removed',
      'equal',
      'added',
      'equal',
      'equal'
    ])
  })

  it('refuses texts beyond the line limit', () => {
    const big = Array.from({ length: 11 }, (_, index) => `line ${index}`).join('\n')
    expect(diffLines(big, 'x', { maxLines: 10 })).toEqual({
      rows: null,
      tooLarge: true,
      added: 0,
      removed: 0
    })
  })

  it('splits CRLF text and stringifies values for the comparison', () => {
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
    expect(stringifyForDiff({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(stringifyForDiff(undefined)).toBe('undefined')
  })
})
