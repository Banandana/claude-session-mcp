import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { FileChangeExtractor } from './file-change-extractor'
import type { FileChange } from '../../types'

const FIXTURES = join(__dirname, '../../../fixtures/claude-home/projects/-home-test-project-alpha')

async function collectChanges(extractor: FileChangeExtractor, sessionPath: string): Promise<FileChange[]> {
  const changes: FileChange[] = []
  for await (const change of extractor.extractChanges(sessionPath)) {
    changes.push(change)
  }
  return changes
}

describe('FileChangeExtractor', () => {
  const extractor = new FileChangeExtractor()

  describe('aaaaaaaa session with file-history-snapshot', () => {
    const sessionPath = join(FIXTURES, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl')

    it('extracts file changes regardless of the isSnapshotUpdate flag', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      expect(changes.length).toBeGreaterThanOrEqual(2)

      // Paths are resolved against the session cwd so they match the absolute
      // paths Codex and opencode record.
      const paths = changes.map(c => c.filePath)
      expect(paths).toContain('/home/test/project-alpha/src/auth.ts')
      expect(paths).toContain('/home/test/project-alpha/CLAUDE.md')
    })

    it('detects create operation when backupFileName is null', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      const authChange = changes.find(c => c.filePath === '/home/test/project-alpha/src/auth.ts')!
      expect(authChange.operation).toBe('create')
    })

    it('detects edit operation when backupFileName is non-null', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      const claudeChange = changes.find(c => c.filePath === '/home/test/project-alpha/CLAUDE.md')!
      expect(claudeChange.operation).toBe('edit')
    })

    it('sets correct sessionId and messageId', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      for (const change of changes) {
        expect(change.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444')
        expect(change.messageId).toBe('msg-2')
      }
    })

    it('sets timestamp from snapshot', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      for (const change of changes) {
        expect(change.timestamp).toBe('2026-03-28T10:00:06Z')
      }
    })
  })

  describe('cccccccc session with empty snapshot', () => {
    const sessionPath = join(FIXTURES, 'cccccccc-1111-2222-3333-444444444444.jsonl')

    it('skips snapshots with isSnapshotUpdate: false', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      // cccccccc has only an empty snapshot with isSnapshotUpdate: false
      expect(changes).toHaveLength(0)
    })
  })
})

// ─── Regression: the shape current Claude Code actually writes ─────────────

describe('FileChangeExtractor — snapshots as written today', () => {
  const extractor = new FileChangeExtractor()
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  /**
   * Builds a session whose snapshots all carry `isSnapshotUpdate: false` --
   * measured on a real 10k-line session, 413 of 413 snapshots had the flag
   * present and NONE set it to true, which is why the old extractor returned
   * nothing. Each snapshot repeats the full tracked set, so version movement
   * is the only real change signal.
   */
  function writeSession(): string {
    dir = mkdtempSync(join(tmpdir(), 'fce-'))
    const path = join(dir, 'ffffffff-1111-2222-3333-444444444444.jsonl')
    const snap = (msgId: string, ts: string, files: Record<string, { version: number; backupFileName: string | null }>) =>
      JSON.stringify({
        type: 'file-history-snapshot',
        messageId: msgId,
        isSnapshotUpdate: false,
        snapshot: { messageId: msgId, trackedFileBackups: files, timestamp: ts },
      })

    writeFileSync(path, [
      JSON.stringify({ type: 'user', uuid: 'u1', cwd: '/home/test/repo', timestamp: '2026-08-18T10:00:00Z', message: { role: 'user', content: 'go' } }),
      snap('m1', '2026-08-18T10:00:01Z', { 'src/new.ts': { version: 1, backupFileName: null } }),
      // identical repeat -- must NOT produce a second row
      snap('m2', '2026-08-18T10:00:02Z', { 'src/new.ts': { version: 1, backupFileName: null } }),
      // version bump on the same file -- one further edit
      snap('m3', '2026-08-18T10:00:03Z', { 'src/new.ts': { version: 2, backupFileName: 'abc@v1' }, 'src/existing.ts': { version: 5, backupFileName: 'def@v4' } }),
    ].join('\n') + '\n')
    return path
  }

  it('extracts changes even though every snapshot says isSnapshotUpdate: false', async () => {
    const changes = await collectChanges(extractor, writeSession())
    expect(changes.length).toBeGreaterThan(0)
  })

  it('emits one row per real change, not one per snapshot repeat', async () => {
    const changes = await collectChanges(extractor, writeSession())
    // create(new.ts v1) + edit(new.ts v2) + edit(existing.ts) = 3
    expect(changes).toHaveLength(3)
    const newTs = changes.filter(c => c.filePath.endsWith('src/new.ts'))
    expect(newTs).toHaveLength(2)
    expect(newTs[0]!.operation).toBe('create')
    expect(newTs[1]!.operation).toBe('edit')
  })

  it('resolves relative snapshot paths against the session cwd', async () => {
    const changes = await collectChanges(extractor, writeSession())
    for (const c of changes) expect(c.filePath.startsWith('/home/test/repo/')).toBe(true)
  })
})
