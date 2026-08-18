import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { CodexAdapter } from './index'
import type { NormalizedMessage, SessionMeta } from '../../types'

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
