import { beforeEach, describe, expect, it, vi } from 'vitest'
import { harFilename, importHarFile } from './exportLogs'
import { apiPost } from '../../lib/api'

vi.mock('../../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }))

describe('HAR helpers', () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset()
  })

  it('names the archive after the moment of the export', () => {
    expect(harFilename(new Date('2026-11-11T10:20:30.000Z'))).toBe(
      'proxy-logs-2026-11-11T10-20-30-000Z.har'
    )
  })

  it('posts the parsed archive and relays the counts', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true, imported: 2, skipped: 1 })
    const archive = { log: { version: '1.2', entries: [] } }
    const file = new File([JSON.stringify(archive)], 'traffic.har', { type: 'application/json' })

    await expect(importHarFile(file)).resolves.toEqual({ success: true, imported: 2, skipped: 1 })
    expect(apiPost).toHaveBeenCalledWith('/api/logs/import', archive)
  })

  it('rejects a file that is not JSON before calling the API', async () => {
    const file = new File(['not json'], 'traffic.har')
    await expect(importHarFile(file)).rejects.toThrow('The file is not valid JSON')
    expect(apiPost).not.toHaveBeenCalled()
  })
})
