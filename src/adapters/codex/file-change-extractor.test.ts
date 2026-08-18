import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexFileChangeExtractor } from './file-change-extractor'
import type { FileChange } from '../../types'

const PARENT_PATH = join(
  __dirname,
  '../../../fixtures/codex-home/sessions/2026/08/17/rollout-2026-08-17T10-00-00-01a00000-0000-7000-8000-000000000001.jsonl',
)

async function collectChanges(path: string): Promise<FileChange[]> {
  const extractor = new CodexFileChangeExtractor()
  const out: FileChange[] = []
  for await (const c of extractor.extractChanges(path)) out.push(c)
  return out
}

describe('CodexFileChangeExtractor', () => {
  it('yields 2 file changes from patch_apply_end with create/edit ops', async () => {
    const changes = await collectChanges(PARENT_PATH)
    expect(changes).toHaveLength(2)

    const edit = changes.find(c => c.filePath === '/home/test/project-alpha/src/fetch.ts')
    expect(edit?.operation).toBe('edit')

    const create = changes.find(c => c.filePath === '/home/test/project-alpha/src/retry.ts')
    expect(create?.operation).toBe('create')
  })

  it('carries the session id, call_id as messageId, and line timestamp', async () => {
    const changes = await collectChanges(PARENT_PATH)
    for (const c of changes) {
      expect(c.sessionId).toBe('01a00000-0000-7000-8000-000000000001')
      expect(c.messageId).toBe('exec-patch-1')
      expect(c.timestamp).toBe('2026-08-17T10:00:10.000Z')
    }
  })

  describe('delete-type changes', () => {
    let tempDir: string

    afterEach(() => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    })

    it('maps changes[path].type === "delete" onto FileChange.operation "delete"', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'codex-filechange-'))
      const rolloutPath = join(tempDir, 'rollout.jsonl')
      const lines = [
        JSON.stringify({
          timestamp: '2026-08-17T10:00:10.000Z',
          type: 'event_msg',
          payload: {
            type: 'patch_apply_end',
            call_id: 'exec-patch-2',
            success: true,
            changes: {
              '/home/test/project-alpha/src/old.ts': { type: 'delete' },
              '/home/test/project-alpha/src/fetch.ts': { type: 'update', unified_diff: '@@ -1 +1 @@ -a +b' },
            },
          },
        }),
      ]
      writeFileSync(rolloutPath, lines.join('\n') + '\n')

      const changes = await collectChanges(rolloutPath)
      expect(changes).toHaveLength(2)
      const del = changes.find(c => c.filePath === '/home/test/project-alpha/src/old.ts')
      expect(del?.operation).toBe('delete')
      const edit = changes.find(c => c.filePath === '/home/test/project-alpha/src/fetch.ts')
      expect(edit?.operation).toBe('edit')
    })
  })
})
