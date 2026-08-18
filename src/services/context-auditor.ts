import type Database from 'better-sqlite3'
import type {
  ContextAuditDetail,
  ContextAuditFilters,
  CostBreakdownSummary,
  CostBreakdownFull,
  CostPeriod,
  CostSessionDetail,
  SessionRef,
  TemporalGrouping,
  CacheAnalysisSummary,
  CacheAnalysisFull,
  CollapseAnalysisSummary,
  CollapseAnalysisFull,
} from '../types/context-audit'

interface SqlFilter {
  readonly conditions: string[]
  readonly params: (string | number)[]
}

interface CostBreakdownOptions {
  readonly filters?: ContextAuditFilters | undefined
  readonly groupBy?: TemporalGrouping | undefined
  readonly limit?: number | undefined
}

const STRFTIME_FORMATS: Record<TemporalGrouping, string> = {
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m',
}

export class ContextAuditor {
  constructor(private readonly db: Database.Database) {}

  ensureIndexes(): void {
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_cost_usd ON sessions(cost_usd)')
  }

  private buildSessionFilters(filters?: ContextAuditFilters, prefix = 's'): SqlFilter {
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (!filters) return { conditions, params }

    if (filters.projectSlug) {
      conditions.push(`${prefix}.project_slug = ?`)
      params.push(filters.projectSlug)
    }

    if (filters.dateRange?.from) {
      conditions.push(`${prefix}.started_at >= ?`)
      params.push(filters.dateRange.from)
    }

    if (filters.dateRange?.to) {
      conditions.push(`${prefix}.started_at <= ?`)
      params.push(filters.dateRange.to)
    }

    if (filters.minTokens != null) {
      conditions.push(`${prefix}.total_tokens >= ?`)
      params.push(filters.minTokens)
    }

    if (filters.maxTokens != null) {
      conditions.push(`${prefix}.total_tokens <= ?`)
      params.push(filters.maxTokens)
    }

    if (filters.minCost != null) {
      conditions.push(`${prefix}.cost_usd >= ?`)
      params.push(filters.minCost)
    }

    if (filters.maxCost != null) {
      conditions.push(`${prefix}.cost_usd <= ?`)
      params.push(filters.maxCost)
    }

    if (filters.minCacheHitRatio != null) {
      conditions.push(
        `(CAST(COALESCE(${prefix}.total_cache_read_tokens, 0) AS REAL) * 100.0 / CASE WHEN (COALESCE(${prefix}.total_cache_read_tokens, 0) + COALESCE(${prefix}.total_cache_creation_tokens, 0)) = 0 THEN 1 ELSE (COALESCE(${prefix}.total_cache_read_tokens, 0) + COALESCE(${prefix}.total_cache_creation_tokens, 0)) END) >= ?`
      )
      params.push(filters.minCacheHitRatio)
    }

    if (filters.maxCacheHitRatio != null) {
      conditions.push(
        `(CAST(COALESCE(${prefix}.total_cache_read_tokens, 0) AS REAL) * 100.0 / CASE WHEN (COALESCE(${prefix}.total_cache_read_tokens, 0) + COALESCE(${prefix}.total_cache_creation_tokens, 0)) = 0 THEN 1 ELSE (COALESCE(${prefix}.total_cache_read_tokens, 0) + COALESCE(${prefix}.total_cache_creation_tokens, 0)) END) <= ?`
      )
      params.push(filters.maxCacheHitRatio)
    }

    if (filters.modelFilter) {
      conditions.push(
        `EXISTS (SELECT 1 FROM json_each(${prefix}.models_used) WHERE value = ?)`
      )
      params.push(filters.modelFilter)
    }

    return { conditions, params }
  }

  private whereClause(filter: SqlFilter): string {
    if (filter.conditions.length === 0) return ''
    return 'WHERE ' + filter.conditions.join(' AND ')
  }

