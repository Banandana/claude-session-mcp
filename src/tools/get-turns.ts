import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { NormalizedMessage, ContentBlock } from '../types'
import type { ExpandedTurn } from '../types/conversation'
import { isValidSessionId } from './shared/session-id'

export type { ExpandedTurn }

// --- Truncation logic ---

const CHARS_PER_TOKEN = 4

function estimateBlockTokens(block: ContentBlock): number {
  let chars = 0
  if (block.text) chars += block.text.length
  if (block.input) chars += JSON.stringify(block.input).length
  if (block.content) chars += typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length
  if (block.thinking) chars += block.thinking.length
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function truncateBlock(block: ContentBlock, field: 'content' | 'input' | 'text' | 'thinking', maxChars: number): ContentBlock {
  if (field === 'content' && typeof block.content === 'string' && block.content.length > maxChars) {
    return { ...block, content: block.content.slice(0, maxChars) + '\n[truncated]' }
  }
  if (field === 'input' && block.input) {
    return { ...block, input: { _truncated: true } }
  }
  if (field === 'text' && block.text && block.text.length > maxChars) {
    return { ...block, text: block.text.slice(0, maxChars) + '\n[truncated]' }
  }
  if (field === 'thinking' && block.thinking && block.thinking.length > maxChars) {
    return { ...block, thinking: block.thinking.slice(0, maxChars) + '\n[truncated]' }
  }
  return block
}

export function truncateBlocks(blocks: readonly ContentBlock[], maxTokens: number): { blocks: ContentBlock[]; truncated: boolean } {
  let totalTokens = blocks.reduce((sum, b) => sum + estimateBlockTokens(b), 0)
  if (totalTokens <= maxTokens) return { blocks: [...blocks], truncated: false }

  const result = [...blocks]

  const truncatePass = (
    filter: (b: ContentBlock) => boolean,
    field: 'content' | 'input' | 'text' | 'thinking',
  ): void => {
    const indices = result
      .map((b, i) => ({ block: b, idx: i }))
      .filter(({ block }) => filter(block))
      .sort((a, b) => estimateBlockTokens(b.block) - estimateBlockTokens(a.block))

    for (const { idx } of indices) {
      if (totalTokens <= maxTokens) break
      const block = result[idx]
      if (!block) continue
      const before = estimateBlockTokens(block)
      const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN * 0.3)
      const truncated = truncateBlock(block, field, maxChars)
      result[idx] = truncated
      totalTokens -= before - estimateBlockTokens(truncated)
    }
  }

  // Pass 1: truncate tool_result content
  truncatePass(b => b.type === 'tool_result' && b.content !== undefined, 'content')
  // Pass 2: truncate tool_use input
  if (totalTokens > maxTokens) truncatePass(b => b.type === 'tool_use' && b.input !== undefined, 'input')
  // Pass 3: truncate thinking blocks — reasoning is the least load-bearing
  // content in an expansion, so it goes before text.
  if (totalTokens > maxTokens) truncatePass(b => b.type === 'thinking' && b.thinking !== undefined, 'thinking')
  // Pass 4: truncate text blocks
  if (totalTokens > maxTokens) truncatePass(b => b.type === 'text' && b.text !== undefined, 'text')

  return { blocks: result, truncated: true }
}

export function truncateTurns(turns: readonly ExpandedTurn[], maxTokens: number): { turns: ExpandedTurn[]; truncated: boolean } {
  const perTurnBudget = Math.floor(maxTokens / Math.max(turns.length, 1))
  let truncated = false
  const result = turns.map(turn => {
    const blockResult = truncateBlocks(turn.contentBlocks, perTurnBudget)
    if (blockResult.truncated) truncated = true
    return { ...turn, contentBlocks: blockResult.blocks }
  })

  // Pass 5: drop middle turns if still over budget
  const estimateTotal = () => result.reduce((sum, t) =>
    sum + t.contentBlocks.reduce((s, b) => s + estimateBlockTokens(b), 0), 0)

  while (result.length > 2 && estimateTotal() > maxTokens) {
    const midIdx = Math.floor(result.length / 2)
    result.splice(midIdx, 1)
    truncated = true
  }

  return { turns: result, truncated }
}

// --- Helper: convert NormalizedMessage to ExpandedTurn ---

