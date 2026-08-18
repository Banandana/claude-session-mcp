import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ContextAuditor } from '../services/context-auditor'
import type { ProjectResolver } from '../services/project-resolver'
import type { ResponseFormatter } from '../services/response-formatter'
import type { ContextAuditMetric, ContextAuditDetail, TemporalGrouping } from '../types/context-audit'

export function registerContextAudit(server: McpServer): void {
  server.tool(
    'context_audit',
    'First-class context usage auditing — cost breakdown, cache analysis, and collapse tracking. Use detail=summary for aggregates, detail=full for per-session breakdowns.',
    {
      metric: z.enum([
        'cost_breakdown', 'cache_analysis', 'collapse_analysis',
      ]).describe('What to audit'),
      detail: z.enum(['summary', 'full']).optional().describe('summary = aggregates, full = per-session (default: summary)'),
      groupBy: z.enum(['day', 'week', 'month']).optional().describe('Temporal bucketing for trend analysis'),
      project: z.string().optional().describe('Filter by project slug'),
      path: z.string().optional().describe('Resolve project from filesystem path'),
      from: z.string().optional().describe('Start date ISO 8601'),
      to: z.string().optional().describe('End date ISO 8601'),
      minTokens: z.number().optional().describe('Minimum total_tokens'),
      maxTokens: z.number().optional().describe('Maximum total_tokens'),
      minCost: z.number().optional().describe('Minimum cost_usd'),
      maxCost: z.number().optional().describe('Maximum cost_usd'),
      minCacheHitRatio: z.number().min(0).max(100).optional().describe('Minimum cache hit ratio (0-100)'),
      maxCacheHitRatio: z.number().min(0).max(100).optional().describe('Maximum cache hit ratio (0-100)'),
      modelFilter: z.string().optional().describe('Filter to sessions using this model'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default: 20)'),
    },
    async (params) => {
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const auditor = container.get<ContextAuditor>(TOKENS.ContextAuditor)
      const projectResolver = container.get<ProjectResolver>(TOKENS.ProjectResolver)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)

      const freshness = await freshnessGuard.ensureFresh()

      const projectSlug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      const dateRange = (params.from || params.to)
        ? { from: params.from, to: params.to }
        : undefined

      const filters = {
        projectSlug: projectSlug ?? undefined,
        dateRange,
        minTokens: params.minTokens,
        maxTokens: params.maxTokens,
        minCost: params.minCost,
        maxCost: params.maxCost,
        minCacheHitRatio: params.minCacheHitRatio,
        maxCacheHitRatio: params.maxCacheHitRatio,
        modelFilter: params.modelFilter,
      }

      const detail: ContextAuditDetail = params.detail ?? 'summary'
      const metric: ContextAuditMetric = params.metric
      const groupBy: TemporalGrouping | undefined = params.groupBy
      const limit = params.limit

      let result: unknown
      switch (metric) {
        case 'cost_breakdown':
          result = auditor.costBreakdown(detail, { filters, groupBy, limit })
          break
        case 'cache_analysis':
          result = auditor.cacheAnalysis(detail, { filters, groupBy, limit })
          break
        case 'collapse_analysis':
          result = auditor.collapseAnalysis(detail, { filters, groupBy, limit })
          break
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(result, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
