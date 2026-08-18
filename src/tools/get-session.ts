import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'

const SECTION_NAMES = [
  'metadata',
  'toolCounts',
  'filesChanged',
  'cacheTokens',
  'tokenAccumulation',
  'prLinks',
  'subagents',
  'contextCollapses',
  'tokenCurve',
] as const

type SectionName = (typeof SECTION_NAMES)[number]

// Default section sets per detail level. tokenCurve is opt-in because it
// produces one entry per message — a 1000-turn session would otherwise
// overflow the MCP response budget.
const METADATA_SECTIONS: readonly SectionName[] = [
  'metadata',
  'toolCounts',
  'filesChanged',
  'cacheTokens',
  'tokenAccumulation',
  'prLinks',
  'subagents',
]
const FULL_SECTIONS: readonly SectionName[] = [
  ...METADATA_SECTIONS,
  'contextCollapses',
]

function resolveSections(
  detail: 'summary' | 'metadata' | 'full',
  explicit: readonly SectionName[] | undefined,
): ReadonlySet<SectionName> {
  if (explicit && explicit.length > 0) return new Set(explicit)
  if (detail === 'full') return new Set(FULL_SECTIONS)
  if (detail === 'metadata') return new Set(METADATA_SECTIONS)
  return new Set()
}

export function registerGetSession(server: McpServer): void {
  server.tool(
    'get_session',
    'Get details for a specific session by ID. Use `detail` for preset levels (summary | metadata | full) or `sections` for fine-grained control. `tokenCurve` is opt-in only via `sections` because it grows with turn count and can overflow the response on long sessions.',
    {
      sessionId: z.string().describe('Session ID (UUID)'),
      detail: z.enum(['summary', 'metadata', 'full']).optional().describe('Detail level preset'),
      sections: z.array(z.enum(SECTION_NAMES)).optional().describe('Explicit section list — overrides detail. Sections: metadata, toolCounts, filesChanged, cacheTokens, tokenAccumulation, prLinks, subagents, contextCollapses, tokenCurve. Base summary fields are always returned.'),
    },
    async (params) => {
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.get<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()

      const freshness = await freshnessGuard.ensureFresh()

      // Look up session in index — read all stored columns
      const session = db.prepare(
        `SELECT id, source, project_slug, cwd, branch, started_at, ended_at,
                model, total_tokens, total_turns, message_count,
                duration_minutes, error_count, correction_count, subagent_count,
                tool_counts, files_changed, topic, summary, summary_generated_at,
                custom_title, ai_title, tags, cost_usd, mode, entrypoint,
                has_thinking, worktree_branch, speculation_time_saved_ms,
                total_cache_read_tokens, total_cache_creation_tokens, models_used
         FROM sessions WHERE id = ?`
      ).get(params.sessionId) as {
        id: string
        source: string
        project_slug: string | null
        cwd: string | null
        branch: string | null
        started_at: string | null
        ended_at: string | null
        model: string | null
        total_tokens: number
        total_turns: number
        message_count: number | null
        duration_minutes: number | null
        error_count: number | null
        correction_count: number | null
        subagent_count: number | null
        tool_counts: string | null
        files_changed: string | null
        topic: string | null
        summary: string | null
        summary_generated_at: string | null
        custom_title: string | null
        ai_title: string | null
        tags: string | null
        cost_usd: number | null
        mode: string | null
        entrypoint: string | null
        has_thinking: number | null
        worktree_branch: string | null
        speculation_time_saved_ms: number | null
        total_cache_read_tokens: number | null
        total_cache_creation_tokens: number | null
        models_used: string | null
      } | undefined

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Session not found: ${params.sessionId}` }, null, 2) }],
        }
      }

      const detail = params.detail ?? 'summary'
      const sections = resolveSections(detail, params.sections as readonly SectionName[] | undefined)
      const has = (s: SectionName): boolean => sections.has(s)

      // summary (default) — compact card matching list_sessions fields
      const title = session.custom_title ?? session.ai_title
      const result: Record<string, unknown> = {
        id: session.id,
        source: session.source,
        projectSlug: session.project_slug,
        cwd: session.cwd,
        branch: session.branch,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        durationMinutes: session.duration_minutes,
        totalTurns: session.total_turns,
        totalTokens: session.total_tokens,
        errorCount: session.error_count,
        topic: session.topic,
        summary: session.summary,
        title,
        costUsd: session.cost_usd,
        mode: session.mode,
        entrypoint: session.entrypoint,
        tags: session.tags ? JSON.parse(session.tags) as unknown : null,
        modelsUsed: session.models_used ? JSON.parse(session.models_used) as unknown : null,
      }

      if (has('metadata')) {
        result['messageCount'] = session.message_count
        result['correctionCount'] = session.correction_count
        result['subagentCount'] = session.subagent_count
        result['hasThinking'] = session.has_thinking === 1
        result['worktreeBranch'] = session.worktree_branch
        result['speculationTimeSavedMs'] = session.speculation_time_saved_ms
      }

      if (has('toolCounts')) {
        result['toolCounts'] = session.tool_counts ? JSON.parse(session.tool_counts) as unknown : null
      }

      if (has('filesChanged')) {
        result['filesChanged'] = session.files_changed ? JSON.parse(session.files_changed) as unknown : null
      }

      if (has('cacheTokens')) {
        const cacheRead = session.total_cache_read_tokens ?? 0
        const cacheCreation = session.total_cache_creation_tokens ?? 0
        result['cacheTokens'] = {
          creation: cacheCreation,
          read: cacheRead,
          hitRatio: Math.round(
            (cacheRead / Math.max(cacheRead + cacheCreation, 1)) * 1000
          ) / 10,
        }
      }

      if (has('tokenAccumulation')) {
        const peakMsg = db.prepare(
          'SELECT MAX(token_count) as peak FROM messages WHERE session_id = ?'
        ).get(params.sessionId) as { peak: number | null }

        result['tokenAccumulation'] = {
          totalTokens: session.total_tokens,
          peakMessageTokens: peakMsg.peak ?? 0,
          avgTokensPerTurn: session.total_turns > 0
            ? Math.round(session.total_tokens / session.total_turns)
            : 0,
        }
      }

      if (has('prLinks')) {
        const prLinks = db.prepare(
          'SELECT pr_number, pr_url, pr_repository, timestamp FROM pr_links WHERE session_id = ?'
        ).all(params.sessionId) as Array<{
          pr_number: number
          pr_url: string
          pr_repository: string
          timestamp: string | null
        }>
        if (prLinks.length > 0) {
          result['prLinks'] = prLinks.map(pr => ({
            prNumber: pr.pr_number,
            prUrl: pr.pr_url,
            prRepository: pr.pr_repository,
            timestamp: pr.timestamp,
          }))
        }
      }

      // contextCollapseCount is always cheap (single COUNT query) — surface
      // whenever metadata is requested so callers know if the expensive
      // contextCollapses enumeration is worth requesting.
      if (has('metadata') || has('contextCollapses')) {
        const collapseCount = db.prepare(
          'SELECT COUNT(*) as cnt FROM context_collapses WHERE session_id = ?'
        ).get(params.sessionId) as { cnt: number }
        result['contextCollapseCount'] = collapseCount.cnt
      }

      if (has('subagents')) {
        const subagents = db.prepare(
          'SELECT id, agent_type, description, total_tokens, total_tools, duration_ms, model FROM subagents WHERE session_id = ?'
        ).all(params.sessionId) as Array<{
          id: string
          agent_type: string | null
          description: string | null
          total_tokens: number
          total_tools: number
          duration_ms: number | null
          model: string | null
        }>
        result['subagents'] = subagents.map(sa => ({
          id: sa.id,
          agentType: sa.agent_type,
          description: sa.description,
          totalTokens: sa.total_tokens,
          totalTools: sa.total_tools,
          durationMs: sa.duration_ms,
          model: sa.model,
        }))
      }

      if (has('contextCollapses')) {
        const collapses = db.prepare(
          'SELECT collapse_id, summary, first_archived_uuid, last_archived_uuid FROM context_collapses WHERE session_id = ?'
        ).all(params.sessionId) as Array<{
          collapse_id: string; summary: string | null
          first_archived_uuid: string | null; last_archived_uuid: string | null
        }>
        result['contextCollapses'] = collapses.map(c => ({
          collapseId: c.collapse_id,
          summary: c.summary,
          firstArchivedUuid: c.first_archived_uuid,
          lastArchivedUuid: c.last_archived_uuid,
        }))
      }

      if (has('tokenCurve')) {
        // Token accumulation curve — one entry per message. Opt-in only
        // because long sessions produce hundreds of entries.
        const msgs = db.prepare(
          'SELECT id, token_count FROM messages WHERE session_id = ? ORDER BY timestamp'
        ).all(params.sessionId) as Array<{ id: string; token_count: number }>

        // Resolve real collapse positions from the stored anchors instead of
        // guessing. Each collapse's position is its last_archived_uuid — the
        // final message swept into that collapse — falling back to
        // first_archived_uuid only when last is absent; both are real
        // stored anchors, never an interpolated guess. A collapse whose
        // anchor uuid doesn't match any message in this session is omitted
        // entirely rather than placed at a fabricated index.
        const collapseAnchors = db.prepare(
          'SELECT first_archived_uuid, last_archived_uuid FROM context_collapses WHERE session_id = ?'
        ).all(params.sessionId) as Array<{
          first_archived_uuid: string | null
          last_archived_uuid: string | null
        }>

        const messageIndexByUuid = new Map(msgs.map((m, i) => [m.id, i]))
        const collapsePositions = new Set<number>()
        for (const anchor of collapseAnchors) {
          const anchorUuid = anchor.last_archived_uuid ?? anchor.first_archived_uuid
          if (!anchorUuid) continue
          const idx = messageIndexByUuid.get(anchorUuid)
          if (idx !== undefined) collapsePositions.add(idx)
        }

        let cumulative = 0
        result['tokenCurve'] = msgs.map((m, i) => {
          cumulative += m.token_count
          return {
            turnIndex: i,
            cumulativeTokens: cumulative,
            isCollapse: collapsePositions.has(i),
          }
        })
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(result, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
