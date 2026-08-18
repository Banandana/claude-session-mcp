import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ProjectResolver } from '../services/project-resolver'
import type { PaginationManager } from '../services/pagination-manager'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'

export function registerGetChanges(server: McpServer): void {
  server.tool(
    'get_changes',
    'Get file operations tracked across sessions. Filter by session, file path, operation type, or project.',
    {
      sessionId: z.string().optional().describe('Filter by session ID'),
      filePath: z.string().optional().describe('Filter by file path (exact match)'),
      operation: z.string().optional().describe('Filter by operation: read, write, edit, create'),
      project: z.string().optional().describe('Filter by project slug'),
      path: z.string().optional().describe('Resolve project from filesystem path'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().min(1).max(1000).optional().describe('Maximum results to return'),
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
      // (or corrupted) must not silently restart get_changes at page 1.
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

      const projectSlug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      const conditions: string[] = []
      const sqlParams: unknown[] = []

      if (params.sessionId) {
        conditions.push('fc.session_id = ?')
        sqlParams.push(params.sessionId)
      }

      if (params.filePath) {
        conditions.push('fc.file_path = ?')
        sqlParams.push(params.filePath)
      }

      if (params.operation) {
        conditions.push('fc.operation = ?')
        sqlParams.push(params.operation)
      }

      if (projectSlug) {
        conditions.push('s.project_slug = ?')
        sqlParams.push(projectSlug)
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : ''

      const needsJoin = !!projectSlug
      const joinClause = needsJoin
        ? 'JOIN sessions s ON fc.session_id = s.id'
        : ''

      // Total count with the SAME WHERE/JOIN clause, independent of LIMIT/OFFSET.
      const countRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM file_changes fc ${joinClause} ${whereClause}`
      ).get(...sqlParams) as { cnt: number }
      const total = countRow.cnt

      const sql = `
        SELECT fc.session_id, fc.file_path, fc.operation, fc.timestamp
        FROM file_changes fc
        ${joinClause}
        ${whereClause}
        ORDER BY fc.timestamp DESC
        LIMIT ? OFFSET ?
      `

      const rows = db.prepare(sql).all(...sqlParams, limit, offset) as Array<{
        session_id: string
        file_path: string
        operation: string
        timestamp: string | null
      }>

      const changes = rows.map(row => ({
        sessionId: row.session_id,
        filePath: row.file_path,
        operation: row.operation,
        timestamp: row.timestamp,
      }))

      const hasMore = offset + changes.length < total
      const nextCursor = hasMore ? pagination.encodeCursor(offset + changes.length) : undefined

      const meta = formatter.formatMeta(freshness)
      const paginationResult = hasMore
        ? { cursor: nextCursor!, hasMore: true, totalEstimate: total }
        : { cursor: '', hasMore: false, totalEstimate: total }

      const response = formatter.format(changes, meta, paginationResult)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
