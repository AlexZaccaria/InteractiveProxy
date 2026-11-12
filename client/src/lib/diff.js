/**
 * Line diff for the side-by-side view of a body before and after a
 * rewrite: a longest-common-subsequence over the lines that differ once
 * the common head and tail are set aside, with removed and added runs
 * paired row by row.
 */

/**
 * @typedef {Object} DiffRow
 * @property {'equal' | 'removed' | 'added' | 'changed'} kind
 * @property {string | null} left The line before, null when the row only adds.
 * @property {string | null} right The line after, null when the row only removes.
 * @property {number | null} leftNumber 1-based line number before.
 * @property {number | null} rightNumber 1-based line number after.
 */

/**
 * @typedef {Object} LineDiff
 * @property {DiffRow[] | null} rows Null when the texts are too large to diff.
 * @property {boolean} tooLarge
 * @property {number} added
 * @property {number} removed
 */

/** Bodies with more lines than this on either side are not diffed. */
export const MAX_DIFF_LINES = 4000

/** Cells of the LCS table above which the middle is shown as a replacement. */
const MAX_LCS_CELLS = 16_000_000

/** @typedef {{ op: 'equal' | 'removed' | 'added', line: string }} EditStep */

/**
 * @param {EditStep['op']} op
 * @param {string} line
 * @returns {EditStep}
 */
const step = (op, line) => ({ op, line })

/**
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  return text === '' ? [] : text.split(/\r?\n/)
}

/**
 * The edit script between two line arrays: `equal`, `removed` and `added`
 * steps in order.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {EditStep[]}
 */
function editScript(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map(line => step('added', line))
  if (m === 0) return a.map(line => step('removed', line))
  if (n * m > MAX_LCS_CELLS) {
    return [...a.map(line => step('removed', line)), ...b.map(line => step('added', line))]
  }

  // lcs[i * (m + 1) + j] = length of the LCS of a[i..] and b[j..]
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }

  /** @type {EditStep[]} */
  const script = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      script.push({ op: 'equal', line: a[i] })
      i++
      j++
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      script.push({ op: 'removed', line: a[i] })
      i++
    } else {
      script.push({ op: 'added', line: b[j] })
      j++
    }
  }
  while (i < n) script.push({ op: 'removed', line: a[i++] })
  while (j < m) script.push({ op: 'added', line: b[j++] })
  return script
}

/**
 * Side-by-side rows of the differences between two texts.
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @param {{ maxLines?: number }} [options]
 * @returns {LineDiff}
 */
export function diffLines(beforeText, afterText, { maxLines = MAX_DIFF_LINES } = {}) {
  const a = splitLines(beforeText)
  const b = splitLines(afterText)
  if (a.length > maxLines || b.length > maxLines) {
    return { rows: null, tooLarge: true, added: 0, removed: 0 }
  }

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  /** @type {DiffRow[]} */
  const rows = []
  let leftNumber = 0
  let rightNumber = 0
  let added = 0
  let removed = 0

  /** @param {string} line */
  const pushEqual = line => {
    leftNumber++
    rightNumber++
    rows.push({ kind: 'equal', left: line, right: line, leftNumber, rightNumber })
  }

  for (let k = 0; k < start; k++) pushEqual(a[k])

  const script = editScript(a.slice(start, endA), b.slice(start, endB))
  let index = 0
  while (index < script.length) {
    const step = script[index]
    if (step.op === 'equal') {
      pushEqual(step.line)
      index++
      continue
    }
    // A run of removed lines followed by a run of added lines is one change,
    // shown row by row.
    const removedLines = []
    const addedLines = []
    while (index < script.length && script[index].op === 'removed') {
      removedLines.push(script[index].line)
      index++
    }
    while (index < script.length && script[index].op === 'added') {
      addedLines.push(script[index].line)
      index++
    }
    const length = Math.max(removedLines.length, addedLines.length)
    for (let k = 0; k < length; k++) {
      const left = k < removedLines.length ? removedLines[k] : null
      const right = k < addedLines.length ? addedLines[k] : null
      if (left !== null) {
        leftNumber++
        removed++
      }
      if (right !== null) {
        rightNumber++
        added++
      }
      rows.push({
        kind: left !== null && right !== null ? 'changed' : left !== null ? 'removed' : 'added',
        left,
        right,
        leftNumber: left !== null ? leftNumber : null,
        rightNumber: right !== null ? rightNumber : null
      })
    }
  }

  for (let k = endA; k < a.length; k++) pushEqual(a[k])

  return { rows, tooLarge: false, added, removed }
}

/**
 * A value as the pretty-printed JSON the diff compares.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stringifyForDiff(value) {
  try {
    const text = JSON.stringify(value, null, 2)
    return typeof text === 'string' ? text : String(value)
  } catch {
    return String(value)
  }
}
