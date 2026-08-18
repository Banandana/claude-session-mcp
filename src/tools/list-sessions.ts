import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ProjectResolver } from '../services/project-resolver'
import type { PaginationManager } from '../services/pagination-manager'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'

/** Source adapters this server currently knows about (see docs/multi-source-plan.md). */
const VALID_SOURCES = ['claude-code', 'pi-code', 'codex', 'opencode'] as const

const SORT_COLUMNS: Record<string, string> = {
  recent: 'started_at DESC',
  longest: 'duration_minutes DESC',
  most_turns: 'total_turns DESC',
  most_tokens: 'total_tokens DESC',
  errors: 'error_count DESC',
  cost: 'cost_usd IS NULL, cost_usd DESC',
  cache_efficiency: 'CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / CASE WHEN (COALESCE(total_cache_read_tokens, 0) + COALESCE(total_cache_creation_tokens, 0)) = 0 THEN 1 ELSE (COALESCE(total_cache_read_tokens, 0) + COALESCE(total_cache_creation_tokens, 0)) END DESC',
}

export interface ListSessionsFilters {
  readonly projectSlug?: string | undefined
  readonly branch?: string | undefined
  readonly source?: string | readonly string[] | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly minTokens?: number | undefined
  readonly maxTokens?: number | undefined
  readonly minCost?: number | undefined
  readonly maxCost?: number | undefined
  readonly minCacheHitRatio?: number | undefined
  readonly maxCacheHitRatio?: number | undefined
  readonly toolNames?: readonly string[] | undefined
}

export interface ListedSession {
  readonly id: string
  readonly source: string
  readonly projectSlug: string
  readonly cwd: string
  readonly branch: string | null
  readonly startedAt: string
  readonly endedAt: string | null
  readonly durationMinutes: number | null
  readonly totalTurns: number
  readonly totalTokens: number
  readonly messageCount: number | null
  readonly errorCount: number | null
  readonly topic: string | null
  readonly summary: string | null
  readonly title: string | null
  readonly costUsd: number | null
  readonly mode: string | null
  readonly entrypoint: string | null
  readonly tags: readonly string[] | null
  readonly modelsUsed: readonly string[] | null
  readonly cacheTokens: { readonly creation: number; readonly read: number; readonly hitRatio: number }
  readonly contextCollapseCount: number
}

/**
 * Builds and runs the filtered/sorted `sessions` query. Pulled out of the
 * tool handler so the filtering logic (in particular the `source` filter)
 * can be exercised directly against a real SQLite db in tests, without
 * standing up the full MCP/DI transport around it.
 */
