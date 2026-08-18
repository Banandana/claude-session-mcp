import { basename } from 'node:path'
import { streamJsonlLines } from '../../infrastructure/file-system'
import type { ContentBlock, MessageRole, NormalizedMessage } from '../../types'
import { detectCorrection, isToolResultError } from '../../services/heuristics'
import { extractSessionIdFromFilename } from './rollout-header'
import {
  explicitOutputError,
  extractTextBlocks,
  joinOutputText,
  parseFunctionCallArguments,
  translateTokenUsage,
} from './content-utils'

/**
 * Codex rollout line shapes (all top-level lines):
 *   {timestamp, type:"session_meta", payload:{id, session_id, cwd, originator, cli_version, thread_source, source}}
 *   {timestamp, type:"turn_context", payload:{turn_id, cwd, model}}
 *   {timestamp, type:"response_item", payload:{type:"message", id, role, content[]}}
 *   {timestamp, type:"response_item", payload:{type:"reasoning", id, summary, encrypted_content}}
 *   {timestamp, type:"response_item", payload:{type:"function_call", id, name, arguments, call_id}}
 *   {timestamp, type:"response_item", payload:{type:"custom_tool_call", id, name, input, call_id}}
 *   {timestamp, type:"response_item", payload:{type:"function_call_output"|"custom_tool_call_output", id, call_id, output, success?, error?}}
 *   {timestamp, type:"event_msg", payload:{type:"token_count", info:{last_token_usage, total_token_usage}}}
 *   {timestamp, type:"event_msg", payload:{type:"patch_apply_end"|"sub_agent_activity"|"task_started"|"task_complete", ...}}
 *   {timestamp, type:"compacted", payload:{message, replacement_history[]}}
 *
 * Unlike claude-code (content blocks batched under one requestId) or pi
 * (one full message object per line), Codex splits an assistant turn across
 * multiple atomic response_item lines: reasoning, then zero or more
 * function_call/custom_tool_call lines (each paired with its own
 * function_call_output/custom_tool_call_output line, interleaved), then
 * optionally a final message line. Each becomes its own NormalizedMessage —
 * "two lines joined by call_id" per the format doc, not merged into one.
 *
 * event_msg/patch_apply_end, sub_agent_activity, task_started, task_complete,
 * and compacted/context_compacted carry no NormalizedMessage of their own
 * here — they're handled by CodexFileChangeExtractor and CodexMetadataParser
 * respectively (mirrors how claude-code's file-history-snapshot and
 * marble-origami-commit lines are skipped by its ConversationParser too).
 */

interface CodexLine {
  readonly timestamp?: string
  readonly type?: string
  readonly payload?: unknown
}

interface CodexSessionMetaPayload {
  readonly cwd?: string
  readonly originator?: string
}

interface CodexTurnContextPayload {
  readonly cwd?: string
  readonly model?: string
}

interface CodexMessagePayload {
  readonly id?: string
  readonly role?: string
  readonly content?: unknown
}

interface CodexReasoningPayload {
  readonly id?: string
}

interface CodexCallPayload {
  readonly id?: string
  readonly name?: string
  readonly call_id?: string
  readonly arguments?: string
  readonly input?: string
}

interface CodexOutputPayload {
  readonly id?: string
  readonly call_id?: string
  readonly output?: unknown
  readonly success?: unknown
  readonly error?: unknown
}

interface CodexTokenCountPayload {
  readonly info?: {
    readonly last_token_usage?: {
      readonly input_tokens?: number
      readonly cached_input_tokens?: number
      readonly cache_write_input_tokens?: number
      readonly output_tokens?: number
    }
  }
}

function baseFields(
  id: string,
  sessionId: string,
  role: MessageRole,
  timestamp: string,
  cwd: string | undefined,
  entrypoint: string | undefined,
): Pick<
  NormalizedMessage,
  'id' | 'sessionId' | 'role' | 'timestamp' | 'isError' | 'isCorrection' | 'hasThinking' | 'parentUuid' | 'uuid' | 'cwd' | 'entrypoint'
> {
  return {
    id,
    sessionId,
    role,
    timestamp,
    isError: false,
    isCorrection: false,
    hasThinking: false,
    parentUuid: null,
    uuid: id,
    cwd,
    entrypoint,
  }
}

