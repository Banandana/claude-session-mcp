import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { PhaseClusterer, Phase } from '../services/phase-clusterer'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { NormalizedMessage } from '../types'
import { isValidSessionId } from './shared/session-id'

interface SessionRow {
  readonly project_slug: string | null
  readonly topic: string | null
  readonly summary: string | null
  readonly started_at: string | null
  readonly ended_at: string | null
  readonly duration_minutes: number | null
  readonly model: string | null
  readonly total_tokens: number | null
  readonly total_turns: number | null
  readonly error_count: number | null
  readonly correction_count: number | null
  readonly tool_counts: string | null
  readonly files_changed: string | null
  readonly custom_title: string | null
  readonly ai_title: string | null
  readonly cost_usd: number | null
  readonly mode: string | null
  readonly models_used: string | null
  readonly total_cache_read_tokens: number | null
  readonly total_cache_creation_tokens: number | null
}

export function registerGetConversation(server: McpServer): void {
  server.tool(
    'get_conversation',
    'Get a phase-clustered overview of a session — metadata, tool breakdown, files changed, and activity phases.',
    {
      sessionId: z.string().describe('Session ID'),
      maxTokens: z.number().optional().describe('Token budget for response — truncates phases and lists to fit'),
    },
    async (params) => {
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.get<DatabaseConnection>(TOKENS.Database)
      const phaseClusterer = container.get<PhaseClusterer>(TOKENS.PhaseClusterer)
      const db = dbConn.get()
      const registry = container.get<AdapterRegistry>(TOKENS.AdapterRegistry)

      const freshness = await freshnessGuard.ensureFresh()

      if (!isValidSessionId(params.sessionId)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Invalid session ID format: ${params.sessionId}` }, null, 2) }],
        }
      }

      const session = db.prepare(
        `SELECT project_slug, topic, summary, started_at, ended_at, duration_minutes,
                model, total_tokens, total_turns, error_count, correction_count,
                tool_counts, files_changed, custom_title, ai_title, cost_usd,
                mode, models_used, total_cache_read_tokens, total_cache_creation_tokens
         FROM sessions WHERE id = ?`
      ).get(params.sessionId) as SessionRow | undefined

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Session not found: ${params.sessionId}` }, null, 2) }],
        }
      }

      // Route through adapter registry — handles both claude and pi session layouts
      const messages: NormalizedMessage[] = []
      try {
        for await (const msg of registry.getMessages(params.sessionId)) {
          messages.push(msg)
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to read session file: ${(err as Error).message}` }, null, 2) }],
        }
      }

      // Cluster into phases
      const phases: Phase[] = [...phaseClusterer.cluster(messages)]

      // Parse tool_counts and files_changed from JSON strings
      let toolCounts: Record<string, number> = {}
      if (session.tool_counts) {
        try {
          toolCounts = JSON.parse(session.tool_counts) as Record<string, number>
        } catch {
          // ignore malformed JSON
        }
      }

      let filesChanged: Array<{ path: string; op: string }> = []
      if (session.files_changed) {
        try {
          const parsed: unknown = JSON.parse(session.files_changed)
          if (Array.isArray(parsed)) {
            // Handle both object format [{path, op}] and legacy string format ["file.ts"]
            filesChanged = parsed.map((item: unknown) =>
              typeof item === 'string' ? { path: item, op: 'unknown' } : item as { path: string; op: string }
            )
          }
        } catch {
          // ignore malformed JSON
        }
      }

      // Apply maxTokens budget enforcement
      if (params.maxTokens) {
        const estimateTokens = (obj: unknown) => Math.ceil(JSON.stringify(obj).length / 4)

        // 1. Truncate filesChanged to top 10
        if (filesChanged.length > 10) filesChanged = filesChanged.slice(0, 10)

        // 2. Truncate toolBreakdown to top 10 by count
        if (Object.keys(toolCounts).length > 10) {
          const sorted = Object.entries(toolCounts).sort((a, b) => (b[1] as number) - (a[1] as number))
          toolCounts = Object.fromEntries(sorted.slice(0, 10))
        }

        // 3. Merge smallest adjacent phases until under budget
        const tokenBudget = params.maxTokens * 0.7
        while (phases.length > 2 && estimateTokens({ phases }) > tokenBudget) {
          // Find the smallest phase in one pass
          let smallestIdx = 0
          for (let i = 1; i < phases.length; i++) {
            if (phases[i]!.turnCount < phases[smallestIdx]!.turnCount) {
              smallestIdx = i
            }
          }
          const mergeIdx = smallestIdx === 0 ? 1
            : smallestIdx === phases.length - 1 ? smallestIdx - 1
            : phases[smallestIdx - 1]!.turnCount <= phases[smallestIdx + 1]!.turnCount ? smallestIdx - 1 : smallestIdx + 1
          const [a, b] = mergeIdx < smallestIdx ? [mergeIdx, smallestIdx] : [smallestIdx, mergeIdx]
          const pa = phases[a]!
          const pb = phases[b]!
          const mergedTools = new Set([...pa.toolNames, ...pb.toolNames])
          phases[a] = {
            turnRange: { from: pa.turnRange.from, to: pb.turnRange.to },
            description: pa.description,
            toolNames: [...mergedTools],
            errorCount: pa.errorCount + pb.errorCount,
            turnCount: pa.turnCount + pb.turnCount,
          }
          phases.splice(b, 1)
        }
      }

      const data = {
        sessionId: params.sessionId,
        metadata: {
          title: session.custom_title ?? session.ai_title,
          topic: session.topic,
          summary: session.summary,
          startedAt: session.started_at,
          endedAt: session.ended_at,
          durationMinutes: session.duration_minutes,
          model: session.model,
          modelsUsed: session.models_used ? JSON.parse(session.models_used) as string[] : null,
          totalTurns: session.total_turns ?? messages.length,
          totalTokens: session.total_tokens,
          costUsd: session.cost_usd,
          errorCount: session.error_count ?? 0,
          correctionCount: session.correction_count ?? 0,
          toolBreakdown: toolCounts,
          filesChanged,
          mode: session.mode,
          cacheTokens: {
            creation: session.total_cache_creation_tokens ?? 0,
            read: session.total_cache_read_tokens ?? 0,
          },
        },
        phases,
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(data, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
