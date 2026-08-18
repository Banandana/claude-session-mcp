import type { NormalizedMessage, ContentBlock, TokenUsage, MessageRole } from '../../types'
import { detectCorrection, isToolResultError } from '../../services/heuristics'
import { fileExists, readTextFile } from '../../infrastructure/file-system'
import type { OpencodeDatabase } from './database'
import type { OpencodeMessageRow, OpencodePartRow } from './schema'
import { friendlyModel } from './schema'

interface OpencodeTokens {
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly cache?: { readonly read?: number; readonly write?: number }
}

/**
 * `message.data` envelope. Assistant messages carry `modelID`/`providerID`
 * as flat fields; user messages instead snapshot the active model as a
 * nested `model` object with no `path`/`cost`/`tokens` — both shapes are
 * read defensively below rather than assuming one.
 */
interface OpencodeMessageData {
  readonly role?: string
  readonly parentID?: string
  readonly path?: { readonly cwd?: string; readonly root?: string }
  readonly cost?: number
  readonly tokens?: OpencodeTokens
  readonly modelID?: string
  readonly providerID?: string
  readonly model?: { readonly modelID?: string; readonly providerID?: string }
  readonly error?: { readonly name?: string; readonly data?: { readonly message?: string } }
}

interface ToolPartMetadata {
  /** True when `output` above was cut short and the full text spilled to disk. */
  readonly truncated?: boolean
  /** Absolute path to the full output, present only when `truncated` is true. */
  readonly outputPath?: string
  /**
   * Some tools (bash) mirror the full text here too; others (webfetch)
   * don't — `outputPath` is the only reliable full-text source, so this
   * field is read defensively and never relied on.
   */
  readonly output?: string
  readonly sessionId?: string
}

interface ToolPartState {
  readonly status?: string
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: string
  readonly title?: string
  readonly metadata?: ToolPartMetadata
}

/**
 * `part.data`'s shape depends on `type` (text/reasoning/tool/patch/
 * compaction/step-start/step-finish/…future). A discriminated union isn't
 * usable here — a runtime JSON.parse gives no real narrowing guarantee,
 * and TS can't narrow a switch on `.type` once an "any other type" branch
 * is in the union — so this is one flat interface covering every variant's
 * fields, mirroring the sibling adapters' JSONL line-shape structs.
 */
interface OpencodePartData {
  readonly type?: string
  readonly text?: string
  readonly tool?: string
  readonly callID?: string
  readonly state?: ToolPartState
  readonly files?: readonly string[]
  readonly tail_start_id?: string
  readonly auto?: boolean
  readonly overflow?: boolean
  readonly tokens?: OpencodeTokens
  readonly cost?: number
}

function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/**
 * Sums one or more `{input,output,reasoning,cache:{read,write}}` blocks
 * into a `TokenUsage`. `TokenUsage` has no reasoning-token field, so
 * reasoning tokens are counted (for the "did anything happen" check) but
 * have nowhere to land in the returned value — a known gap, see the
 * adapter's top-level doc comment.
 */
function sumTokens(blocks: readonly OpencodeTokens[]): TokenUsage | undefined {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let reasoning = 0
  for (const block of blocks) {
    input += block.input ?? 0
    output += block.output ?? 0
    reasoning += block.reasoning ?? 0
    cacheRead += block.cache?.read ?? 0
    cacheWrite += block.cache?.write ?? 0
  }
  if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) return undefined
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite || undefined,
    cache_read_input_tokens: cacheRead || undefined,
  }
}

/**
 * Resolves a tool part's output text using the verified spill-file signal:
 * `state.metadata.truncated === true` plus an absolute
 * `state.metadata.outputPath` pointing at
 * `~/.local/share/opencode/tool-output/<callID>`. The inline `state.output`
 * is NOT a reliable pointer by itself — confirmed against a real opencode
 * database, it stays a long, truncated string (tens of KB) in the spilled
 * case, sometimes with the path mentioned in prose (bash) and sometimes
 * without any mention of it at all (webfetch) — so `metadata` is the only
 * signal ever consulted here.
 *
 * A missing/unreadable spill file, or a missing/relative `outputPath`,
 * never fails the caller — it falls back to the inline `state.output`.
 */