  costBreakdown(
    detail: ContextAuditDetail,
    options: CostBreakdownOptions
  ): CostBreakdownSummary | CostBreakdownFull {
    if (detail === 'full') {
      return this.costBreakdownFull(options)
    }
    return this.costBreakdownSummary(options)
  }

  private costBreakdownSummary(options: CostBreakdownOptions): CostBreakdownSummary {
    const filter = this.buildSessionFilters(options.filters)
    const where = filter.conditions.length > 0
      ? 'WHERE ' + filter.conditions.join(' AND ')
      : ''

    const aggRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(s.cost_usd), 0) AS total_cost,
        COALESCE(AVG(s.cost_usd), 0) AS avg_cost,
        COUNT(*) AS session_count
      FROM sessions s
      ${where}
    `).get(...filter.params) as {
      total_cost: number
      avg_cost: number
      session_count: number
    }

    const { minCostSession, maxCostSession } = this.getMinMaxCostSessions(filter)

    const periods = options.groupBy
      ? this.getCostPeriods(options.groupBy, filter)
      : undefined

    return {
      totalCost: aggRow.total_cost,
      avgCost: aggRow.avg_cost,
      sessionCount: aggRow.session_count,
      minCostSession,
      maxCostSession,
      periods,
    }
  }

  private costBreakdownFull(options: CostBreakdownOptions): CostBreakdownFull {
    const filter = this.buildSessionFilters(options.filters)
    const where = filter.conditions.length > 0
      ? 'WHERE ' + filter.conditions.join(' AND ')
      : ''
    const limit = options.limit ?? 20

    const rows = this.db.prepare(`
      SELECT
        s.id,
        s.topic,
        s.started_at,
        s.cost_usd,
        s.total_tokens,
        COALESCE(s.total_cache_creation_tokens, 0) AS cache_creation,
        COALESCE(s.total_cache_read_tokens, 0) AS cache_read
      FROM sessions s
      ${where}
      ORDER BY s.cost_usd IS NULL, s.cost_usd DESC
      LIMIT ?
    `).all(...filter.params, limit) as Array<{
      id: string
      topic: string | null
      started_at: string | null
      cost_usd: number | null
      total_tokens: number
      cache_creation: number
      cache_read: number
    }>

    const sessions: CostSessionDetail[] = rows.map(row => ({
      id: row.id,
      topic: row.topic,
      startedAt: row.started_at,
      costUsd: row.cost_usd,
      totalTokens: row.total_tokens,
      cacheTokens: {
        creation: row.cache_creation,
        read: row.cache_read,
      },
    }))

    return { sessions }
  }

  private getMinMaxCostSessions(filter: SqlFilter): {
    minCostSession: SessionRef | null
    maxCostSession: SessionRef | null
  } {
    const where = filter.conditions.length > 0
      ? 'WHERE ' + filter.conditions.join(' AND ') + ' AND s.cost_usd IS NOT NULL'
      : 'WHERE s.cost_usd IS NOT NULL'

    const minRow = this.db.prepare(`
      SELECT s.id, s.topic, s.cost_usd
      FROM sessions s
      ${where}
      ORDER BY s.cost_usd ASC
      LIMIT 1
    `).get(...filter.params) as { id: string; topic: string | null; cost_usd: number } | undefined

    const maxRow = this.db.prepare(`
      SELECT s.id, s.topic, s.cost_usd
      FROM sessions s
      ${where}
      ORDER BY s.cost_usd DESC
      LIMIT 1
    `).get(...filter.params) as { id: string; topic: string | null; cost_usd: number } | undefined

    return {
      minCostSession: minRow
        ? { id: minRow.id, topic: minRow.topic, costUsd: minRow.cost_usd }
        : null,
      maxCostSession: maxRow
        ? { id: maxRow.id, topic: maxRow.topic, costUsd: maxRow.cost_usd }
        : null,
    }
  }

  cacheAnalysis(
    detail: ContextAuditDetail,
    options: { filters?: ContextAuditFilters | undefined; groupBy?: TemporalGrouping | undefined; limit?: number | undefined }
  ): CacheAnalysisSummary | CacheAnalysisFull {
    const limit = options.limit ?? 20
    const filter = this.buildSessionFilters(options.filters)
    const where = this.whereClause(filter)
    if (detail === 'full') return this.cacheAnalysisFull(where, filter.params, limit)
    return this.cacheAnalysisSummary(where, filter.params, options.groupBy)
  }

  private cacheAnalysisSummary(
    where: string,
    params: (string | number)[],
    groupBy?: TemporalGrouping
  ): CacheAnalysisSummary {
    const aggRow = this.db.prepare(`
      SELECT
        CAST(SUM(COALESCE(s.total_cache_read_tokens, 0)) AS REAL) * 100.0 /
          CASE WHEN (SUM(COALESCE(s.total_cache_read_tokens, 0)) + SUM(COALESCE(s.total_cache_creation_tokens, 0))) = 0 THEN 1
          ELSE (SUM(COALESCE(s.total_cache_read_tokens, 0)) + SUM(COALESCE(s.total_cache_creation_tokens, 0))) END AS overall_hit_ratio,
        AVG(
          CAST(COALESCE(s.total_cache_read_tokens, 0) AS REAL) * 100.0 /
            CASE WHEN (COALESCE(s.total_cache_read_tokens, 0) + COALESCE(s.total_cache_creation_tokens, 0)) = 0 THEN 1
            ELSE (COALESCE(s.total_cache_read_tokens, 0) + COALESCE(s.total_cache_creation_tokens, 0)) END
        ) AS avg_hit_ratio,
        COALESCE(SUM(s.total_cache_creation_tokens), 0) AS total_cache_creation,
        COALESCE(SUM(s.total_cache_read_tokens), 0) AS total_cache_read,
        COUNT(*) AS session_count
      FROM sessions s
      ${where}
    `).get(...params) as {
      overall_hit_ratio: number
      avg_hit_ratio: number
      total_cache_creation: number
      total_cache_read: number
      session_count: number
    }

    const periods = groupBy
      ? this.getCacheAnalysisPeriods(groupBy, where, params)
      : undefined

    return {
      overallHitRatio: aggRow.overall_hit_ratio ?? 0,
      avgHitRatio: aggRow.avg_hit_ratio ?? 0,
      totalCacheCreation: aggRow.total_cache_creation,
      totalCacheRead: aggRow.total_cache_read,
      sessionCount: aggRow.session_count,
      periods,
    }
  }

  private cacheAnalysisFull(
    where: string,
    params: (string | number)[],
    limit: number
  ): CacheAnalysisFull {
    const rows = this.db.prepare(`
      SELECT
        s.id, s.topic, s.total_tokens,
        COALESCE(s.total_cache_creation_tokens, 0) AS cache_creation,
        COALESCE(s.total_cache_read_tokens, 0) AS cache_read,
        CAST(COALESCE(s.total_cache_read_tokens, 0) AS REAL) * 100.0 /
          CASE WHEN (COALESCE(s.total_cache_read_tokens, 0) + COALESCE(s.total_cache_creation_tokens, 0)) = 0 THEN 1
          ELSE (COALESCE(s.total_cache_read_tokens, 0) + COALESCE(s.total_cache_creation_tokens, 0)) END AS hit_ratio
      FROM sessions s
      ${where}
      ORDER BY hit_ratio ASC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: string
      topic: string | null
      total_tokens: number
      cache_creation: number
      cache_read: number
      hit_ratio: number
    }>

    return {
      sessions: rows.map(r => ({
        id: r.id,
        topic: r.topic,
        cacheHitRatio: Math.round(r.hit_ratio * 10) / 10,
        cacheCreationTokens: r.cache_creation,
        cacheReadTokens: r.cache_read,
        totalTokens: r.total_tokens,
      })),
    }
  }

  private getCacheAnalysisPeriods(
    groupBy: TemporalGrouping,
    where: string,
    params: (string | number)[]
  ): CacheAnalysisSummary['periods'] {
    const fmt = STRFTIME_FORMATS[groupBy]
    const rows = this.db.prepare(`
      SELECT
        strftime('${fmt}', s.started_at) AS period,
        CAST(SUM(COALESCE(s.total_cache_read_tokens, 0)) AS REAL) * 100.0 /
          CASE WHEN (SUM(COALESCE(s.total_cache_read_tokens, 0)) + SUM(COALESCE(s.total_cache_creation_tokens, 0))) = 0 THEN 1
          ELSE (SUM(COALESCE(s.total_cache_read_tokens, 0)) + SUM(COALESCE(s.total_cache_creation_tokens, 0))) END AS overall_hit_ratio,
        AVG(
          CAST(COALESCE(s.total_cache_read_tokens, 0) AS REAL) * 100.0 /
            CASE WHEN (COALESCE(s.total_cache_read_tokens, 0) + COALESCE(s.total_cache_creation_tokens, 0)) = 0 THEN 1
            ELSE (COALESCE(s.total_cache_read_tokens, 0) + COALESCE(s.total_cache_creation_tokens, 0)) END
        ) AS avg_hit_ratio,
        COALESCE(SUM(s.total_cache_creation_tokens), 0) AS total_cache_creation,
        COALESCE(SUM(s.total_cache_read_tokens), 0) AS total_cache_read
      FROM sessions s
      ${where}
      GROUP BY period
      ORDER BY period
    `).all(...params) as Array<{
      period: string
      overall_hit_ratio: number
      avg_hit_ratio: number
      total_cache_creation: number
      total_cache_read: number
    }>

    return rows.map(r => ({
      period: r.period,
      overallHitRatio: r.overall_hit_ratio,
      avgHitRatio: r.avg_hit_ratio,
      totalCacheCreation: r.total_cache_creation,
      totalCacheRead: r.total_cache_read,
    }))
  }

  collapseAnalysis(
    detail: ContextAuditDetail,
    options: { filters?: ContextAuditFilters | undefined; groupBy?: TemporalGrouping | undefined; limit?: number | undefined }
  ): CollapseAnalysisSummary | CollapseAnalysisFull {
    const limit = options.limit ?? 20
    const filter = this.buildSessionFilters(options.filters)
    const where = this.whereClause(filter)
    if (detail === 'full') return this.collapseAnalysisFull(where, filter.params, limit)
    return this.collapseAnalysisSummary(where, filter.params, options.groupBy)
  }

  private collapseAnalysisSummary(
    where: string,
    params: (string | number)[],
    groupBy?: TemporalGrouping
  ): CollapseAnalysisSummary {
    const aggRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(cc.cnt), 0) AS total_collapses,
        SUM(CASE WHEN cc.cnt > 0 THEN 1 ELSE 0 END) AS sessions_with_collapses,
        COUNT(*) AS total_sessions
      FROM sessions s
      LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM context_collapses GROUP BY session_id) cc
        ON cc.session_id = s.id
      ${where}
    `).get(...params) as {
      total_collapses: number
      sessions_with_collapses: number
      total_sessions: number
    }

    const maxRow = this.db.prepare(`
      SELECT s.id, s.topic, COUNT(*) as collapse_count
      FROM context_collapses cc
      JOIN sessions s ON s.id = cc.session_id
      ${where ? where + ' AND 1=1' : ''}
      GROUP BY cc.session_id
      ORDER BY collapse_count DESC
      LIMIT 1
    `).get(...params) as { id: string; topic: string | null; collapse_count: number } | undefined

    const periods = groupBy
      ? this.getCollapseAnalysisPeriods(groupBy, where, params)
      : undefined

    return {
      totalCollapses: aggRow.total_collapses,
      avgCollapsesPerSession: aggRow.total_sessions > 0
        ? aggRow.total_collapses / aggRow.total_sessions
        : 0,
      sessionsWithCollapses: {
        count: aggRow.sessions_with_collapses,
        percentage: aggRow.total_sessions > 0
          ? Math.round(aggRow.sessions_with_collapses / aggRow.total_sessions * 10000) / 100
          : 0,
      },
      maxCollapseSession: maxRow
        ? { id: maxRow.id, topic: maxRow.topic, costUsd: null, collapseCount: maxRow.collapse_count }
        : null,
      periods,
    }
  }

  private collapseAnalysisFull(
    where: string,
    params: (string | number)[],
    limit: number
  ): CollapseAnalysisFull {
    const sessionRows = this.db.prepare(`
      SELECT s.id, s.topic, s.total_tokens, COUNT(cc.collapse_id) as collapse_count
      FROM sessions s
      JOIN context_collapses cc ON cc.session_id = s.id
      ${where}
      GROUP BY s.id
      ORDER BY collapse_count DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: string
      topic: string | null
      total_tokens: number
      collapse_count: number
    }>

    if (sessionRows.length === 0) return { sessions: [] }

    const sessionIds = sessionRows.map(r => r.id)
    const placeholders = sessionIds.map(() => '?').join(',')

    const collapseRows = this.db.prepare(`
      SELECT session_id, collapse_id, summary
      FROM context_collapses
      WHERE session_id IN (${placeholders})
      ORDER BY rowid
    `).all(...sessionIds) as Array<{
      session_id: string
      collapse_id: string
      summary: string | null
    }>

    const collapseMap = new Map<string, Array<{ collapseId: string; summary: string | null }>>()
    for (const row of collapseRows) {
      if (!collapseMap.has(row.session_id)) {
        collapseMap.set(row.session_id, [])
      }
      collapseMap.get(row.session_id)!.push({
        collapseId: row.collapse_id,
        summary: row.summary,
      })
    }

    return {
      sessions: sessionRows.map(r => ({
        id: r.id,
        topic: r.topic,
        totalTokens: r.total_tokens,
        collapses: collapseMap.get(r.id) ?? [],
      })),
    }
  }

  private getCollapseAnalysisPeriods(
    groupBy: TemporalGrouping,
    where: string,
    params: (string | number)[]
  ): CollapseAnalysisSummary['periods'] {
    const fmt = STRFTIME_FORMATS[groupBy]
    const rows = this.db.prepare(`
      SELECT
        strftime('${fmt}', s.started_at) AS period,
        COALESCE(SUM(cc.cnt), 0) AS total_collapses,
        COUNT(*) AS session_count,
        CAST(COALESCE(SUM(cc.cnt), 0) AS REAL) / MAX(COUNT(*), 1) AS avg_per_session
      FROM sessions s
      LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM context_collapses GROUP BY session_id) cc
        ON cc.session_id = s.id
      ${where}
      GROUP BY period
      ORDER BY period
    `).all(...params) as Array<{
      period: string
      total_collapses: number
      session_count: number
      avg_per_session: number
    }>

    return rows.map(r => ({
      period: r.period,
      totalCollapses: r.total_collapses,
      sessionCount: r.session_count,
      avgPerSession: r.avg_per_session,
    }))
  }

  private getCostPeriods(groupBy: TemporalGrouping, filter: SqlFilter): CostPeriod[] {
    const fmt = STRFTIME_FORMATS[groupBy]
    const where = filter.conditions.length > 0
      ? 'WHERE ' + filter.conditions.join(' AND ')
      : ''

    const rows = this.db.prepare(`
      SELECT
        strftime('${fmt}', s.started_at) AS period,
        COALESCE(SUM(s.cost_usd), 0) AS total_cost,
        COALESCE(AVG(s.cost_usd), 0) AS avg_cost,
        COUNT(*) AS session_count
      FROM sessions s
      ${where}
      GROUP BY period
      ORDER BY period
    `).all(...filter.params) as Array<{
      period: string
      total_cost: number
      avg_cost: number
      session_count: number
    }>

    return rows.map(row => ({
      period: row.period,
      totalCost: row.total_cost,
      avgCost: row.avg_cost,
      sessionCount: row.session_count,
    }))
  }
}
