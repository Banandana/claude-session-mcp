import { describe, it, expect } from 'vitest'
import { ConversationParser } from './conversation-parser'
import { join } from 'node:path'
import type { NormalizedMessage } from '../../types'

const FIXTURES = join(__dirname, '../../../fixtures/claude-home/projects/-home-test-project-alpha')

async function collectMessages(
  parser: ConversationParser,
  sessionPath: string,
  startOffset = 0,
): Promise<NormalizedMessage[]> {
  const messages: NormalizedMessage[] = []
  for await (const msg of parser.parseSession(sessionPath, startOffset)) {
    messages.push(msg)
  }
  return messages
}

describe('ConversationParser', () => {
  const parser = new ConversationParser()

  describe('basic session (aaaaaaaa)', () => {
    const sessionPath = join(FIXTURES, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl')

    it('parses user text message', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const userMsgs = messages.filter(m => m.role === 'user')
      expect(userMsgs).toHaveLength(1)
      expect(userMsgs[0].contentBlocks).toHaveLength(1)
      expect(userMsgs[0].contentBlocks[0].type).toBe('text')
      expect(userMsgs[0].contentBlocks[0].text).toBe('Build the auth module')
      expect(userMsgs[0].uuid).toBe('msg-1')
      expect(userMsgs[0].isError).toBe(false)
    })

    it('skips file-history-snapshot lines without crashing', async () => {
      const messages = await collectMessages(parser, sessionPath)
      // Should only have user + assistant, not the snapshot
      expect(messages).toHaveLength(2)
      const types = messages.map(m => m.role)
      expect(types).toEqual(['user', 'assistant'])
    })

    it('parses assistant message with model and token usage', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const assistant = messages.find(m => m.role === 'assistant')!
      expect(assistant).toBeDefined()
      expect(assistant.model).toBe('claude-opus-4-6')
      expect(assistant.tokenUsage?.input_tokens).toBe(100)
      expect(assistant.tokenUsage?.output_tokens).toBe(50)
      expect(assistant.contentBlocks).toHaveLength(1)
      expect(assistant.contentBlocks[0].text).toBe("I'll build the auth module.")
      expect(assistant.requestId).toBe('req-1')
    })
  })

  describe('correction detection (dddddddd)', () => {
    const sessionPath = join(FIXTURES, 'dddddddd-1111-2222-3333-444444444444.jsonl')

    it('detects "no, not that" as a correction', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg3 = messages.find(m => m.uuid === 'dd-msg-3')!
      expect(msg3.isCorrection).toBe(true)
    })

    it('detects "stop, don\'t do that" as a correction', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg9 = messages.find(m => m.uuid === 'dd-msg-9')!
      expect(msg9.isCorrection).toBe(true)
    })

    it('does not mark normal user messages as corrections', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg1 = messages.find(m => m.uuid === 'dd-msg-1')!
      expect(msg1.isCorrection).toBe(false)
    })

    it('does not mark tool_result messages as corrections', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg5 = messages.find(m => m.uuid === 'dd-msg-5')!
      expect(msg5.isCorrection).toBe(false)
    })

    it('detects ALL CAPS messages as corrections', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg11 = messages.find(m => m.uuid === 'dd-msg-11')!
      expect(msg11.isCorrection).toBe(true)
    })
  })

  describe('tool name propagation to error messages (dddddddd)', () => {
    const sessionPath = join(FIXTURES, 'dddddddd-1111-2222-3333-444444444444.jsonl')

    it('propagates tool name from assistant tool_use to user tool_result error', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg5 = messages.find(m => m.uuid === 'dd-msg-5')!
      expect(msg5.isError).toBe(true)
      expect(msg5.toolNames).toEqual(['Read'])
    })

    it('propagates tool name regardless of error status', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg7 = messages.find(m => m.uuid === 'dd-msg-7')!
      expect(msg7.toolNames).toEqual(['Bash'])
    })

    // Regression test for finding B1: dd-msg-7's tool_result carries a
    // non-empty stderr but NO explicit is_error flag. The old heuristic
    // treated any non-empty stderr as an error; the fix requires an
    // explicit signal from the source. Updated from the old expectation of
    // `true` (see git history) — that expectation encoded the bug.
    it('does NOT flag a tool result as an error from stderr alone (finding B1)', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg7 = messages.find(m => m.uuid === 'dd-msg-7')!
      expect(msg7.isError).toBe(false)
    })

    it('does not set toolNames on non-tool-result user messages', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg1 = messages.find(m => m.uuid === 'dd-msg-1')!
      expect(msg1.toolNames).toBeUndefined()
    })
  })

  describe('per-block isError (finding B17)', () => {
    const sessionPath = join(FIXTURES, 'dddddddd-1111-2222-3333-444444444444.jsonl')

    it('sets isError=true on the tool_result block with an explicit is_error flag', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg5 = messages.find(m => m.uuid === 'dd-msg-5')!
      const block = msg5.contentBlocks.find(b => b.type === 'tool_result')!
      expect(block.isError).toBe(true)
    })

    it('sets isError=false on a tool_result block with no explicit flag, even with stderr', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const msg7 = messages.find(m => m.uuid === 'dd-msg-7')!
      const block = msg7.contentBlocks.find(b => b.type === 'tool_result')!
      expect(block.isError).toBe(false)
    })
  })

  describe('multi-block session (cccccccc)', () => {
    const sessionPath = join(FIXTURES, 'cccccccc-1111-2222-3333-444444444444.jsonl')

    it('groups assistant content blocks by requestId into single NormalizedMessage', async () => {
      const messages = await collectMessages(parser, sessionPath)
      // Expected: user, assistant(3 blocks grouped), user(tool_result), assistant
      const assistantMsgs = messages.filter(m => m.role === 'assistant')
      expect(assistantMsgs).toHaveLength(2)

      // First assistant message should have all 3 blocks from req-10
      const first = assistantMsgs[0]
      expect(first.requestId).toBe('req-10')
      expect(first.contentBlocks).toHaveLength(3)
      expect(first.contentBlocks[0].type).toBe('thinking')
      expect(first.contentBlocks[0].thinking).toBe('')
      expect(first.contentBlocks[1].type).toBe('text')
      expect(first.contentBlocks[1].text).toContain('refactor the database layer')
      expect(first.contentBlocks[2].type).toBe('tool_use')
      expect(first.contentBlocks[2].name).toBe('Edit')

      // Tool names should be collected
      expect(first.toolNames).toEqual(['Edit'])

      // Token usage should reflect the max across chunks
      expect(first.tokenUsage?.input_tokens).toBe(200)
      expect(first.tokenUsage?.output_tokens).toBe(100)
    })

    it('skips file-history-snapshot and queue-operation lines without crashing', async () => {
      const messages = await collectMessages(parser, sessionPath)
      // Should not include file-history-snapshot or queue-operation
      for (const msg of messages) {
        expect(msg.role).toMatch(/^(user|assistant)$/)
      }
      // Total: user, assistant(grouped), user(tool_result), assistant = 4
      expect(messages).toHaveLength(4)
    })

    it('parses user tool_result messages', async () => {
      const messages = await collectMessages(parser, sessionPath)
      const userMsgs = messages.filter(m => m.role === 'user')
      expect(userMsgs).toHaveLength(2)

      // First user: text content
      expect(userMsgs[0].contentBlocks[0].type).toBe('text')
      expect(userMsgs[0].contentBlocks[0].text).toBe('Refactor the database layer')

      // Second user: tool_result content
      expect(userMsgs[1].contentBlocks[0].type).toBe('tool_result')
      expect(userMsgs[1].contentBlocks[0].tool_use_id).toBe('tool-1')
    })

    it('supports streaming from byte offset (fewer messages when offset > 0)', async () => {
      const allMessages = await collectMessages(parser, sessionPath)
      expect(allMessages.length).toBeGreaterThan(0)

      // Read with offset past the first few lines — should get fewer messages
      // The first line is the snapshot (~150 bytes), second is user (~350 bytes)
      // Use a large enough offset to skip at least the snapshot + first user
      const offset = 600
      const partialMessages = await collectMessages(parser, sessionPath, offset)
      expect(partialMessages.length).toBeLessThan(allMessages.length)
      expect(partialMessages.length).toBeGreaterThan(0)
    })
  })
})
