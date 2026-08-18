import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { CodexConversationParser } from './conversation-parser'
import type { NormalizedMessage } from '../../types'

const SESSIONS_DIR = join(__dirname, '../../../fixtures/codex-home/sessions/2026/08/17')
const PARENT_PATH = join(
  SESSIONS_DIR,
  'rollout-2026-08-17T10-00-00-01a00000-0000-7000-8000-000000000001.jsonl',
)
const CHILD_PATH = join(
  SESSIONS_DIR,
  'rollout-2026-08-17T10-00-11-01a00000-0000-7000-8000-000000000002.jsonl',
)

async function collectMessages(path: string): Promise<NormalizedMessage[]> {
  const parser = new CodexConversationParser()
  const messages: NormalizedMessage[] = []
  for await (const msg of parser.parseSession(path)) {
    messages.push(msg)
  }
  return messages
}

describe('CodexConversationParser (parent rollout)', () => {
  it('parses messages in chronological order with correct roles', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const roles = messages.map(m => m.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'assistant', 'user', 'assistant', 'user', 'assistant'])
  })

  it('maps developer role to system and carries the developer text', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const dev = messages[0]
    expect(dev.role).toBe('system')
    expect(dev.contentBlocks[0]?.type).toBe('text')
    expect(dev.contentBlocks[0]?.text).toContain('permissions instructions')
  })

  it('parses the user turn', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const user = messages[1]
    expect(user.role).toBe('user')
    expect(user.contentBlocks[0]?.text).toBe('add a retry to the fetch helper')
    expect(user.isCorrection).toBe(false)
  })

  it('emits a thinking block with no ciphertext for a reasoning line', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const reasoning = messages[2]
    expect(reasoning.role).toBe('assistant')
    expect(reasoning.hasThinking).toBe(true)
    expect(reasoning.contentBlocks).toHaveLength(1)
    expect(reasoning.contentBlocks[0]?.type).toBe('thinking')
    expect(reasoning.contentBlocks[0]?.thinking).toBe('')
    expect(reasoning.contentBlocks[0]?.text).toBeUndefined()
  })

  it('joins a function_call tool_use with its function_call_output on call_id', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const toolUse = messages[3]
    const toolResult = messages[4]

    expect(toolUse.role).toBe('assistant')
    expect(toolUse.contentBlocks[0]?.type).toBe('tool_use')
    expect(toolUse.contentBlocks[0]?.name).toBe('read_file')
    expect(toolUse.contentBlocks[0]?.id).toBe('call_read_1')
    expect(toolUse.contentBlocks[0]?.input).toEqual({ path: 'src/fetch.ts' })
    expect(toolUse.toolNames).toEqual(['read_file'])

    expect(toolResult.role).toBe('user')
    expect(toolResult.contentBlocks[0]?.type).toBe('tool_result')
    expect(toolResult.contentBlocks[0]?.tool_use_id).toBe('call_read_1')
    expect(toolResult.contentBlocks[0]?.content).toContain('fetchJson')
    expect(toolResult.toolNames).toEqual(['read_file'])
  })

  it('parses custom_tool_call/custom_tool_call_output with free-form input and joined output text', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const execUse = messages[5]
    const execResult = messages[6]

    expect(execUse.contentBlocks[0]?.type).toBe('tool_use')
    expect(execUse.contentBlocks[0]?.name).toBe('exec')
    expect(execUse.contentBlocks[0]?.id).toBe('call_exec_1')
    expect(typeof execUse.contentBlocks[0]?.input).toBe('string')
    expect(execUse.contentBlocks[0]?.input as string).toContain('exec_command')

    expect(execResult.contentBlocks[0]?.tool_use_id).toBe('call_exec_1')
    expect(execResult.contentBlocks[0]?.content).toBe(
      'Script completed\nWall time 1.2 seconds\nOutput:\n3 passing, 0 errors reported\n',
    )
  })

  it('does NOT flag a successful tool result whose text contains the word "errors" as an error', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const execResult = messages[6]
    expect(execResult.contentBlocks[0]?.content).toContain('0 errors reported')
    expect(execResult.isError).toBe(false)
    expect(execResult.contentBlocks[0]?.isError).toBe(false)
  })

  it('attaches token_count.last_token_usage to the tool_use turn it follows', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const execUse = messages[5]
    expect(execUse.tokenUsage).toBeDefined()
    expect(execUse.tokenUsage?.input_tokens).toBe(9000)
    expect(execUse.tokenUsage?.output_tokens).toBe(120)
    expect(execUse.tokenUsage?.cache_read_input_tokens).toBe(4000)
    expect(execUse.tokenUsage?.cache_creation_input_tokens).toBe(128)
  })

  it('does not emit a message for patch_apply_end, sub_agent_activity, compacted, or context_compacted', async () => {
    const messages = await collectMessages(PARENT_PATH)
    // 8 messages total: system, user, reasoning, 2x(tool_use+tool_result), final assistant text
    expect(messages).toHaveLength(8)
  })

  it('emits the final assistant text message with no trailing token usage', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const final = messages[7]
    expect(final.role).toBe('assistant')
    expect(final.contentBlocks[0]?.type).toBe('text')
    expect(final.contentBlocks[0]?.text).toContain('bounded retry')
    expect(final.tokenUsage).toBeUndefined()
  })

  it('carries per-turn model and cwd from turn_context / session_meta', async () => {
    const messages = await collectMessages(PARENT_PATH)
    const assistantMsgs = messages.filter(m => m.role === 'assistant')
    for (const m of assistantMsgs) {
      expect(m.model).toBe('gpt-5.6-sol')
      expect(m.cwd).toBe('/home/test/project-alpha')
    }
  })
})

describe('CodexConversationParser (child/sub-agent rollout)', () => {
  it('parses the child rollout messages directly by path', async () => {
    const messages = await collectMessages(CHILD_PATH)
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages[0]?.contentBlocks[0]?.text).toBe('review the retry helper for unbounded loops')
    expect(messages[1]?.contentBlocks[0]?.text).toBe('Bounded at 3 attempts. No unbounded loop.')
  })

  it('attaches the child token_count usage to its assistant message', async () => {
    const messages = await collectMessages(CHILD_PATH)
    const assistant = messages[1]
    expect(assistant.tokenUsage?.input_tokens).toBe(500)
    expect(assistant.tokenUsage?.output_tokens).toBe(40)
  })
})
