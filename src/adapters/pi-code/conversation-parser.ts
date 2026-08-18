import { basename } from 'node:path'
import { streamJsonlLines } from '../../infrastructure/file-system'
import type { NormalizedMessage, ContentBlock, TokenUsage, MessageRole } from '../../types'
import { extractSessionIdFromFilename } from './session-discovery'
import { detectCorrection, isToolResultError } from '../../services/heuristics'

/**
 * Pi JSONL line shapes:
 *   {type:"session", version, id, timestamp, cwd}
 *   {type:"model_change", id, parentId, timestamp, provider, modelId}
 *   {type:"thinking_level_change", id, parentId, timestamp, thinkingLevel}
 *   {type:"message", id, parentId, timestamp, message:{role, content[], ...}}
 *   {type:"compaction", id, parentId, timestamp, summary, details, tokensBefore, ...}
 *   {type:"custom", customType, data, id, parentId, timestamp}
 *
 * Pi message roles: user | assistant | toolResult
 * Pi content block types: text | thinking | toolCall
 * Pi toolResult message also has top-level fields: toolCallId, toolName, isError, content[]
 */

interface PiRawLine {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  // session line
  version?: number
  cwd?: string
  // model_change
  provider?: string
  modelId?: string
  // message wrapper
  message?: PiMessage
  // compaction
  summary?: string
  details?: string
  tokensBefore?: number
  firstKeptEntryId?: string
  fromHook?: boolean
}

interface PiMessage {
  role?: string
  content?: unknown
  timestamp?: string | number
  // assistant-only
  model?: string
  provider?: string
  api?: string
  responseId?: string
  stopReason?: string | null
  errorMessage?: string
  usage?: PiUsage
  // toolResult-only
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

interface PiUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  cost?: { total?: number }
}

interface PiToolCallBlock {
  type: 'toolCall'
  id?: string
  name?: string
  arguments?: unknown
}

interface PiTextBlock {
  type: 'text'
  text?: string
}

interface PiThinkingBlock {
  type: 'thinking'
  thinking?: string
  thinkingSignature?: string
}

type PiContentBlock = PiToolCallBlock | PiTextBlock | PiThinkingBlock | Record<string, unknown>

function translateUsage(u: PiUsage | undefined): TokenUsage | undefined {
  if (!u) return undefined
  const input = u.input ?? 0
  const output = u.output ?? 0
  if (input === 0 && output === 0 && (u.cacheRead ?? 0) === 0 && (u.cacheWrite ?? 0) === 0) {
    return undefined
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: u.cacheWrite ? u.cacheWrite : undefined,
    cache_read_input_tokens: u.cacheRead ? u.cacheRead : undefined,
  }
}

function translateBlocks(piBlocks: unknown): { blocks: ContentBlock[]; toolNames: string[]; hasThinking: boolean } {
  const blocks: ContentBlock[] = []
  const toolNames: string[] = []
  let hasThinking = false

  if (!Array.isArray(piBlocks)) {
    if (typeof piBlocks === 'string') {
      blocks.push({ type: 'text', text: piBlocks })
    }
    return { blocks, toolNames, hasThinking }
  }

  for (const raw of piBlocks as PiContentBlock[]) {
    if (!raw || typeof raw !== 'object') continue
    const t = (raw as Record<string, unknown>)['type']
    if (t === 'text') {
      const text = (raw as PiTextBlock).text
      blocks.push({ type: 'text', text: typeof text === 'string' ? text : '' })
    } else if (t === 'thinking') {
      hasThinking = true
      const thinking = (raw as PiThinkingBlock).thinking
      const block: ContentBlock = {
        type: 'thinking',
        thinking: typeof thinking === 'string' ? thinking : '',
      }
      const sig = (raw as PiThinkingBlock).thinkingSignature
      if (sig) (block as { signature?: string }).signature = sig
      blocks.push(block)
    } else if (t === 'toolCall') {
      const tc = raw as PiToolCallBlock
      const name = typeof tc.name === 'string' && tc.name.length > 0 ? tc.name : 'unknown'
      toolNames.push(name)
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name,
        input: tc.arguments,
      })
    }
    // unknown block types silently dropped
  }
  return { blocks, toolNames, hasThinking }
}

function buildToolResultBlocks(msg: PiMessage): ContentBlock[] {
  const content = msg.content
  let stringContent: unknown = content
  if (Array.isArray(content)) {
    // Pi toolResult content is `[{type:"text", text:"..."}]`. Collapse to the raw text or array.
    const texts: string[] = []
    for (const blk of content) {
      if (blk && typeof blk === 'object' && (blk as Record<string, unknown>)['type'] === 'text') {
        const txt = (blk as { text?: unknown }).text
        if (typeof txt === 'string') texts.push(txt)
      }
    }
    stringContent = texts.length > 0 ? texts.join('\n') : content
  }
  return [
    {
      type: 'tool_result',
      tool_use_id: msg.toolCallId,
      content: stringContent,
      // Explicit signal only (finding B1/B17) — surfaced on the block so a
      // caller expanding a turn with several tool results can tell which
      // one failed.
      isError: isToolResultError({ explicitError: msg.isError === true }),
    },
  ]
}

