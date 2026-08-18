import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ProjectResolver } from '../services/project-resolver'
import type { PaginationManager } from '../services/pagination-manager'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { EmbeddingIndexer } from '../services/embedding-indexer'

/**
 * Vector KNN search over message embeddings.
 *
 * Complements the FTS5-based `search` tool: FTS matches on exact token
 * overlap, while this tool matches on semantic similarity, so paraphrased
 * queries ("how did we solve that auth problem") find relevant messages
 * even when they share no keywords with the query.
 *
 * Context management / safeguards parity with `search`:
 *  - Scoping filters: project, path, sessionId, from/to date range
 *  - Offset-based pagination via cursor
 *  - Enriched results: role, toolNames, turnIndex, truncated contentPreview
 *  - ensureFresh() before query so new messages are indexed first
 *
 * Opt-in: requires EMBEDDING_MODEL env var. When not configured, the
 * tool returns a clear error explaining how to enable it rather than
 * silently disabling itself.
 */

interface MessageRow {
  readonly rowid: number
  readonly id: string
  readonly session_id: string
  readonly role: string | null
  readonly timestamp: string | null
  readonly content_preview: string | null
  readonly tool_names: string | null
  readonly project_slug: string | null
  readonly turn_index: number | null
}

// Mirror of search.ts preview behaviour — keep each result compact so a
// large KNN response doesn't blow the MCP token budget.
const MAX_PREVIEW_CHARS = 240

function parseToolNames(raw: string | null): readonly string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    return raw.split(',').map(s => s.trim()).filter(Boolean)
  }
  return []
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

export function registerSemanticSearch(server: McpServer): void {
  server.tool(
    'semantic_search',
    'Vector KNN search over message embeddings. Finds semantically similar messages even when they share no keywords with the query — complements the FTS-based `search` tool. Supports the same scoping filters (project, sessionId, date range) and pagination as `search`. Requires EMBEDDING_MODEL env var to be set on the MCP server.',
    {
      query: z.string().min(1).describe('Natural language query'),
      project: z.string().optional().describe('Filter by project slug'),
      path: z.string().optional().describe('Resolve project from filesystem path'),
      sessionId: z.string().optional().describe('Restrict to a specific session'),
      from: z.string().optional().describe('Start date ISO 8601'),
      to: z.string().optional().describe('End date ISO 8601'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Maximum results per page (default 20)'),
      maxDistance: z
        .number()
        .optional()
        .describe('Drop results with L2 distance above this threshold (lower = more similar)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    async (params) => {
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const projectResolver = container.get<ProjectResolver>(TOKENS.ProjectResolver)
      const pagination = container.get<PaginationManager>(TOKENS.PaginationManager)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.get<DatabaseConnection>(TOKENS.Database)
      const indexer = container.isBound(TOKENS.EmbeddingIndexer)
        ? container.get<EmbeddingIndexer>(TOKENS.EmbeddingIndexer)
        : null
      const db = dbConn.get()

      if (!indexer) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error:
                    'semantic_search is disabled. Set EMBEDDING_MODEL (and optionally EMBEDDING_URL, EMBEDDING_DIM) in the MCP server environment to enable it.',
                },
                null,
                2,
              ),
            },
          ],
        }
      }

      if (!dbConn.isVecAvailable()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error:
                    'sqlite-vec extension failed to load. semantic_search is unavailable on this platform.',
                },
                null,
                2,
              ),
            },
          ],
        }
      }

      // Validate the cursor before paying for a KNN search — a cursor
      // minted by a DIFFERENT tool (or corrupted) must not silently
      // restart semantic_search at page 1.
      if (params.cursor && pagination.decodeCursor(params.cursor) === undefined) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { error: `Invalid pagination cursor: ${params.cursor}` },
                null,
                2,
              ),
            },
          ],
        }
      }

      const freshness = await freshnessGuard.ensureFresh()

      const projectSlug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      const limit = params.limit ?? 20
      const hasFilters =
        !!projectSlug || !!params.sessionId || !!params.from || !!params.to

      // Fetch extra when filters are present so the post-filter still has
      // enough hits to fill a page. The hard cap prevents pathological
      // over-fetching on very selective filters.
      const k = Math.min(hasFilters ? limit * 6 : limit * 2, 500)

      let rawHits: ReadonlyArray<{ rowid: number; distance: number }>
      try {
        rawHits = await indexer.search(params.query, k)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { error: `semantic_search failed: ${message}` },
                null,
                2,
              ),
            },
          ],
        }
      }

      if (rawHits.length === 0) {
        const meta = formatter.formatMeta(freshness)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                formatter.format([], meta, {
                  cursor: '',
                  hasMore: false,
                  totalEstimate: 0,
                }),
                null,
                2,
              ),
            },
          ],
        }
      }

      // Load message + session rows for the hits in one go, joining
      // turn_events for turnIndex parity with the FTS `search` tool.
      const placeholders = rawHits.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT m.rowid, m.id, m.session_id, m.role, m.timestamp,
                  m.content_preview, m.tool_names, s.project_slug,
                  te.turn_index
           FROM messages m
           LEFT JOIN sessions s ON s.id = m.session_id
           LEFT JOIN turn_events te
             ON te.session_id = m.session_id AND te.turn_id = m.id
           WHERE m.rowid IN (${placeholders})`,
        )
        .all(...rawHits.map(h => h.rowid)) as MessageRow[]

      const byRowid = new Map(rows.map(r => [r.rowid, r]))

      // Apply filters in hit order (preserves distance ranking).
      const filtered = rawHits
        .map(hit => {
          const row = byRowid.get(hit.rowid)
          if (!row) return null
          if (projectSlug && row.project_slug !== projectSlug) return null
          if (params.sessionId && row.session_id !== params.sessionId) return null
          if (params.from && (row.timestamp == null || row.timestamp < params.from)) return null
          if (params.to && (row.timestamp == null || row.timestamp > params.to)) return null
          if (params.maxDistance != null && hit.distance > params.maxDistance) return null
          return {
            messageId: row.id,
            sessionId: row.session_id,
            projectSlug: row.project_slug,
            role: row.role,
            timestamp: row.timestamp,
            contentPreview: truncate(row.content_preview ?? '', MAX_PREVIEW_CHARS),
            toolNames: parseToolNames(row.tool_names),
            turnIndex: row.turn_index,
            distance: Math.round(hit.distance * 10000) / 10000,
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      // Offset-based pagination matching the FTS search tool.
      const page = pagination.paginate(filtered, {
        cursor: params.cursor,
        limit,
      })

      const meta = formatter.formatMeta(freshness)
      const paginationResult = page.hasMore
        ? { cursor: page.cursor!, hasMore: true, totalEstimate: page.totalEstimate }
        : { cursor: '', hasMore: false, totalEstimate: page.totalEstimate }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(formatter.format(page.items, meta, paginationResult), null, 2),
          },
        ],
      }
    },
  )
}
