import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { TurnIndexer } from '../services/turn-indexer'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { NormalizedMessage, ContentBlock, MessageRole } from '../types'
import type { TurnReference } from '../types/conversation'
import { extractToolParams } from '../services/tool-summary'
import type { PaginationManager } from '../services/pagination-manager'
import { isValidSessionId } from './shared/session-id'
import type Database from 'better-sqlite3'

// ── Types ──────────────────────────────────────────────────────────────────────

/** Source adapters this server currently knows about (see docs/multi-source-plan.md). */
const VALID_SOURCES = ['claude-code', 'pi-code', 'codex', 'opencode'] as const

interface TurnFilters {
  readonly toolNames?: readonly string[] | undefined
  readonly isError?: boolean | undefined
  readonly isCorrection?: boolean | undefined
  readonly roles?: readonly MessageRole[] | undefined
  readonly textPattern?: string | undefined
  readonly textRegex?: RegExp | undefined
  readonly timeRange?: { readonly after?: string | undefined; readonly before?: string | undefined } | undefined
  readonly turnRange?: { readonly from?: number | undefined; readonly to?: number | undefined } | undefined
  /** Cross-session (project-scoped) queries only — ignored when scoped to a single sessionId. */
  readonly source?: string | readonly string[] | undefined
}

interface FilterResult {
  readonly matches: boolean
  readonly matchContext?: string | undefined
}

interface SessionRow {
  readonly project_slug: string | null
}

interface UnindexedSessionRow {
  readonly id: string
  readonly project_slug: string | null
}

interface TurnEventRow {
  readonly session_id: string
  readonly turn_index: number
  readonly turn_id: string
  readonly role: string
  readonly timestamp: string
  readonly tool_names: string
  readonly is_error: number
  readonly is_correction: number
  readonly text_preview: string | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function parseToolNames(json: string): readonly string[] {
  try {
    const parsed = JSON.parse(json) as string[]
    return parsed.length > 0 ? parsed : []
  } catch {
    return []
  }
}

export function summarizeFromDbRow(isError: boolean, toolNames: readonly string[], textPreview: string | null): string {
  if (isError && textPreview) {
    const truncated = textPreview.length > 120 ? textPreview.slice(0, 120) + '...' : textPreview
    return `[error: ${truncated}]`
  }
  if (toolNames.length > 1) return `[${toolNames.join(', ')}]`
  if (toolNames.length === 1) return `[${toolNames[0]}]`
  if (textPreview) return textPreview.length > 120 ? textPreview.slice(0, 120) + '...' : textPreview
  return ''
}

function getTextContent(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text)
    }
    if (block.type === 'tool_result' && block.content) {
      if (typeof block.content === 'string') {
        parts.push(block.content)
      }
    }
  }
  return parts.join(' ')
}

export function summarizeMessage(msg: NormalizedMessage): string {
  // Error turns: show error text
  if (msg.isError) {
    const text = getTextContent(msg.contentBlocks)
    if (text) {
      const truncated = text.length > 120 ? text.slice(0, 120) + '...' : text
      return `[error: ${truncated}]`
    }
    return '[error]'
  }

  // Multi-tool turns
  const toolUseBlocks = msg.contentBlocks.filter(b => b.type === 'tool_use' && b.name)
  if (toolUseBlocks.length > 1) {
    const names = toolUseBlocks.map(b => b.name!)
    return `[${names.join(', ')}]`
  }

  // Single tool with params
  if (toolUseBlocks.length === 1) {
    const block = toolUseBlocks[0]!
    return `[${extractToolParams(block.name!, block.input)}]`
  }

  // Text-only
  const text = getTextContent(msg.contentBlocks)
  if (text) {
    return text.length > 120 ? text.slice(0, 120) + '...' : text
  }

  return ''
}