/**
 * Authoritative only — see services/heuristics/error-detection.ts
 * (finding B1). Text content is never consulted.
 */
function detectToolResultError(msg: PiMessage): boolean {
  let text: string | undefined
  if (Array.isArray(msg.content)) {
    const texts: string[] = []
    for (const blk of msg.content as Record<string, unknown>[]) {
      const txt = blk?.['text']
      if (typeof txt === 'string') texts.push(txt)
    }
    text = texts.length > 0 ? texts.join('\n') : undefined
  } else if (typeof msg.content === 'string') {
    text = msg.content
  }
  return isToolResultError({ explicitError: msg.isError === true, text })
}

function timestampStr(ts: string | number | undefined, fallback: string | undefined): string {
  if (typeof ts === 'string' && ts.length > 0) return ts
  if (typeof ts === 'number' && isFinite(ts)) {
    // pi sometimes stores message.timestamp as epoch-ms
    return new Date(ts).toISOString()
  }
  return fallback ?? new Date().toISOString()
}

export class PiConversationParser {
  async *parseSession(sessionPath: string, startOffset: number = 0): AsyncIterable<NormalizedMessage> {
    const sessionId = extractSessionIdFromFilename(basename(sessionPath)) ?? basename(sessionPath, '.jsonl')

    let currentModel: string | undefined
    let sessionCwd: string | undefined
    const toolCallIdToName = new Map<string, string>()

    for await (const { line } of streamJsonlLines(sessionPath, startOffset)) {
      let parsed: PiRawLine
      try {
        parsed = JSON.parse(line) as PiRawLine
      } catch {
        continue
      }

      const t = parsed.type
      if (t === 'session') {
        sessionCwd = parsed.cwd
        continue
      }
      if (t === 'model_change') {
        if (parsed.modelId) currentModel = parsed.modelId
        continue
      }
      if (t === 'thinking_level_change') {
        continue
      }
      if (t === 'compaction') {
        // Surface as a system message so downstream sees the break point.
        yield {
          id: parsed.id ?? `compaction-${parsed.timestamp ?? Date.now()}`,
          sessionId,
          role: 'system' as MessageRole,
          timestamp: parsed.timestamp ?? new Date().toISOString(),
          contentBlocks: [
            { type: 'text', text: `[compaction] ${parsed.summary ?? ''}\n${parsed.details ?? ''}`.trim() },
          ],
          isError: false,
          isCorrection: false,
          hasThinking: false,
          parentUuid: parsed.parentId ?? null,
          uuid: parsed.id ?? `compaction-${Date.now()}`,
          cwd: sessionCwd,
        }
        continue
      }
      if (t === 'custom') {
        // Skip — these are tool-specific side-channels (e.g. plannotator).
        continue
      }
      if (t !== 'message') continue

      const msg = parsed.message
      if (!msg) continue

      const role = msg.role
      const ts = timestampStr(msg.timestamp, parsed.timestamp)

      if (role === 'user') {
        const { blocks } = translateBlocks(msg.content)
        yield {
          id: parsed.id ?? `user-${ts}`,
          sessionId,
          role: 'user' as MessageRole,
          timestamp: ts,
          contentBlocks: blocks,
          isError: false,
          isCorrection: detectCorrection(blocks),
          hasThinking: false,
          parentUuid: parsed.parentId ?? null,
          uuid: parsed.id ?? `user-${ts}`,
          cwd: sessionCwd,
        }
        continue
      }

      if (role === 'assistant') {
        const { blocks, toolNames, hasThinking } = translateBlocks(msg.content)
        // Track tool_use IDs for toolResult name resolution.
        for (const b of blocks) {
          if (b.type === 'tool_use' && b.id && b.name) {
            toolCallIdToName.set(b.id, b.name)
          }
        }
        yield {
          id: parsed.id ?? `assistant-${ts}`,
          sessionId,
          role: 'assistant' as MessageRole,
          timestamp: ts,
          contentBlocks: blocks,
          model: msg.model ?? currentModel,
          tokenUsage: translateUsage(msg.usage),
          toolNames: toolNames.length > 0 ? toolNames : undefined,
          isError: typeof msg.errorMessage === 'string' && msg.errorMessage.length > 0,
          isCorrection: false,
          hasThinking,
          requestId: msg.responseId,
          parentUuid: parsed.parentId ?? null,
          uuid: parsed.id ?? `assistant-${ts}`,
          cwd: sessionCwd,
        }
        continue
      }

      if (role === 'toolResult') {
        const blocks = buildToolResultBlocks(msg)
        const resolvedName = msg.toolName ?? (msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined)
        const toolNames = resolvedName ? [resolvedName] : undefined
        yield {
          id: parsed.id ?? `toolresult-${ts}`,
          sessionId,
          // Map toolResult onto 'user' role to match Claude's convention
          // (where tool_result blocks ride on user messages).
          role: 'user' as MessageRole,
          timestamp: ts,
          contentBlocks: blocks,
          toolNames,
          isError: detectToolResultError(msg),
          isCorrection: false,
          hasThinking: false,
          parentUuid: parsed.parentId ?? null,
          uuid: parsed.id ?? `toolresult-${ts}`,
          cwd: sessionCwd,
        }
        continue
      }
    }
  }
}
