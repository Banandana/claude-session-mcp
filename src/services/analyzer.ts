import type Database from 'better-sqlite3'
import type { DateRange } from '../types'

function formatSessionLabel(startedAt: string | null, topic: string | null): string {
  const date = startedAt ? startedAt.slice(0, 10) : 'unknown'
  return topic ? `${date} — ${topic}` : date
}

export interface AnalysisResult {
  readonly label: string
  readonly count: number
  readonly sessionId?: string | undefined
  readonly projectSlug?: string | undefined
  readonly details?: string | undefined
}

type AnalyzeOptions = {
  projectSlug?: string | undefined
  dateRange?: DateRange | undefined
  limit?: number | undefined
}

export class Analyzer {
  constructor(private readonly db: Database.Database) {}

  analyze(
    metric: 'errors' | 'corrections' | 'tool_failures' | 'costly_sessions' | 'frequent_files' | 'cache_efficiency' | 'model_usage',
    options?: AnalyzeOptions
  ): AnalysisResult[] {
    switch (metric) {
      case 'errors': return this.analyzeErrors(options)
      case 'corrections': return this.analyzeCorrections(options)
      case 'tool_failures': return this.analyzeToolFailures(options)
      case 'costly_sessions': return this.analyzeCostlySessions(options)
      case 'frequent_files': return this.analyzeFrequentFiles(options)
      case 'cache_efficiency': return this.analyzeCacheEfficiency(options)
      case 'model_usage': return this.analyzeModelUsage(options)
    }
  }

  private analyzeErrors(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    let sql = `
      SELECT s.id, s.project_slug, s.started_at, s.topic, COUNT(*) as error_count
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.is_error = 1
    `

    if (options?.projectSlug) {
      sql += ` AND s.project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND m.timestamp >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND m.timestamp <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` GROUP BY s.id ORDER BY error_count DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      project_slug: string | null
      started_at: string | null
      topic: string | null
      error_count: number
    }>

    return rows.map(row => ({
      label: formatSessionLabel(row.started_at, row.topic),
      count: row.error_count,
      sessionId: row.id,
      projectSlug: row.project_slug ?? undefined,
    }))
  }

  private analyzeCorrections(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    let sql = `
      SELECT s.id, s.project_slug, s.started_at, s.topic, COUNT(*) as correction_count
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.is_correction = 1
    `

    if (options?.projectSlug) {
      sql += ` AND s.project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND m.timestamp >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND m.timestamp <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` GROUP BY s.id ORDER BY correction_count DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      project_slug: string | null
      started_at: string | null
      topic: string | null
      correction_count: number
    }>

    return rows.map(row => ({
      label: formatSessionLabel(row.started_at, row.topic),
      count: row.correction_count,
      sessionId: row.id,
      projectSlug: row.project_slug ?? undefined,
    }))
  }

  private analyzeToolFailures(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    // tool_names is a comma-joined (or JSON-array) string per turn, so a
    // turn that ran e.g. Bash and Read must count toward BOTH tools'
    // failure totals, not form its own "Bash,Read" bucket. json_each over
    // a normalized JSON-array form of the column does the split; same
    // idiom as ContextAuditor's per-tool breakdowns.
    let sql = `
      SELECT tool_name.value AS tool_name, COUNT(*) as failure_count
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      , json_each(CASE WHEN m.tool_names LIKE '[%' THEN m.tool_names ELSE '["' || replace(m.tool_names, ',', '","') || '"]' END) AS tool_name
    `

    sql += ` WHERE m.is_error = 1 AND m.tool_names IS NOT NULL`

    if (options?.projectSlug) {
      sql += ` AND s.project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND m.timestamp >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND m.timestamp <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` GROUP BY tool_name.value ORDER BY failure_count DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      tool_name: string
      failure_count: number
    }>

    return rows.map(row => ({
      label: row.tool_name,
      count: row.failure_count,
      details: row.tool_name,
    }))
  }

  private analyzeCostlySessions(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    // Prefer cost_usd when available, fall back to total_tokens
    let sql = `
      SELECT id, project_slug, started_at, topic, total_tokens, cost_usd
      FROM sessions
      WHERE 1 = 1
    `

    if (options?.projectSlug) {
      sql += ` AND project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND started_at >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND started_at <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` ORDER BY COALESCE(cost_usd, 0) DESC, total_tokens DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      project_slug: string | null
      started_at: string | null
      topic: string | null
      total_tokens: number
      cost_usd: number | null
    }>

    return rows.map(row => ({
      label: formatSessionLabel(row.started_at, row.topic),
      count: row.total_tokens,
      sessionId: row.id,
      projectSlug: row.project_slug ?? undefined,
      details: row.cost_usd != null ? `$${row.cost_usd.toFixed(4)}` : undefined,
    }))
  }

  private analyzeCacheEfficiency(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    let sql = `
      SELECT id, project_slug, started_at, topic,
             total_tokens, total_cache_read_tokens, total_cache_creation_tokens
      FROM sessions
      WHERE total_tokens > 0
    `

    if (options?.projectSlug) {
      sql += ` AND project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND started_at >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND started_at <= ?`
      params.push(options.dateRange.to)
    }

    // Sessions with worst cache hit ratio (most cache misses)
    sql += ` ORDER BY CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / MAX(total_tokens, 1) ASC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      project_slug: string | null
      started_at: string | null
      topic: string | null
      total_tokens: number
      total_cache_read_tokens: number | null
      total_cache_creation_tokens: number | null
    }>

    return rows.map(row => {
      const cacheRead = row.total_cache_read_tokens ?? 0
      const cacheCreation = row.total_cache_creation_tokens ?? 0
      const hitRate = row.total_tokens > 0 ? Math.round((cacheRead / row.total_tokens) * 100) : 0
      return {
        label: formatSessionLabel(row.started_at, row.topic),
        count: hitRate,
        sessionId: row.id,
        projectSlug: row.project_slug ?? undefined,
        details: `${hitRate}% cache hit, ${cacheCreation} created, ${cacheRead} read, ${row.total_tokens} total`,
      }
    })
  }

  private analyzeModelUsage(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 20
    const params: (string | number)[] = []

    let sql = `
      SELECT model, COUNT(*) as msg_count, SUM(token_count) as total_tokens
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
    `

    sql += ` WHERE model IS NOT NULL`

    if (options?.projectSlug) {
      sql += ` AND s.project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND m.timestamp >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND m.timestamp <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` GROUP BY model ORDER BY total_tokens DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      model: string
      msg_count: number
      total_tokens: number
    }>

    return rows.map(row => ({
      label: row.model,
      count: row.total_tokens,
      details: `${row.msg_count} messages, ${row.total_tokens} tokens`,
    }))
  }

  private analyzeFrequentFiles(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    let sql = `
      SELECT fc.file_path, COUNT(*) as change_count
      FROM file_changes fc
    `

    if (options?.projectSlug) {
      sql += ` JOIN sessions s ON fc.session_id = s.id`
    }

    sql += ` WHERE fc.file_path IS NOT NULL`

    if (options?.projectSlug) {
      sql += ` AND s.project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND fc.timestamp >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND fc.timestamp <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` GROUP BY fc.file_path ORDER BY change_count DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      file_path: string
      change_count: number
    }>

    return rows.map(row => ({
      label: row.file_path,
      count: row.change_count,
      details: row.file_path,
    }))
  }
}