export function messageMatchesFilters(
  msg: NormalizedMessage,
  index: number,
  filters: TurnFilters,
): FilterResult {
  // Role filter
  if (filters.roles && filters.roles.length > 0) {
    if (!filters.roles.includes(msg.role)) return { matches: false }
  }

  // Error filter
  if (filters.isError !== undefined) {
    if (msg.isError !== filters.isError) return { matches: false }
  }

  // Correction filter
  if (filters.isCorrection !== undefined) {
    if (msg.isCorrection !== filters.isCorrection) return { matches: false }
  }

  // Tool names filter (any match)
  if (filters.toolNames && filters.toolNames.length > 0) {
    const msgTools = msg.toolNames ?? []
    const hasMatch = filters.toolNames.some(t => msgTools.includes(t))
    if (!hasMatch) return { matches: false }
  }

  // Turn range filter
  if (filters.turnRange) {
    const { from, to } = filters.turnRange
    if (from !== undefined && index < from) return { matches: false }
    if (to !== undefined && index > to) return { matches: false }
  }

  // Time range filter
  if (filters.timeRange) {
    const { after, before } = filters.timeRange
    if (after && msg.timestamp < after) return { matches: false }
    if (before && msg.timestamp > before) return { matches: false }
  }

  // Text pattern filter — prefer caller-supplied pre-compiled regex. If only
  // textPattern is given, compile lazily and fail closed on invalid regex
  // (never silently pass every turn).
  if (filters.textPattern) {
    let regex = filters.textRegex
    if (!regex) {
      try {
        regex = new RegExp(filters.textPattern, 'i')
      } catch {
        return { matches: false }
      }
    }
    const text = getTextContent(msg.contentBlocks)
    const match = regex.exec(text)
    if (!match) return { matches: false }

    // Extract snippet around match
    const start = Math.max(0, match.index - 30)
    const end = Math.min(text.length, match.index + match[0].length + 30)
    const snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '')
    return { matches: true, matchContext: snippet }
  }

  return { matches: true }
}

// ── Single-session query ───────────────────────────────────────────────────────

async function querySingleSession(
  sessionId: string,
  db: Database.Database,
  registry: AdapterRegistry,
  filters: TurnFilters,
  limit: number,
  offset: number,
): Promise<{ readonly results: readonly TurnReference[]; readonly total: number }> {
  const session = db.prepare(
    'SELECT project_slug FROM sessions WHERE id = ?'
  ).get(sessionId) as SessionRow | undefined

  if (!session) {
    return { results: [], total: 0 }
  }

  const messages: NormalizedMessage[] = []
  try {
    for await (const msg of registry.getMessages(sessionId)) {
      messages.push(msg)
    }
  } catch {
    return { results: [], total: 0 }
  }

  const matched: TurnReference[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) continue
    const result = messageMatchesFilters(msg, i, filters)
    if (result.matches) {
      matched.push({
        sessionId,
        turnIndex: i,
        turnId: msg.uuid,
        role: msg.role,
        timestamp: msg.timestamp,
        summary: summarizeMessage(msg),
        isError: msg.isError,
        isCorrection: msg.isCorrection,
        toolNames: msg.toolNames ?? [],
        matchContext: result.matchContext,
      })
    }
  }

  const paginated = matched.slice(offset, offset + limit)
  return { results: paginated, total: matched.length }
}

// ── Cross-session query ────────────────────────────────────────────────────────

async function ensureTurnEventsIndexed(
  projectId: string,
  db: Database.Database,
  registry: AdapterRegistry,
): Promise<void> {
  const unindexed = db.prepare(
    `SELECT id, project_slug FROM sessions
     WHERE project_slug = ? AND turn_events_indexed = 0`
  ).all(projectId) as readonly UnindexedSessionRow[]

  if (unindexed.length === 0) return

  const turnIndexer = container.get<TurnIndexer>(TOKENS.TurnIndexer)

  for (const session of unindexed) {
    // A malformed id is skipped with a visible reason, not silently dropped —
    // silently continuing here previously meant a fully-indexed cross-session
    // query_turns could hand back an EMPTY result set for a source whose ids
    // don't happen to look like Claude UUIDs.
    if (!isValidSessionId(session.id)) {
      console.warn(`[query_turns] skipping turn-event indexing for session "${session.id}": invalid session id`)
      continue
    }

    try {
      const messages: NormalizedMessage[] = []
      for await (const msg of registry.getMessages(session.id)) {
        messages.push(msg)
      }
      if (messages.length === 0) continue
      turnIndexer.indexSession(session.id, messages)
    } catch {
      // Skip sessions with missing/corrupt JSONL
      continue
    }
  }
}