export class CodexConversationParser {
  async *parseSession(sessionPath: string, startOffset: number = 0): AsyncIterable<NormalizedMessage> {
    const sessionId = extractSessionIdFromFilename(basename(sessionPath)) ?? basename(sessionPath, '.jsonl')

    let sessionCwd: string | undefined
    let sessionEntrypoint: string | undefined
    let currentModel: string | undefined
    let currentCwd: string | undefined
    const callIdToName = new Map<string, string>()

    // Lookahead buffer covering the current tool-call "round": the one
    // assistant-authored message that opened it (reasoning / tool_use /
    // final text) plus any tool_result lines that follow it, held back
    // (not yet yielded) so a trailing token_count line can still attach its
    // last_token_usage to the assistant entry before the whole round is
    // flushed IN ORDER. Only a NEW assistant-authored line, a token_count,
    // a user/developer line, or end-of-stream flushes it — chronological
    // emission order (tool_use before its own tool_result) is preserved
    // either way since both travel through the same buffer together.
    let buffer: NormalizedMessage[] = []
    let assistantIndex: number | undefined

    function* flushBuffer(): Generator<NormalizedMessage> {
      for (const msg of buffer) yield msg
      buffer = []
      assistantIndex = undefined
    }

    for await (const { line } of streamJsonlLines(sessionPath, startOffset)) {
      let parsed: CodexLine
      try {
        parsed = JSON.parse(line) as CodexLine
      } catch {
        continue
      }

      const topType = parsed.type
      const ts = parsed.timestamp ?? new Date().toISOString()

      if (topType === 'session_meta') {
        const payload = parsed.payload as CodexSessionMetaPayload | undefined
        sessionCwd = payload?.cwd
        sessionEntrypoint = payload?.originator
        currentCwd = sessionCwd
        continue
      }

      if (topType === 'turn_context') {
        const payload = parsed.payload as CodexTurnContextPayload | undefined
        if (payload?.model) currentModel = payload.model
        if (payload?.cwd) currentCwd = payload.cwd
        continue
      }

      if (topType === 'event_msg') {
        const payload = parsed.payload as { type?: string } | undefined
        if (payload?.type === 'token_count') {
          const usage = translateTokenUsage((payload as CodexTokenCountPayload).info?.last_token_usage)
          if (assistantIndex !== undefined && usage) {
            const target = buffer[assistantIndex]
            if (target) buffer[assistantIndex] = { ...target, tokenUsage: usage }
          }
          yield* flushBuffer()
        }
        // patch_apply_end -> FileChangeExtractor; sub_agent_activity,
        // task_started, task_complete, context_compacted -> no message.
        continue
      }

      if (topType !== 'response_item') {
        // compacted -> MetadataParser (ContextCollapse); anything else unknown.
        continue
      }

      const payload = parsed.payload as { type?: string } | undefined
      const itemType = payload?.type

      if (itemType === 'message') {
        const mp = payload as CodexMessagePayload
        const role = mp.role
        const blocks = extractTextBlocks(mp.content)
        const id = mp.id ?? `msg-${ts}`

        if (role === 'user') {
          yield* flushBuffer()
          yield {
            ...baseFields(id, sessionId, 'user', ts, currentCwd, sessionEntrypoint),
            contentBlocks: blocks,
            isCorrection: detectCorrection(blocks),
          }
          continue
        }

        if (role === 'developer') {
          yield* flushBuffer()
          yield {
            ...baseFields(id, sessionId, 'system', ts, currentCwd, sessionEntrypoint),
            contentBlocks: blocks,
          }
          continue
        }

        if (role === 'assistant') {
          yield* flushBuffer()
          buffer.push({
            ...baseFields(id, sessionId, 'assistant', ts, currentCwd, sessionEntrypoint),
            contentBlocks: blocks,
            model: currentModel,
          })
          assistantIndex = buffer.length - 1
          continue
        }
        continue
      }

      if (itemType === 'reasoning') {
        const rp = payload as CodexReasoningPayload
        const id = rp.id ?? `reasoning-${ts}`
        yield* flushBuffer()
        buffer.push({
          ...baseFields(id, sessionId, 'assistant', ts, currentCwd, sessionEntrypoint),
          // encrypted_content is ciphertext, not real thinking text — never
          // surfaced as block text. hasThinking flags its presence instead.
          contentBlocks: [{ type: 'thinking', thinking: '' }],
          model: currentModel,
          hasThinking: true,
        })
        assistantIndex = buffer.length - 1
        continue
      }

      if (itemType === 'function_call' || itemType === 'custom_tool_call') {
        const cp = payload as CodexCallPayload
        const callId = cp.call_id
        const name = typeof cp.name === 'string' && cp.name.length > 0 ? cp.name : 'unknown'
        if (callId) callIdToName.set(callId, name)

        const input =
          itemType === 'function_call' ? parseFunctionCallArguments(cp.arguments) : cp.input
        const id = cp.id ?? `call-${ts}`

        const block: ContentBlock = { type: 'tool_use', id: callId, name, input }

        yield* flushBuffer()
        buffer.push({
          ...baseFields(id, sessionId, 'assistant', ts, currentCwd, sessionEntrypoint),
          contentBlocks: [block],
          model: currentModel,
          toolNames: [name],
        })
        assistantIndex = buffer.length - 1
        continue
      }

      if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
        const op = payload as CodexOutputPayload
        const callId = op.call_id
        const resolvedName = callId ? callIdToName.get(callId) : undefined
        const content = joinOutputText(op.output)
        const isError = isToolResultError({ explicitError: explicitOutputError(op) })
        const id = op.id ?? `output-${ts}`

        // Appended to the buffer (not yielded directly) so it stays right
        // after its tool_use in emission order even though the tool_use is
        // still being held open for a possible trailing token_count.
        buffer.push({
          ...baseFields(id, sessionId, 'user', ts, currentCwd, sessionEntrypoint),
          contentBlocks: [
            { type: 'tool_result', tool_use_id: callId, content, isError },
          ],
          toolNames: resolvedName ? [resolvedName] : undefined,
          isError,
        })
        continue
      }

      // Unknown response_item type — skip.
    }

    yield* flushBuffer()
  }
}
