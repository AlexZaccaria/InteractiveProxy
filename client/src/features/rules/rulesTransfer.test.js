import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeImport, importRulesFile, rulesFilename } from './rulesTransfer'
import { apiPost } from '../../lib/api'

vi.mock('../../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }))

describe('rules transfer helpers', () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset()
  })

  it('names the file after the moment of the export', () => {
    expect(rulesFilename(new Date('2026-11-11T10:20:30.000Z'))).toBe(
      'proxy-rules-2026-11-11T10-20-30-000Z.json'
    )
  })

  it('posts the file with the mode and sums up the answer', async () => {
    /** @type {import('./rulesTransfer').RulesImportResult} */
    const result = {
      success: true,
      mode: 'merge',
      counts: { editRules: 2, presets: 0, blockedRules: 1, filterRules: 0, breakpointRules: 3 }
    }
    vi.mocked(apiPost).mockResolvedValue(result)
    const data = { format: 'interactive-proxy-rules', version: 1, editRules: [] }
    const file = new File([JSON.stringify(data)], 'rules.json')

    await expect(importRulesFile(file)).resolves.toEqual(result)
    expect(apiPost).toHaveBeenCalledWith('/api/rules/import', { ...data, mode: 'merge' })
    expect(describeImport(result)).toBe(
      'Imported 2 edit rules, 1 blocked rule, 3 breakpoint rules; records with a known id replaced the existing ones.'
    )
    expect(
      describeImport({
        success: true,
        mode: 'replace',
        counts: { editRules: 0, presets: 0, blockedRules: 0, filterRules: 0, breakpointRules: 0 }
      })
    ).toBe("Rules replaced with the file's: nothing.")
  })

  it('rejects a file that is not JSON', async () => {
    await expect(importRulesFile(new File(['{'], 'rules.json'))).rejects.toThrow(
      'The file is not valid JSON'
    )
    expect(apiPost).not.toHaveBeenCalled()
  })
})