function messageToExpandedTurn(msg: NormalizedMessage, turnIndex: number, includeThinking: boolean = false): ExpandedTurn {
  const contentBlocks = includeThinking
    ? [...msg.contentBlocks]
    : msg.contentBlocks.filter(b => b.type !== 'thinking')

  return {
    turnIndex,
    turnId: msg.uuid,
    role: msg.role,
    timestamp: msg.timestamp,
    contentBlocks,
    toolNames: msg.toolNames ? [...msg.toolNames] : [],
    isError: msg.isError,
    isCorrection: msg.isCorrection,
    hasThinking: msg.hasThinking,
    model: msg.model,
    tokenUsage: msg.tokenUsage
      ? { input_tokens: msg.tokenUsage.input_tokens, output_tokens: msg.tokenUsage.output_tokens }
      : undefined,
    cacheTokens: msg.tokenUsage?.cache_creation_input_tokens || msg.tokenUsage?.cache_read_input_tokens
      ? {
          creation: msg.tokenUsage.cache_creation_input_tokens ?? 0,
          read: msg.tokenUsage.cache_read_input_tokens ?? 0,
        }
      : undefined,
  }
}

// --- Tool registration ---

interface SessionRow {
  readonly project_slug: string | null
}

export function registerGetTurns(server: McpServer): void {
  server.tool(
    'get_turns',
    'Get full content for specific turns in a session — tool inputs, tool outputs, text. Use after query_turns to expand interesting results.',
    {
      sessionId: z.string().describe('Session ID'),
      turnIds: z.array(z.string()).max(50).optional().describe('Specific turn UUIDs (max 50)'),
      turnRange: z.object({
        from: z.number().describe('Start index (inclusive)'),
        to: z.number().describe('End index (inclusive)'),
      }).optional().describe('Inclusive index range (max 50 turns)'),
      includeToolResults: z.boolean().optional().describe('Include tool_result blocks (default: true)'),
      includeThinking: z.boolean().optional().describe('Include thinking/reasoning blocks (default: false)'),
      maxTokens: z.number().optional().describe('Token budget cap for response'),
    },
    async (params) => {
      // Validate: one of turnIds or turnRange required, mutually exclusive
      const hasTurnIds = params.turnIds !== undefined && params.turnIds.length > 0
      const hasTurnRange = params.turnRange !== undefined
      if (!hasTurnIds && !hasTurnRange) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'One of turnIds or turnRange is required' }, null, 2) }],
        }
      }
      if (hasTurnIds && hasTurnRange) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'turnIds and turnRange are mutually exclusive' }, null, 2) }],
        }
      }
      if (hasTurnRange) {
        const rangeSize = params.turnRange!.to - params.turnRange!.from + 1
        if (rangeSize > 50) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'turnRange max 50 turns' }, null, 2) }],
          }
        }
        if (rangeSize < 1) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'turnRange.to must be >= turnRange.from' }, null, 2) }],
          }
        }
      }

      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.get<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()
      const registry = container.get<AdapterRegistry>(TOKENS.AdapterRegistry)

      const freshness = await freshnessGuard.ensureFresh()

      if (!isValidSessionId(params.sessionId)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Invalid session ID format: ${params.sessionId}` }, null, 2) }],
        }
      }

      // Look up session to confirm it exists
      const session = db.prepare(
        `SELECT project_slug FROM sessions WHERE id = ?`
      ).get(params.sessionId) as SessionRow | undefined

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Session not found: ${params.sessionId}` }, null, 2) }],
        }
      }

      // Route through adapter registry — handles both claude and pi session layouts
      const includeToolResults = params.includeToolResults !== false

      const turnIdSet = hasTurnIds ? new Set(params.turnIds) : null
      const rangeFrom = hasTurnRange ? params.turnRange!.from : -1
      const rangeTo = hasTurnRange ? params.turnRange!.to : -1
      const includeThinking = params.includeThinking === true

      const expandedTurns: ExpandedTurn[] = []
      let turnIndex = 0

      try {
        for await (const msg of registry.getMessages(params.sessionId)) {
          const matchById = turnIdSet !== null && turnIdSet.has(msg.uuid)
          const matchByRange = hasTurnRange && turnIndex >= rangeFrom && turnIndex <= rangeTo

          if (matchById || matchByRange) {
            let turn = messageToExpandedTurn(msg, turnIndex, includeThinking)

            // Optionally strip tool results
            if (!includeToolResults) {
              const filtered = turn.contentBlocks.filter(b => b.type !== 'tool_result')
              turn = { ...turn, contentBlocks: filtered }
            }

            expandedTurns.push(turn)
          }

          turnIndex++
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to read session file: ${(err as Error).message}` }, null, 2) }],
        }
      }

      // Apply maxTokens truncation
      let truncated = false
      let resultTurns: readonly ExpandedTurn[] = expandedTurns
      if (params.maxTokens) {
        const truncResult = truncateTurns(expandedTurns, params.maxTokens)
        resultTurns = truncResult.turns
        truncated = truncResult.truncated
      }

      const data = {
        sessionId: params.sessionId,
        turns: resultTurns,
        totalReturned: resultTurns.length,
        totalRequested: hasTurnIds ? params.turnIds!.length : (rangeTo - rangeFrom + 1),
        truncated,
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(data, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
