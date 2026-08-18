import { describe, it, expect, beforeAll } from 'vitest'
import { OpencodeAdapter } from './index'
import { buildFixtureDb } from './test-fixture'
import type { ProjectMeta, SessionMeta, SubagentMeta, MemoryEntry } from '../../types'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

describe('OpencodeAdapter', () => {
  let dbPath: string
  let adapter: OpencodeAdapter

  beforeAll(() => {
    dbPath = buildFixtureDb()
    adapter = new OpencodeAdapter(dbPath)
  })

  it('has source "opencode"', () => {
    expect(adapter.source).toBe('opencode')
  })

  it('defaults its db path to ~/.local/share/opencode/opencode.db', () => {
    const withDefault = new OpencodeAdapter()
    expect(withDefault.source).toBe('opencode')
  })

  describe('discoverProjects / discoverSessions wiring', () => {
    it('discovers the one project', async () => {
      const projects = await collect<ProjectMeta>(adapter.discoverProjects())
      expect(projects.map(p => p.slug)).toEqual(['oc-proj_alpha_sha1'])
    })

    it('discovers only the top-level session', async () => {
      const sessions = await collect<SessionMeta>(adapter.discoverSessions())
      expect(sessions.map(s => s.id)).toEqual(['ses_parent0000000000000001'])
    })
  })

  describe('getSubagents', () => {
    it('returns the child session', async () => {
      const subagents = await collect<SubagentMeta>(adapter.getSubagents('ses_parent0000000000000001'))
      expect(subagents.map(s => s.id)).toEqual(['ses_child00000000000000002'])
    })
  })

  describe('getMemory', () => {
    it('yields nothing — opencode has no memory store', async () => {
      const entries = await collect<MemoryEntry>(adapter.getMemory())
      expect(entries).toHaveLength(0)
    })
  })

  describe('getSessionCost', () => {
    it('returns the real per-session cost from session.cost', async () => {
      expect(await adapter.getSessionCost('oc-proj_alpha_sha1', 'ses_parent0000000000000001')).toBeCloseTo(0.1925675)
      expect(await adapter.getSessionCost('oc-proj_alpha_sha1', 'ses_child00000000000000002')).toBeCloseTo(0.004)
    })

    it('returns undefined for an unknown session', async () => {
      expect(await adapter.getSessionCost('oc-proj_alpha_sha1', 'nonexistent')).toBeUndefined()
    })
  })

  describe('getSessionWatermark', () => {
    it('equals session.time_updated', async () => {
      expect(await adapter.getSessionWatermark('ses_parent0000000000000001')).toBe(1787000600000)
    })

    it('works for a child (sub-agent) session id too', async () => {
      expect(await adapter.getSessionWatermark('ses_child00000000000000002')).toBe(1787000400000)
    })

    it('returns undefined for an unknown session', async () => {
      expect(await adapter.getSessionWatermark('nonexistent')).toBeUndefined()
    })
  })

  describe('claimsSessionId', () => {
    it('claims both the parent and the child session id', async () => {
      expect(await adapter.claimsSessionId('ses_parent0000000000000001')).toBe(true)
      expect(await adapter.claimsSessionId('ses_child00000000000000002')).toBe(true)
    })

    it('does not claim an unknown id', async () => {
      expect(await adapter.claimsSessionId('nonexistent')).toBe(false)
    })
  })

  describe('checkFreshness', () => {
    it('reports the top-level session as new when the index is empty', async () => {
      const result = await adapter.checkFreshness({ sessionWatermarks: new Map(), lastSyncAt: new Date().toISOString() })
      expect(result.isStale).toBe(true)
      expect(result.newSessions).toEqual(['ses_parent0000000000000001'])
      expect(result.changedSessions).toHaveLength(0)
      expect(result.removedSessions).toHaveLength(0)
    })

    it('short-circuits to not-stale when the known watermark already matches', async () => {
      const result = await adapter.checkFreshness({
        sessionWatermarks: new Map([['ses_parent0000000000000001', 1787000600000]]),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.isStale).toBe(false)
      expect(result.newSessions).toHaveLength(0)
      expect(result.changedSessions).toHaveLength(0)
      expect(result.removedSessions).toHaveLength(0)
    })

    it('reports a changed session when the known watermark is behind', async () => {
      const result = await adapter.checkFreshness({
        sessionWatermarks: new Map([['ses_parent0000000000000001', 1]]),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.changedSessions).toContain('ses_parent0000000000000001')
    })

    it('reports removed sessions when the index has unknown ids', async () => {
      const result = await adapter.checkFreshness({
        sessionWatermarks: new Map([['removed-session-id', 100]]),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.removedSessions).toContain('removed-session-id')
    })
  })
})

describe('OpencodeAdapter — missing database', () => {
  const adapter = new OpencodeAdapter('/nonexistent/path/opencode.db')

  it('degrades every read to empty, never throws', async () => {
    expect(await collect(adapter.discoverProjects())).toHaveLength(0)
    expect(await collect(adapter.discoverSessions())).toHaveLength(0)
    expect(await collect(adapter.getMessages('any'))).toHaveLength(0)
    expect(await collect(adapter.getFileChanges('any'))).toHaveLength(0)
    expect(await collect(adapter.getSubagents('any'))).toHaveLength(0)
    expect(await collect(adapter.getMemory())).toHaveLength(0)
    expect(await adapter.getSessionMetadata('any')).toBeUndefined()
    expect(await adapter.getSessionCost('any', 'any')).toBeUndefined()
    expect(await adapter.resolveProject('/anywhere')).toBeUndefined()
    expect(await adapter.claimsSessionId('any')).toBe(false)
    expect(await adapter.getSessionWatermark('any')).toBeUndefined()
  })

  it('checkFreshness reports isStale:false and never claims another adapter\'s sessions removed', async () => {
    const result = await adapter.checkFreshness({
      sessionWatermarks: new Map([['some-other-adapters-session', 123]]),
      lastSyncAt: new Date().toISOString(),
    })
    expect(result).toEqual({ isStale: false, newSessions: [], changedSessions: [], removedSessions: [] })
  })
})
