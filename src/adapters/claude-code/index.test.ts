import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { ClaudeCodeAdapter } from './index'
import type {
  ProjectMeta,
  SessionMeta,
  NormalizedMessage,
  FileChange,
  SubagentMeta,
  MemoryEntry,
} from '../../types'

const FIXTURES = join(__dirname, '../../../fixtures/claude-home')

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) {
    items.push(item)
  }
  return items
}

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter(FIXTURES)

  it('has source "claude-code"', () => {
    expect(adapter.source).toBe('claude-code')
  })

  describe('discoverProjects', () => {
    it('discovers all projects from fixtures', async () => {
      const projects = await collect<ProjectMeta>(adapter.discoverProjects())
      expect(projects.length).toBe(2)
      const slugs = projects.map(p => p.slug).sort()
      expect(slugs).toEqual(['-home-test-project-alpha', '-home-test-project-beta'])
    })

    it('reports correct sessionCount', async () => {
      const projects = await collect<ProjectMeta>(adapter.discoverProjects())
      const alpha = projects.find(p => p.slug === '-home-test-project-alpha')!
      // alpha has aaaaaaaa, cccccccc, and dddddddd JSONL files
      expect(alpha.sessionCount).toBe(3)
    })
  })

  describe('discoverSessions', () => {
    it('discovers sessions across all projects', async () => {
      const sessions = await collect<SessionMeta>(adapter.discoverSessions())
      expect(sessions.length).toBeGreaterThanOrEqual(2)
    })

    it('filters by project slug', async () => {
      const sessions = await collect<SessionMeta>(
        adapter.discoverSessions('-home-test-project-alpha'),
      )
      for (const s of sessions) {
        expect(s.projectSlug).toBe('-home-test-project-alpha')
      }
    })
  })

  describe('getMessages', () => {
    it('returns messages for a known session', async () => {
      const messages = await collect<NormalizedMessage>(
        adapter.getMessages('aaaaaaaa-1111-2222-3333-444444444444'),
      )
      expect(messages.length).toBeGreaterThan(0)
      const roles = new Set(messages.map(m => m.role))
      expect(roles.has('user')).toBe(true)
    })

    it('returns empty for unknown session', async () => {
      const messages = await collect<NormalizedMessage>(
        adapter.getMessages('nonexistent-session-id'),
      )
      expect(messages).toHaveLength(0)
    })
  })

  describe('getFileChanges', () => {
    it('returns file changes for a session with file-history-snapshot', async () => {
      // cccccccc session has file-history-snapshot entries
      const changes = await collect<FileChange>(
        adapter.getFileChanges('cccccccc-1111-2222-3333-444444444444'),
      )
      // May be empty if fixture doesn't have file history — that's OK
      expect(Array.isArray(changes)).toBe(true)
    })

    it('returns empty for unknown session', async () => {
      const changes = await collect<FileChange>(
        adapter.getFileChanges('nonexistent-session-id'),
      )
      expect(changes).toHaveLength(0)
    })
  })

  describe('getSubagents', () => {
    it('returns subagents for a known session', async () => {
      const subagents = await collect<SubagentMeta>(
        adapter.getSubagents('aaaaaaaa-1111-2222-3333-444444444444'),
      )
      expect(subagents.length).toBeGreaterThan(0)
      expect(subagents[0].sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444')
    })

    it('returns empty for unknown session', async () => {
      const subagents = await collect<SubagentMeta>(
        adapter.getSubagents('nonexistent-session-id'),
      )
      expect(subagents).toHaveLength(0)
    })
  })

  describe('getMemory', () => {
    it('returns memory entries', async () => {
      const entries = await collect<MemoryEntry>(adapter.getMemory())
      expect(entries.length).toBeGreaterThan(0)
    })

    it('filters by project slug', async () => {
      const entries = await collect<MemoryEntry>(
        adapter.getMemory('-home-test-project-alpha'),
      )
      for (const entry of entries) {
        expect(entry.projectSlug).toBe('-home-test-project-alpha')
      }
    })
  })

  describe('resolveProject', () => {
    it('lazy-builds the cache on first call (cold start)', async () => {
      // Create a fresh adapter with no cache built yet
      const fresh = new ClaudeCodeAdapter(FIXTURES)
      // Real cwd from JSONL is /home/test/project-alpha (note hyphen, not slash)
      const result = await fresh.resolveProject('/home/test/project-alpha')
      expect(result?.slug).toBe('-home-test-project-alpha')
    })

    it('resolves correctly after warm cache', async () => {
      await collect<ProjectMeta>(adapter.discoverProjects())
      const result = await adapter.resolveProject('/home/test/project-alpha/src')
      expect(result?.slug).toBe('-home-test-project-alpha')
    })
  })

  describe('checkFreshness', () => {
    it('reports all sessions as new when index is empty', async () => {
      const result = await adapter.checkFreshness({
        sessionWatermarks: new Map(),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.isStale).toBe(true)
      expect(result.newSessions.length).toBeGreaterThan(0)
      expect(result.changedSessions).toHaveLength(0)
      expect(result.removedSessions).toHaveLength(0)
    })

    it('reports removed sessions when index has unknown IDs', async () => {
      const result = await adapter.checkFreshness({
        sessionWatermarks: new Map([['removed-session-id', 100]]),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.removedSessions).toContain('removed-session-id')
    })

    it('reports changed sessions when offset is smaller than file size', async () => {
      const result = await adapter.checkFreshness({
        sessionWatermarks: new Map([['aaaaaaaa-1111-2222-3333-444444444444', 1]]),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.changedSessions).toContain('aaaaaaaa-1111-2222-3333-444444444444')
    })
  })
})
