import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { CodexAdapter } from './index'
import { listAllRollouts } from './rollout-header'
import type { NormalizedMessage, SessionMeta } from '../../types'

// Counts real readRolloutHeader calls without changing what it returns, so
// the "at most once per rollout" scan-shape assertion below has something to
// measure.
const headerReads = vi.hoisted(() => ({ count: 0 }))
vi.mock('./rollout-header', async () => {
  const actual = await vi.importActual<typeof import('./rollout-header')>('./rollout-header')
  return {
    ...actual,
    readRolloutHeader: async (path: string) => {
      headerReads.count++
      return actual.readRolloutHeader(path)
    },
  }
})

const CODEX_HOME = join(__dirname, '../../../fixtures/codex-home')
const PARENT_ID = '01a00000-0000-7000-8000-000000000001'
const CHILD_ID = '01a00000-0000-7000-8000-000000000002'

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('CodexAdapter', () => {
  it('has source "codex"', () => {
    const adapter = new CodexAdapter(CODEX_HOME)
    expect(adapter.source).toBe('codex')
  })

  it('discovers the parent session, excluding the child', async () => {
    const adapter = new CodexAdapter(CODEX_HOME)
    const sessions = await drain<SessionMeta>(adapter.discoverSessions())
    expect(sessions.map(s => s.id)).toEqual([PARENT_ID])
  })

  it('claimsSessionId returns true for both the parent and a child id', async () => {
    const adapter = new CodexAdapter(CODEX_HOME)
    expect(await adapter.claimsSessionId(PARENT_ID)).toBe(true)
    expect(await adapter.claimsSessionId(CHILD_ID)).toBe(true)
    expect(await adapter.claimsSessionId('not-a-real-session')).toBe(false)
  })

  it('getMessages works directly on a child (sub-agent) session id', async () => {
    const adapter = new CodexAdapter(CODEX_HOME)
    const messages = await drain<NormalizedMessage>(adapter.getMessages(CHILD_ID))
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
  })

  it('getSubagents(parent) returns the child thread', async () => {
    const adapter = new CodexAdapter(CODEX_HOME)
    const subs = await drain(adapter.getSubagents(PARENT_ID))
    expect(subs).toHaveLength(1)
    expect(subs[0]?.id).toBe(CHILD_ID)
  })

  it('getSessionCost always returns undefined (no cost data in Codex rollouts)', async () => {
    const adapter = new CodexAdapter(CODEX_HOME)
    expect(await adapter.getSessionCost('codex--home-test-project-alpha--', PARENT_ID)).toBeUndefined()
  })

  it('getSessionWatermark returns the on-disk file size', async () => {
    const adapter = new CodexAdapter(CODEX_HOME)
    const watermark = await adapter.getSessionWatermark(PARENT_ID)
    expect(watermark).toBeGreaterThan(0)
    expect(await adapter.getSessionWatermark('not-a-real-session')).toBeUndefined()
  })

  it('checkFreshness reports the parent session as new against an empty index', async () => {
    const adapter = new CodexAdapter(CODEX_HOME)
    const result = await adapter.checkFreshness({ sessionWatermarks: new Map(), lastSyncAt: new Date(0).toISOString() })
    expect(result.isStale).toBe(true)
    expect(result.newSessions).toEqual([PARENT_ID])
    expect(result.changedSessions).toEqual([])
    expect(result.removedSessions).toEqual([])
  })

  it('checkFreshness reads each rollout header at most once', async () => {
    // Guards the shape of the scan, not a wall-clock number. The previous
    // implementation walked the tree once per discovered session
    // (discoverSessions, then findSessionFile per id), which is quadratic in
    // rollout count and measured 19.0s against 1.1s for a single pass on a
    // real 123-rollout store — paid on every tool call, since freshness runs
    // per call. Reading a header more than once per file means that walk is
    // back.
    let rollouts = 0
    for await (const _ of listAllRollouts(join(CODEX_HOME, 'sessions'))) rollouts++
    expect(rollouts).toBeGreaterThan(1)

    headerReads.count = 0
    const adapter = new CodexAdapter(CODEX_HOME)
    await adapter.checkFreshness({ sessionWatermarks: new Map(), lastSyncAt: new Date(0).toISOString() })

    expect(headerReads.count).toBeLessThanOrEqual(rollouts)
  })

  describe('missing ~/.codex/sessions directory', () => {
    const adapter = new CodexAdapter(join(CODEX_HOME, 'does-not-exist'))

    it('discoverProjects/discoverSessions/getMemory yield nothing', async () => {
      expect(await drain(adapter.discoverProjects())).toEqual([])
      expect(await drain(adapter.discoverSessions())).toEqual([])
    })

    it('getMessages/getFileChanges/getSubagents yield nothing for any id', async () => {
      expect(await drain(adapter.getMessages(PARENT_ID))).toEqual([])
      expect(await drain(adapter.getFileChanges(PARENT_ID))).toEqual([])
      expect(await drain(adapter.getSubagents(PARENT_ID))).toEqual([])
    })

    it('claimsSessionId and getSessionWatermark degrade to false/undefined', async () => {
      expect(await adapter.claimsSessionId(PARENT_ID)).toBe(false)
      expect(await adapter.getSessionWatermark(PARENT_ID)).toBeUndefined()
    })

    it('checkFreshness never reports another adapter\'s sessions as removed', async () => {
      const known = new Map([[PARENT_ID, 999], ['some-claude-session-id', 42]])
      const result = await adapter.checkFreshness({ sessionWatermarks: known, lastSyncAt: new Date(0).toISOString() })
      expect(result).toEqual({ isStale: false, newSessions: [], changedSessions: [], removedSessions: [] })
    })
  })
})
