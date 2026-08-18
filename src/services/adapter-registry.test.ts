import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { AdapterRegistry } from './adapter-registry'
import { ClaudeCodeAdapter } from '../adapters/claude-code/index'
import type {
  ProjectMeta,
  SessionMeta,
  NormalizedMessage,
  FileChange,
  SubagentMeta,
  MemoryEntry,
  IndexState,
  FreshnessResult,
  SessionAdapter,
} from '../types'

const FIXTURES = join(__dirname, '../../fixtures/claude-home')

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) {
    items.push(item)
  }
  return items
}

describe('AdapterRegistry', () => {
  it('starts with no adapters', () => {
    const registry = new AdapterRegistry()
    expect(registry.getAdapters()).toHaveLength(0)
  })

  it('registers an adapter', () => {
    const registry = new AdapterRegistry()
    const adapter = new ClaudeCodeAdapter(FIXTURES)
    registry.registerAdapter(adapter)
    expect(registry.getAdapters()).toHaveLength(1)
  })

  describe('with ClaudeCodeAdapter', () => {
    const registry = new AdapterRegistry()
    const adapter = new ClaudeCodeAdapter(FIXTURES)
    registry.registerAdapter(adapter)

    it('discovers projects through registry', async () => {
      const projects = await collect<ProjectMeta>(registry.discoverProjects())
      expect(projects.length).toBe(2)
    })

    it('discovers sessions through registry', async () => {
      const sessions = await collect<SessionMeta>(registry.discoverSessions())
      expect(sessions.length).toBeGreaterThanOrEqual(2)
    })

    it('gets messages through registry', async () => {
      const messages = await collect<NormalizedMessage>(
        registry.getMessages('aaaaaaaa-1111-2222-3333-444444444444'),
      )
      expect(messages.length).toBeGreaterThan(0)
    })

    it('gets memory through registry', async () => {
      const entries = await collect<MemoryEntry>(registry.getMemory())
      expect(entries.length).toBeGreaterThan(0)
    })

    it('resolveProject returns undefined for unknown path', async () => {
      const result = await registry.resolveProject('/nonexistent/path')
      expect(result).toBeUndefined()
    })

    it('checkFreshness merges results from all adapters', async () => {
      const result = await registry.checkFreshness({
        sessionWatermarks: new Map(),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.isStale).toBe(true)
      expect(result.newSessions.length).toBeGreaterThan(0)
    })
  })

  describe('empty registry', () => {
    const registry = new AdapterRegistry()

    it('yields nothing for discoverProjects', async () => {
      const projects = await collect<ProjectMeta>(registry.discoverProjects())
      expect(projects).toHaveLength(0)
    })

    it('resolveProject returns undefined', async () => {
      expect(await registry.resolveProject('/any/path')).toBeUndefined()
    })

    it('checkFreshness returns not stale', async () => {
      const result = await registry.checkFreshness({
        sessionWatermarks: new Map(),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.isStale).toBe(false)
    })
  })

  // ─── Owner hints (finding B11) ───────────────────────────────────────────

  function makeMockAdapter(source: string, sessionIds: readonly string[]): SessionAdapter & {
    claimsSessionId: ReturnType<typeof vi.fn>
  } {
    const claims = vi.fn(async (id: string) => sessionIds.includes(id))
    return {
      source,
      async *discoverProjects(): AsyncIterable<ProjectMeta> {},
      async *discoverSessions(): AsyncIterable<SessionMeta> {},
      async *getMessages(sessionId: string): AsyncIterable<NormalizedMessage> {
        if (!sessionIds.includes(sessionId)) return
        yield {
          id: 'm1',
          sessionId,
          role: 'user',
          timestamp: new Date().toISOString(),
          contentBlocks: [{ type: 'text', text: `from ${source}` }],
          isError: false,
          isCorrection: false,
          hasThinking: false,
          uuid: 'm1',
        }
      },
      async *getFileChanges(): AsyncIterable<FileChange> {},
      async *getSubagents(): AsyncIterable<SubagentMeta> {},
      async *getMemory(): AsyncIterable<MemoryEntry> {},
      async getSessionMetadata() { return undefined },
      async getSessionCost() { return undefined },
      async resolveProject() { return undefined },
      async checkFreshness(known: IndexState): Promise<FreshnessResult> {
        const changedSessions = [...known.sessionWatermarks.keys()].filter(id => sessionIds.includes(id))
        return { isStale: changedSessions.length > 0, newSessions: [], changedSessions, removedSessions: [] }
      },
      claimsSessionId: claims,
      async getSessionWatermark(sessionId: string) {
        return sessionIds.includes(sessionId) ? 1 : undefined
      },
    }
  }

  it('resolves a hinted session without probing the other adapter', async () => {
    const registry = new AdapterRegistry()
    const adapterA = makeMockAdapter('source-a', ['sid-1'])
    const adapterB = makeMockAdapter('source-b', [])
    registry.registerAdapter(adapterA)
    registry.registerAdapter(adapterB)

    registry.setOwnerHints(new Map([['sid-1', 'source-a']]))

    const messages = await collect<NormalizedMessage>(registry.getMessages('sid-1'))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.contentBlocks[0]?.text).toBe('from source-a')

    // The hinted adapter is probed once to confirm ownership; the other
    // adapter is never probed at all.
    expect(adapterA.claimsSessionId).toHaveBeenCalledTimes(1)
    expect(adapterB.claimsSessionId).not.toHaveBeenCalled()
  })

  it('checkFreshness partitions hinted ids without any disk probe', async () => {
    const registry = new AdapterRegistry()
    const adapterA = makeMockAdapter('source-a', ['sid-1'])
    const adapterB = makeMockAdapter('source-b', ['sid-2'])
    registry.registerAdapter(adapterA)
    registry.registerAdapter(adapterB)

    registry.setOwnerHints(new Map([['sid-1', 'source-a'], ['sid-2', 'source-b']]))

    const result = await registry.checkFreshness({
      sessionWatermarks: new Map([['sid-1', 1], ['sid-2', 1]]),
      lastSyncAt: new Date().toISOString(),
    })

    expect(result.changedSessions.sort()).toEqual(['sid-1', 'sid-2'])
    // Ownership resolution for checkFreshness trusts the hint outright —
    // no claimsSessionId probe for either session.
    expect(adapterA.claimsSessionId).not.toHaveBeenCalled()
    expect(adapterB.claimsSessionId).not.toHaveBeenCalled()
  })

  it('falls back to probing when a hint is missing or wrong', async () => {
    const registry = new AdapterRegistry()
    const adapterA = makeMockAdapter('source-a', [])
    const adapterB = makeMockAdapter('source-b', ['sid-1'])
    registry.registerAdapter(adapterA)
    registry.registerAdapter(adapterB)

    // Hint wrongly points sid-1 at source-a, which doesn't actually claim it.
    registry.setOwnerHints(new Map([['sid-1', 'source-a']]))

    const messages = await collect<NormalizedMessage>(registry.getMessages('sid-1'))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.contentBlocks[0]?.text).toBe('from source-b')
  })

  it('resolves a session with no hint at all via the original probe path', async () => {
    const registry = new AdapterRegistry()
    const adapterA = makeMockAdapter('source-a', ['sid-1'])
    registry.registerAdapter(adapterA)
    // No setOwnerHints call — hint map is empty by default.

    const messages = await collect<NormalizedMessage>(registry.getMessages('sid-1'))
    expect(messages).toHaveLength(1)
  })
})
