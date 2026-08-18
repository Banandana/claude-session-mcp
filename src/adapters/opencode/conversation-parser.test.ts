import { describe, it, expect, beforeAll } from 'vitest'
import { OpencodeDatabase } from './database'
import { OpencodeConversationParser } from './conversation-parser'
import { buildFixtureDb, buildFixtureDbWithSpillCases, type SpillFixture } from './test-fixture'
import type { NormalizedMessage } from '../../types'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

describe('OpencodeConversationParser', () => {
  let parser: OpencodeConversationParser

  beforeAll(() => {
    const dbPath = buildFixtureDb()
    parser = new OpencodeConversationParser(new OpencodeDatabase(dbPath))
  })

  it('returns empty for an unknown session', async () => {
    const messages = await collect(parser.parseSession('nonexistent', '/home/test'))
    expect(messages).toHaveLength(0)
  })

  it('yields one NormalizedMessage per opencode message row, in time order', async () => {
    const messages = await collect(parser.parseSession('ses_parent0000000000000001', '/home/test/project-alpha'))
    expect(messages.map(m => m.id)).toEqual([
      'msg_user_0000000000000001',
      'msg_asst_0000000000000002',
      'msg_asst_0000000000000003',
    ])
  })

  describe('the user turn', () => {
    let messages: NormalizedMessage[]
    beforeAll(async () => {
      messages = await collect(parser.parseSession('ses_parent0000000000000001', '/home/test/project-alpha'))
    })

    it('carries a single text block and no error/correction', () => {
      const [user] = messages
      expect(user?.role).toBe('user')
      expect(user?.contentBlocks).toEqual([{ type: 'text', text: 'add a retry to the fetch helper' }])
      expect(user?.isError).toBe(false)
      expect(user?.isCorrection).toBe(false)
      expect(user?.parentUuid).toBeNull()
    })

    it('falls back to the nested model snapshot when there is no flat modelID', () => {
      const [user] = messages
      expect(user?.model).toBe('cerebras/zai-glm-4.7')
    })

    it('falls back to the session directory when the message has no path.cwd', () => {
      const [user] = messages
      expect(user?.cwd).toBe('/home/test/project-alpha')
    })
  })

  describe('the assistant turn with mixed tool results', () => {
    let assistant: NormalizedMessage | undefined
    beforeAll(async () => {
      const messages = await collect(parser.parseSession('ses_parent0000000000000001', '/home/test/project-alpha'))
      assistant = messages[1]
    })

    it('assembles blocks in part order: thinking, tool_use/tool_result x3, text', () => {
      expect(assistant?.contentBlocks.map(b => b.type)).toEqual([
        'thinking',
        'tool_use',
        'tool_result',
        'tool_use',
        'tool_result',
        'tool_use',
        'tool_result',
        'text',
      ])
    })

    it('carries the reasoning text verbatim on the thinking block', () => {
      expect(assistant?.contentBlocks[0]).toEqual({
        type: 'thinking',
        thinking: 'The helper has no backoff. Bound it at three attempts.',
      })
      expect(assistant?.hasThinking).toBe(true)
    })

    it('does NOT flag the successful bash call as an error even though its output says "0 errors"', () => {
      const bashResult = assistant?.contentBlocks[2]
      expect(bashResult?.type).toBe('tool_result')
      expect(bashResult?.tool_use_id).toBe('call_bash_1')
      expect(bashResult?.content).toBe('3 passing, 0 errors reported')
      expect(bashResult?.isError).toBe(false)
    })

    it('DOES flag the failed read call as an error, from state.status alone', () => {
      const readUse = assistant?.contentBlocks[3]
      const readResult = assistant?.contentBlocks[4]
      expect(readUse).toEqual({
        type: 'tool_use',
        id: 'call_read_1',
        name: 'read',
        input: { filePath: '/home/test/project-alpha/missing.ts' },
      })
      expect(readResult?.type).toBe('tool_result')
      expect(readResult?.tool_use_id).toBe('call_read_1')
      expect(readResult?.content).toBe('ENOENT: no such file or directory')
      expect(readResult?.isError).toBe(true)
    })

    it('collects toolNames for every tool part, including task', () => {
      expect(assistant?.toolNames).toEqual(['bash', 'read', 'task'])
    })

    it('propagates the tool failure to the message-level isError flag', () => {
      expect(assistant?.isError).toBe(true)
    })

    it('never puts patch or step-finish parts into contentBlocks', () => {
      const types = assistant?.contentBlocks.map(b => b.type) ?? []
      expect(types).not.toContain('patch')
      expect(types).not.toContain('step-finish')
      expect(assistant?.contentBlocks).toHaveLength(8)
    })

    it('maps step-finish tokens/cost onto tokenUsage', () => {
      expect(assistant?.tokenUsage).toEqual({
        input_tokens: 10086,
        output_tokens: 2258,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: 72576,
      })
    })

    it('resolves model from the flat modelID/providerID fields', () => {
      expect(assistant?.model).toBe('cerebras/zai-glm-4.7')
    })
  })

  describe('the failed-API-call turn with a compaction part', () => {
    let errored: NormalizedMessage | undefined
    beforeAll(async () => {
      const messages = await collect(parser.parseSession('ses_parent0000000000000001', '/home/test/project-alpha'))
      errored = messages[2]
    })

    it('flags isError from the message-level error object', () => {
      expect(errored?.isError).toBe(true)
    })

    it('produces no content blocks for the compaction part', () => {
      expect(errored?.contentBlocks).toHaveLength(0)
    })

    it('has no tokenUsage when every token field is zero', () => {
      expect(errored?.tokenUsage).toBeUndefined()
    })
  })

  describe('the child (sub-agent) session', () => {
    it('is independently retrievable by its own session id', async () => {
      const messages = await collect(parser.parseSession('ses_child00000000000000002', '/home/test/project-alpha'))
      expect(messages).toHaveLength(1)
      expect(messages[0]?.contentBlocks).toEqual([
        { type: 'text', text: 'Bounded at 3 attempts. No unbounded loop.' },
      ])
    })

    it('falls back to message-level tokens when there is no step-finish part', async () => {
      const messages = await collect(parser.parseSession('ses_child00000000000000002', '/home/test/project-alpha'))
      expect(messages[0]?.tokenUsage).toEqual({
        input_tokens: 500,
        output_tokens: 40,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      })
    })
  })
})

