import { describe, it, expect, beforeAll } from 'vitest'
import { OpencodeDatabase } from './database'
import { OpencodeSubagentParser } from './subagent-parser'
import { buildFixtureDb } from './test-fixture'
import type { SubagentMeta } from '../../types'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

describe('OpencodeSubagentParser', () => {
  let parser: OpencodeSubagentParser

  beforeAll(() => {
    const dbPath = buildFixtureDb()
    parser = new OpencodeSubagentParser(new OpencodeDatabase(dbPath))
  })

  it('returns the one child session as a SubagentMeta', async () => {
    const subagents = await collect<SubagentMeta>(parser.getSubagents('ses_parent0000000000000001'))
    expect(subagents).toHaveLength(1)
    const [sub] = subagents
    expect(sub?.id).toBe('ses_child00000000000000002')
    expect(sub?.sessionId).toBe('ses_parent0000000000000001')
  })

  it('describes the sub-agent from the parent\'s task tool part', async () => {
    const [sub] = await collect<SubagentMeta>(parser.getSubagents('ses_parent0000000000000001'))
    expect(sub?.description).toBe('Review the retry helper')
    expect(sub?.agentType).toBe('explore')
    expect(sub?.model).toBe('cerebras/zai-glm-4.7')
  })

  it('sums the child\'s own token columns and duration', async () => {
    const [sub] = await collect<SubagentMeta>(parser.getSubagents('ses_parent0000000000000001'))
    expect(sub?.totalTokens).toBe(500 + 40 + 0)
    expect(sub?.durationMs).toBe(1787000400000 - 1787000300000)
  })

  it('returns empty for a session with no children', async () => {
    const subagents = await collect<SubagentMeta>(parser.getSubagents('ses_child00000000000000002'))
    expect(subagents).toHaveLength(0)
  })

  it('returns empty for an unknown session', async () => {
    const subagents = await collect<SubagentMeta>(parser.getSubagents('nonexistent'))
    expect(subagents).toHaveLength(0)
  })
})
