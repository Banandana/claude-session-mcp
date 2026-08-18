import { describe, it, expect, beforeAll } from 'vitest'
import { OpencodeDatabase } from './database'
import { OpencodeFileChangeExtractor } from './file-change-extractor'
import { buildFixtureDb } from './test-fixture'
import type { FileChange } from '../../types'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

describe('OpencodeFileChangeExtractor', () => {
  let extractor: OpencodeFileChangeExtractor

  beforeAll(() => {
    const dbPath = buildFixtureDb()
    extractor = new OpencodeFileChangeExtractor(new OpencodeDatabase(dbPath))
  })

  it('yields one FileChange per path in the patch part\'s files[]', async () => {
    const changes = await collect<FileChange>(extractor.extractChanges('ses_parent0000000000000001'))
    expect(changes).toHaveLength(2)
    expect(changes.map(c => c.filePath)).toEqual([
      '/home/test/project-alpha/src/fetch.ts',
      '/home/test/project-alpha/src/retry.ts',
    ])
  })

  it('records every entry as "edit" — opencode has no per-file operation kind', async () => {
    const changes = await collect<FileChange>(extractor.extractChanges('ses_parent0000000000000001'))
    for (const change of changes) {
      expect(change.operation).toBe('edit')
    }
  })

  it('returns empty for a session with no patch parts', async () => {
    const changes = await collect<FileChange>(extractor.extractChanges('ses_child00000000000000002'))
    expect(changes).toHaveLength(0)
  })

  it('returns empty for an unknown session', async () => {
    const changes = await collect<FileChange>(extractor.extractChanges('nonexistent'))
    expect(changes).toHaveLength(0)
  })
})