describe('OpencodeConversationParser — spill-file resolution (verified wire format)', () => {
  let fixture: SpillFixture
  let messages: NormalizedMessage[]

  beforeAll(async () => {
    fixture = buildFixtureDbWithSpillCases()
    const parser = new OpencodeConversationParser(new OpencodeDatabase(fixture.dbPath))
    messages = await collect(parser.parseSession(fixture.sessionId, '/home/test/project-alpha'))
  })

  it('replaces the truncated inline output with the full spill-file text when outputPath resolves', () => {
    const [message] = messages
    const resolvedResult = message?.contentBlocks[1]
    expect(resolvedResult?.type).toBe('tool_result')
    expect(resolvedResult?.tool_use_id).toBe(fixture.resolvedCallId)
    expect(resolvedResult?.content).toBe(fixture.resolvedFullText)
    // Sanity: the resolved text is genuinely different from (and longer
    // than) the truncated inline placeholder it replaced.
    expect(resolvedResult?.content).not.toBe(fixture.resolvedInlineText)
  })

  it('falls back to the inline output, without throwing, when outputPath does not exist', () => {
    const [message] = messages
    const missingResult = message?.contentBlocks[3]
    expect(missingResult?.type).toBe('tool_result')
    expect(missingResult?.tool_use_id).toBe(fixture.missingCallId)
    expect(missingResult?.content).toBe(fixture.missingInlineText)
  })

  it('does not flag either resolved tool call as an error — both are status:"completed"', () => {
    const [message] = messages
    expect(message?.contentBlocks[1]?.isError).toBe(false)
    expect(message?.contentBlocks[3]?.isError).toBe(false)
    expect(message?.isError).toBe(false)
  })
})