export function queryCrossSession(
  projectId: string,
  db: Database.Database,
  filters: TurnFilters,
  limit: number,
  offset: number,
): { readonly results: readonly TurnReference[]; readonly total: number } {
  const conditions: string[] = ['s.project_slug = ?']
  const params: unknown[] = [projectId]

  if (filters.roles && filters.roles.length > 0) {
    const placeholders = filters.roles.map(() => '?').join(', ')
    conditions.push(`t.role IN (${placeholders})`)
    params.push(...filters.roles)
  }

  if (filters.isError !== undefined) {
    conditions.push('t.is_error = ?')
    params.push(filters.isError ? 1 : 0)
  }

  if (filters.isCorrection !== undefined) {
    conditions.push('t.is_correction = ?')
    params.push(filters.isCorrection ? 1 : 0)
  }

  if (filters.toolNames && filters.toolNames.length > 0) {
    // Use json_each to check if any of the tool names match
    const toolConditions = filters.toolNames.map(() =>
      `EXISTS (SELECT 1 FROM json_each(t.tool_names) WHERE json_each.value = ?)`
    )
    conditions.push(`(${toolConditions.join(' OR ')})`)
    params.push(...filters.toolNames)
  }

  if (filters.source) {
    const sources = Array.isArray(filters.source) ? filters.source : [filters.source]
    if (sources.length > 0) {
      conditions.push(`s.source IN (${sources.map(() => '?').join(', ')})`)
      params.push(...sources)
    }
  }

  if (filters.timeRange) {
    if (filters.timeRange.after) {
      conditions.push('t.timestamp >= ?')
      params.push(filters.timeRange.after)
    }
    if (filters.timeRange.before) {
      conditions.push('t.timestamp <= ?')
      params.push(filters.timeRange.before)
    }
  }

  const where = conditions.join(' AND ')

  const countRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM turn_events t
     JOIN sessions s ON s.id = t.session_id
     WHERE ${where}`
  ).get(...params) as { cnt: number }

  const rows = db.prepare(
    `SELECT t.session_id, t.turn_index, t.turn_id, t.role, t.timestamp,
            t.tool_names, t.is_error, t.is_correction, t.text_preview
     FROM turn_events t
     JOIN sessions s ON s.id = t.session_id
     WHERE ${where}
     ORDER BY t.timestamp DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as readonly TurnEventRow[]

  const results: TurnReference[] = rows.map(row => {
    const toolNames = parseToolNames(row.tool_names)
    const summary = summarizeFromDbRow(row.is_error === 1, toolNames, row.text_preview)

    return {
      sessionId: row.session_id,
      turnIndex: row.turn_index,
      turnId: row.turn_id,
      role: row.role as MessageRole,
      timestamp: row.timestamp,
      summary,
      isError: row.is_error === 1,
      isCorrection: row.is_correction === 1,
      toolNames,
    }
  })

  return { results, total: countRow.cnt }
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerQueryTurns(server: McpServer): void {
  server.tool(
    'query_turns',
    'Search for turns matching structured criteria within a session (JSONL) or across sessions (DB). Returns lightweight turn references with summaries. Use get_turns to expand specific results.',
    {
      sessionId: z.string().optional().describe('Scope to one session (enables textPattern and turnRange)'),
      projectId: z.string().optional().describe('Scope to a project for cross-session search'),
      toolNames: z.array(z.string()).optional().describe('Filter turns containing any of these tools'),
      isError: z.boolean().optional().describe('Only error turns'),
      isCorrection: z.boolean().optional().describe('Only correction turns'),
      roles: z.array(z.enum(['user', 'assistant'])).optional().describe('Filter by role'),
      source: z.union([z.string(), z.array(z.string())]).optional().describe(
        `Filter by the coding agent that produced the session. Accepts a single value or an array (OR-matched). Cross-session (projectId-scoped) queries only — has no effect when scoped to a single sessionId. Valid values: ${VALID_SOURCES.map(s => `"${s}"`).join(', ')}.`
      ),
      textPattern: z.string().optional().describe('Regex match against turn text (single-session only, requires sessionId)'),
      timeRange: z.object({
        after: z.string().optional().describe('ISO timestamp lower bound'),
        before: z.string().optional().describe('ISO timestamp upper bound'),
      }).optional().describe('Time range filter'),
      turnRange: z.object({
        from: z.number().optional().describe('Start turn index (inclusive)'),
        to: z.number().optional().describe('End turn index (inclusive)'),
      }).optional().describe('Turn index range (single-session only, requires sessionId)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 50)'),
      cursor: z.string().optional().describe('Offset-based pagination cursor'),
      compact: z.boolean().optional().describe('If true, return only {sessionId, turnIndex, turnId, timestamp} per result — ~5x smaller than full TurnReference. Use when you plan to follow up with get_turns for interesting results.'),
    },
    async (params) => {
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.get<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()
      const registry = container.get<AdapterRegistry>(TOKENS.AdapterRegistry)
      const pagination = container.get<PaginationManager>(TOKENS.PaginationManager)

      // Validate constraints
      if (!params.sessionId && !params.projectId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'At least one of sessionId or projectId is required',
          }, null, 2) }],
        }
      }

      if (params.textPattern && !params.sessionId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'textPattern requires sessionId (no cross-session text search)',
          }, null, 2) }],
        }
      }

      if (params.turnRange && !params.sessionId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'turnRange requires sessionId',
          }, null, 2) }],
        }
      }

      // Validate sessionId format BEFORE the DB lookup so a malformed id
      // surfaces as an error instead of silently returning empty results.
      if (params.sessionId && !isValidSessionId(params.sessionId)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: `Invalid session ID format: ${params.sessionId}`,
          }, null, 2) }],
        }
      }

      // Compile textPattern ONCE so an invalid regex surfaces as an error
      // rather than silently passing every turn through the filter.
      let textRegex: RegExp | undefined
      if (params.textPattern) {
        try {
          textRegex = new RegExp(params.textPattern, 'i')
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: `Invalid textPattern regex: ${(err as Error).message}`,
            }, null, 2) }],
          }
        }
      }

      // Decode the cursor with the same PaginationManager every other tool
      // uses (base64url `{"o":n}`) instead of a bare integer string — a
      // cursor minted by search/list_sessions/get_changes/semantic_search
      // must not silently restart query_turns at page 1.
      let offset = 0
      if (params.cursor) {
        const decoded = pagination.decodeCursor(params.cursor)
        if (decoded === undefined) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: `Invalid pagination cursor: ${params.cursor}`,
            }, null, 2) }],
          }
        }
        offset = decoded
      }

      const freshness = await freshnessGuard.ensureFresh()
      const limit = params.limit ?? 50

      const filters: TurnFilters = {
        toolNames: params.toolNames,
        isError: params.isError,
        isCorrection: params.isCorrection,
        roles: params.roles as MessageRole[] | undefined,
        textPattern: params.textPattern,
        textRegex,
        timeRange: params.timeRange,
        turnRange: params.turnRange,
        source: params.source,
      }

      let results: readonly TurnReference[]
      let total: number

      if (params.sessionId) {
        const queryResult = await querySingleSession(
          params.sessionId, db, registry, filters, limit, offset,
        )
        results = queryResult.results
        total = queryResult.total
      } else {
        // Cross-session: ensure turn_events are indexed
        await ensureTurnEventsIndexed(params.projectId!, db, registry)

        const queryResult = queryCrossSession(
          params.projectId!, db, filters, limit, offset,
        )
        results = queryResult.results
        total = queryResult.total
      }

      const hasMore = offset + results.length < total
      const nextCursor = hasMore ? pagination.encodeCursor(offset + results.length) : undefined

      const shapedResults = params.compact
        ? results.map(r => ({
            sessionId: r.sessionId,
            turnIndex: r.turnIndex,
            turnId: r.turnId,
            timestamp: r.timestamp,
          }))
        : results

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(
        { results: shapedResults, total },
        meta,
        hasMore ? { cursor: nextCursor!, hasMore: true, totalEstimate: total } : undefined,
      )

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