async function resolveToolOutput(inline: unknown, metadata: ToolPartMetadata | undefined): Promise<unknown> {
  const outputPath = metadata?.outputPath
  const isSpilled = metadata?.truncated === true && typeof outputPath === 'string' && outputPath.startsWith('/')
  if (!isSpilled) return inline

  try {
    if (await fileExists(outputPath)) {
      return await readTextFile(outputPath)
    }
  } catch {
    // Never fail the whole session over a missing/unreadable spill file.
  }
  return inline
}

export class OpencodeConversationParser {
  constructor(private readonly database: OpencodeDatabase) {}

  /**
   * One opencode `message` row -> one NormalizedMessage, its `part` rows
   * folded into contentBlocks. Ordered by (message.time_created, part.id):
   * messages are fetched in time_created order and each message's own
   * parts are fetched in part.id order (opencode's part ids are
   * monotonically increasing per message, so this is equivalent to the
   * spec's compound ordering without needing a single cross-message sort).
   */
  async *parseSession(sessionId: string, fallbackCwd: string): AsyncIterable<NormalizedMessage> {
    const db = this.database.get()
    if (!db) return

    const messages = db
      .prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id')
      .all(sessionId) as OpencodeMessageRow[]
    if (messages.length === 0) return

    const partsStmt = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY id')

    for (const message of messages) {
      const data = parseJson<OpencodeMessageData>(message.data) ?? {}
      const parts = partsStmt.all(message.id) as OpencodePartRow[]
      yield await this.toNormalizedMessage(message, data, parts, fallbackCwd)
    }
  }

  private async toNormalizedMessage(
    message: OpencodeMessageRow,
    data: OpencodeMessageData,
    parts: readonly OpencodePartRow[],
    fallbackCwd: string,
  ): Promise<NormalizedMessage> {
    const blocks: ContentBlock[] = []
    const toolNames: string[] = []
    const stepTokenBlocks: OpencodeTokens[] = []
    let hasThinking = false
    let anyToolError = false

    for (const partRow of parts) {
      const part = parseJson<OpencodePartData>(partRow.data)
      if (!part) continue

      switch (part.type) {
        case 'text': {
          blocks.push({ type: 'text', text: part.text ?? '' })
          break
        }
        case 'reasoning': {
          hasThinking = true
          blocks.push({ type: 'thinking', thinking: part.text ?? '' })
          break
        }
        case 'tool': {
          const name = part.tool ?? 'unknown'
          toolNames.push(name)
          const callId = part.callID

          blocks.push({ type: 'tool_use', id: callId, name, input: part.state?.input })

          // Authoritative only — `state.status === 'error'` and nothing
          // else. Never infer failure from output text (finding B1).
          const isError = isToolResultError({ explicitError: part.state?.status === 'error' })
          if (isError) anyToolError = true

          const rawOutput = part.state?.output ?? part.state?.error
          const content = await resolveToolOutput(rawOutput, part.state?.metadata)
          blocks.push({ type: 'tool_result', tool_use_id: callId, content, isError })
          break
        }
        case 'step-finish': {
          if (part.tokens) stepTokenBlocks.push(part.tokens)
          break
        }
        default:
          // 'patch' feeds getFileChanges, 'compaction' feeds
          // getSessionMetadata().collapses, 'step-start' carries only a
          // snapshot hash — none of these are ContentBlocks.
          break
      }
    }

    const tokenUsage =
      stepTokenBlocks.length > 0 ? sumTokens(stepTokenBlocks) : sumTokens(data.tokens ? [data.tokens] : [])

    const role: MessageRole = data.role === 'user' ? 'user' : data.role === 'assistant' ? 'assistant' : 'system'
    const apiError = data.error !== undefined
    const isCorrection = role === 'user' ? detectCorrection(blocks) : false
    const modelId = data.modelID ?? data.model?.modelID
    const providerId = data.providerID ?? data.model?.providerID

    return {
      id: message.id,
      sessionId: message.session_id,
      role,
      timestamp: toIso(message.time_created),
      contentBlocks: blocks,
      model: friendlyModel(providerId, modelId),
      tokenUsage,
      toolNames: toolNames.length > 0 ? toolNames : undefined,
      isError: apiError || anyToolError,
      isCorrection,
      hasThinking,
      parentUuid: data.parentID ?? null,
      uuid: message.id,
      cwd: data.path?.cwd ?? fallbackCwd,
    }
  }
}