export function queryListSessions(
  db: Database.Database,
  filters: ListSessionsFilters,
  sortBy: string,
  limit: number,
  offset: number,
): { readonly sessions: readonly ListedSession[]; readonly total: number } {
  const conditions: string[] = []
  const sqlParams: (string | number)[] = []

  if (filters.projectSlug) {
    conditions.push('project_slug = ?')
    sqlParams.push(filters.projectSlug)
  }
  if (filters.branch) {
    conditions.push('branch = ?')
    sqlParams.push(filters.branch)
  }
  if (filters.source) {
    const sources = Array.isArray(filters.source) ? filters.source : [filters.source]
    if (sources.length > 0) {
      conditions.push(`source IN (${sources.map(() => '?').join(', ')})`)
      sqlParams.push(...sources)
    }
  }
  if (filters.from) {
    conditions.push('started_at >= ?')
    sqlParams.push(filters.from)
  }
  if (filters.to) {
    conditions.push('started_at <= ?')
    sqlParams.push(filters.to)
  }
  if (filters.minTokens != null) {
    conditions.push('total_tokens >= ?')
    sqlParams.push(filters.minTokens)
  }
  if (filters.maxTokens != null) {
    conditions.push('total_tokens <= ?')
    sqlParams.push(filters.maxTokens)
  }
  if (filters.minCost != null) {
    conditions.push('cost_usd >= ?')
    sqlParams.push(filters.minCost)
  }
  if (filters.maxCost != null) {
    conditions.push('cost_usd <= ?')
    sqlParams.push(filters.maxCost)
  }
  if (filters.minCacheHitRatio != null) {
    conditions.push('(CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) * 100.0 / CASE WHEN (COALESCE(total_cache_read_tokens, 0) + COALESCE(total_cache_creation_tokens, 0)) = 0 THEN 1 ELSE (COALESCE(total_cache_read_tokens, 0) + COALESCE(total_cache_creation_tokens, 0)) END) >= ?')
    sqlParams.push(filters.minCacheHitRatio)
  }
  if (filters.maxCacheHitRatio != null) {
    conditions.push('(CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) * 100.0 / CASE WHEN (COALESCE(total_cache_read_tokens, 0) + COALESCE(total_cache_creation_tokens, 0)) = 0 THEN 1 ELSE (COALESCE(total_cache_read_tokens, 0) + COALESCE(total_cache_creation_tokens, 0)) END) <= ?')
    sqlParams.push(filters.maxCacheHitRatio)
  }
  if (filters.toolNames && filters.toolNames.length > 0) {
    // tool_counts is a JSON object keyed by tool name — match sessions
    // that have any of the requested tools as a key with a positive count.
    const toolConditions = filters.toolNames.map(() =>
      `(tool_counts IS NOT NULL AND json_extract(tool_counts, '$.' || ?) > 0)`
    )
    conditions.push(`(${toolConditions.join(' OR ')})`)
    for (const t of filters.toolNames) sqlParams.push(t)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const orderBy = SORT_COLUMNS[sortBy] ?? SORT_COLUMNS['recent']

  // Total count with the SAME WHERE clause, independent of LIMIT/OFFSET.
  const countRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM sessions ${whereClause}`
  ).get(...sqlParams) as { cnt: number }
  const total = countRow.cnt

  const sql = `
    SELECT id, source, project_slug, cwd, branch, started_at, ended_at,
           duration_minutes, total_turns, total_tokens, message_count,
           error_count, topic, summary, custom_title, ai_title, tags,
           cost_usd, mode, entrypoint, models_used,
           total_cache_read_tokens, total_cache_creation_tokens,
           (SELECT COUNT(*) FROM context_collapses WHERE session_id = sessions.id) as collapse_count
    FROM sessions
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `

  const rows = db.prepare(sql).all(...sqlParams, limit, offset) as Array<Record<string, unknown>>

  const sessions = rows.map(row => {
    const title = (row['custom_title'] as string | null) ?? (row['ai_title'] as string | null)
    return {
      id: row['id'] as string,
      source: row['source'] as string,
      projectSlug: row['project_slug'] as string,
      cwd: row['cwd'] as string,
      branch: row['branch'] as string | null,
      startedAt: row['started_at'] as string,
      endedAt: row['ended_at'] as string | null,
      durationMinutes: row['duration_minutes'] as number | null,
      totalTurns: row['total_turns'] as number,
      totalTokens: row['total_tokens'] as number,
      messageCount: row['message_count'] as number | null,
      errorCount: row['error_count'] as number | null,
      topic: row['topic'] as string | null,
      summary: row['summary'] as string | null,
      title,
      costUsd: row['cost_usd'] as number | null,
      mode: row['mode'] as string | null,
      entrypoint: row['entrypoint'] as string | null,
      tags: row['tags'] ? JSON.parse(row['tags'] as string) as string[] : null,
      modelsUsed: row['models_used'] ? JSON.parse(row['models_used'] as string) as string[] : null,
      cacheTokens: {
        creation: (row['total_cache_creation_tokens'] as number | null) ?? 0,
        read: (row['total_cache_read_tokens'] as number | null) ?? 0,
        hitRatio: Math.round(
          ((row['total_cache_read_tokens'] as number ?? 0) /
            Math.max((row['total_cache_read_tokens'] as number ?? 0) + (row['total_cache_creation_tokens'] as number ?? 0), 1)) * 1000
        ) / 10,
      },
      contextCollapseCount: row['collapse_count'] as number,
    }
  })

  return { sessions, total }
}

export function registerListSessions(server: McpServer): void {
  server.tool(
    'list_sessions',
    'List sessions with rich metadata — topic, summary, duration, errors. Supports filtering, sorting, and pagination.',
    {
      project: z.string().optional().describe('Project slug'),
      path: z.string().optional().describe('Filesystem path to project or subdirectory'),
      branch: z.string().optional().describe('Filter by git branch'),
      source: z.union([z.string(), z.array(z.string())]).optional().describe(
        `Filter by the coding agent that produced the session. Accepts a single value or an array (OR-matched). Valid values: ${VALID_SOURCES.map(s => `"${s}"`).join(', ')}.`
      ),
      from: z.string().optional().describe('Start date ISO 8601'),
      to: z.string().optional().describe('End date ISO 8601'),
      sortBy: z.enum(['recent', 'longest', 'most_turns', 'most_tokens', 'errors', 'cost', 'cache_efficiency']).optional().describe('Sort order (default: recent)'),
      resolution: z.enum(['low', 'medium']).optional().describe('Response density: low (scanning) or medium (default, full card)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of sessions to return'),
      minTokens: z.number().optional().describe('Minimum total tokens'),
      maxTokens: z.number().optional().describe('Maximum total tokens'),
      minCost: z.number().optional().describe('Minimum cost in USD. Coverage gap: only opencode sessions carry a real per-session cost, and claude-code only for the single most-recently-active session per project (a snapshot, not a ledger) — pi-code and codex never populate cost, so this filter silently excludes all of their sessions.'),
      maxCost: z.number().optional().describe('Maximum cost in USD. Same source coverage gap as minCost — see its description.'),
      minCacheHitRatio: z.number().min(0).max(100).optional().describe('Minimum cache hit ratio (0-100)'),
      maxCacheHitRatio: z.number().min(0).max(100).optional().describe('Maximum cache hit ratio (0-100)'),
      toolNames: z.array(z.string()).optional().describe('Only sessions that used at least one of these tools (e.g., ["Agent", "WebFetch"]). Matched against the per-session tool_counts map.'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    async (params) => {
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const projectResolver = container.get<ProjectResolver>(TOKENS.ProjectResolver)
      const pagination = container.get<PaginationManager>(TOKENS.PaginationManager)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.get<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()

      const freshness = await freshnessGuard.ensureFresh()

      // Decode the cursor up front — a cursor minted by a DIFFERENT tool
      // (or corrupted) must not silently restart list_sessions at page 1.
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
      const limit = params.limit ?? pagination.defaultLimit

      const slug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      const { sessions, total } = queryListSessions(
        db,
        {
          projectSlug: slug,
          branch: params.branch,
          source: params.source,
          from: params.from,
          to: params.to,
          minTokens: params.minTokens,
          maxTokens: params.maxTokens,
          minCost: params.minCost,
          maxCost: params.maxCost,
          minCacheHitRatio: params.minCacheHitRatio,
          maxCacheHitRatio: params.maxCacheHitRatio,
          toolNames: params.toolNames,
        },
        params.sortBy ?? 'recent',
        limit,
        offset,
      )

      const resolution = params.resolution ?? 'medium'
      const output = resolution === 'low'
        ? sessions.map(s => ({
            id: s.id,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            durationMinutes: s.durationMinutes,
            topic: s.topic,
          }))
        : sessions

      const hasMore = offset + output.length < total
      const nextCursor = hasMore ? pagination.encodeCursor(offset + output.length) : undefined

      const meta = formatter.formatMeta(freshness)
      const paginationResult = hasMore
        ? { cursor: nextCursor!, hasMore: true, totalEstimate: total }
        : { cursor: '', hasMore: false, totalEstimate: total }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(formatter.format(output, meta, paginationResult), null, 2) }],
      }
    }
  )
}
