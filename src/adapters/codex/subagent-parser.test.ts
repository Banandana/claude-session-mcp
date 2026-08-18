import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { CodexSessionDiscovery } from './session-discovery'
import { CodexSubagentParser } from './subagent-parser'
import type { SubagentMeta } from '../../types'

const CODEX_HOME = join(__dirname, '../../../fixtures/codex-home')
const PARENT_ID = '01a00000-0000-7000-8000-000000000001'
const CHILD_ID = '01a00000-0000-7000-8000-000000000002'

async function collectSubagents(parser: CodexSubagentParser, sessionId: string): Promise<SubagentMeta[]> {
  const out: SubagentMeta[] = []
  for await (const s of parser.getSubagents(sessionId)) out.push(s)
  return out
}

describe('CodexSubagentParser', () => {
  it("returns the child rollout as the parent's subagent", async () => {
    const discovery = new CodexSessionDiscovery(CODEX_HOME)
    const parser = new CodexSubagentParser(discovery)
    const subs = await collectSubagents(parser, PARENT_ID)

    expect(subs).toHaveLength(1)
    const sub = subs[0]
    expect(sub?.id).toBe(CHILD_ID)
    expect(sub?.sessionId).toBe(CHILD_ID)
    expect(sub?.agentType).toBe('/root/retry_reviewer')
    expect(sub?.description).toBe('review the retry helper for unbounded loops')
    expect(sub?.totalTokens).toBe(540)
    expect(sub?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns nothing for a session with no children', async () => {
    const discovery = new CodexSessionDiscovery(CODEX_HOME)
    const parser = new CodexSubagentParser(discovery)
    const subs = await collectSubagents(parser, CHILD_ID)
    expect(subs).toEqual([])
  })
})
