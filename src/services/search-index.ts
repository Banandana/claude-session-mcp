import type Database from 'better-sqlite3'
import type { DateRange } from '../types'

export interface SearchResult {
  readonly messageId: string
  readonly sessionId: string
  readonly projectSlug: string
  readonly timestamp: string
  readonly contentPreview: string
  readonly matchSnippet: string
  readonly rank: number
  readonly role: string | null
  readonly toolNames: readonly string[]
  readonly turnIndex: number | null
}

export interface SearchOptions {
  readonly projectSlug?: string | undefined
  readonly sessionId?: string | undefined
  /** Filter to sessions produced by one or more of these adapters (e.g. "codex", ["claude-code", "opencode"]). */
  readonly source?: string | readonly string[] | undefined
  readonly dateRange?: DateRange | undefined
  readonly limit?: number | undefined
  readonly offset?: number | undefined
}

function sourceCondition(source: string | readonly string[] | undefined, conditions: string[], params: unknown[]): void {
  if (!source) return
  const sources = Array.isArray(source) ? source : [source]
  if (sources.length === 0) return
  conditions.push(`s.source IN (${sources.map(() => '?').join(', ')})`)
  params.push(...sources)
}

/**
 * Sanitize a user-supplied query for FTS5.
 *
 * FTS5 treats bare hyphens as column-subtraction operators, so `project-tracker`
 * parses as `project NOT tracker` and errors with `no such column: tracker`. The
 * same hazard applies to `.`, `:`, `/`, and other punctuation commonly found in
 * identifiers, file paths, and JSON fragments.
 *
 * This function tokenizes the query, preserving:
 *   - quoted phrases ("..." — passed through with internal `"` doubled)
 *   - boolean operators (AND, OR, NOT, NEAR)
 *   - parentheses
 *   - safe bare words (alphanumeric + underscore, with optional trailing `*`)
 *
 * Everything else gets wrapped in double quotes so FTS5 treats it as a literal
 * phrase token. Column-filter syntax (`col:term`) is unsupported against the
 * single-column messages_fts table and is quoted defensively.
 */
export function sanitizeFtsQuery(query: string): string {
  const out: string[] = []
  let i = 0
  const len = query.length

  while (i < len) {
    const ch = query[i]
    if (ch === undefined) break

    // Whitespace — preserved verbatim
    if (/\s/.test(ch)) {
      out.push(ch)
      i++
      continue
    }

    // Parentheses — FTS5 grouping, preserved
    if (ch === '(' || ch === ')') {
      out.push(ch)
      i++
      continue
    }

    // Quoted phrase — consume until closing quote, escape internal quotes
    if (ch === '"') {
      let j = i + 1
      while (j < len && query[j] !== '"') j++
      const inner = query.slice(i + 1, j)
      out.push(`"${inner.replace(/"/g, '""')}"`)
      i = j < len ? j + 1 : j
      continue
    }

    // Bare token — consume until whitespace, paren, or quote
    let j = i
    while (j < len && !/[\s"()]/.test(query[j] ?? '')) j++
    const word = query.slice(i, j)
    i = j

    const upper = word.toUpperCase()
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT' || upper === 'NEAR') {
      out.push(word)
    } else if (/^[A-Za-z0-9_]+\*?$/.test(word)) {
      // Safe FTS5 bare word (alphanumeric/underscore, optional prefix wildcard)
      out.push(word)
    } else {
      // Unsafe — quote as a literal phrase
      out.push(`"${word.replace(/"/g, '""')}"`)
    }
  }

  return out.join('').trim()
}

interface SearchRow {
  messageId: string
  sessionId: string
  projectSlug: string
  timestamp: string
  contentPreview: string
  matchSnippet: string
  rank: number
  role: string | null
  toolNames: string | null
  turnIndex: number | null
}

export class SearchIndex {
  constructor(private readonly db: Database.Database) {}

  search(query: string, options?: SearchOptions): SearchResult[] {
    if (!query.trim()) return []

    const safeQuery = sanitizeFtsQuery(query)
    if (!safeQuery) return []

    const conditions: string[] = ['messages_fts.search_text MATCH ?']
    const params: unknown[] = [safeQuery]

    if (options?.projectSlug) {
      conditions.push('s.project_slug = ?')
      params.push(options.projectSlug)
    }

    if (options?.sessionId) {
      conditions.push('m.session_id = ?')
      params.push(options.sessionId)
    }

    sourceCondition(options?.source, conditions, params)

    if (options?.dateRange?.from) {
      conditions.push('m.timestamp >= ?')
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      conditions.push('m.timestamp <= ?')
      params.push(options.dateRange.to)
    }

    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const sql = `
      SELECT
        m.id AS messageId,
        m.session_id AS sessionId,
        COALESCE(s.project_slug, '') AS projectSlug,
        m.timestamp,
        m.content_preview AS contentPreview,
        snippet(messages_fts, 0, '»', '«', '…', 40) AS matchSnippet,
        rank,
        m.role AS role,
        m.tool_names AS toolNames,
        te.turn_index AS turnIndex
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      LEFT JOIN turn_events te ON te.session_id = m.session_id AND te.turn_id = m.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `

    params.push(limit, offset)

    const rows = this.db.prepare(sql).all(...params) as SearchRow[]

    return rows.map(row => {
      let toolNames: readonly string[] = []
      if (row.toolNames) {
        try {
          const parsed = JSON.parse(row.toolNames) as unknown
          if (Array.isArray(parsed)) toolNames = parsed.filter((x): x is string => typeof x === 'string')
        } catch {
          // tool_names may be CSV in legacy rows
          toolNames = row.toolNames.split(',').map(s => s.trim()).filter(Boolean)
        }
      }
      return {
        messageId: row.messageId,
        sessionId: row.sessionId,
        projectSlug: row.projectSlug ?? '',
        timestamp: row.timestamp ?? '',
        contentPreview: row.contentPreview ?? '',
        matchSnippet: row.matchSnippet ?? '',
        rank: row.rank,
        role: row.role,
        toolNames,
        turnIndex: row.turnIndex,
      }
    })
  }

  searchCount(query: string, options?: { projectSlug?: string; sessionId?: string; source?: string | readonly string[]; dateRange?: DateRange }): number {
    if (!query.trim()) return 0

    const safeQuery = sanitizeFtsQuery(query)
    if (!safeQuery) return 0

    const conditions: string[] = ['messages_fts.search_text MATCH ?']
    const params: unknown[] = [safeQuery]

    if (options?.projectSlug) {
      conditions.push('s.project_slug = ?')
      params.push(options.projectSlug)
    }

    if (options?.sessionId) {
      conditions.push('m.session_id = ?')
      params.push(options.sessionId)
    }

    sourceCondition(options?.source, conditions, params)

    if (options?.dateRange?.from) {
      conditions.push('m.timestamp >= ?')
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      conditions.push('m.timestamp <= ?')
      params.push(options.dateRange.to)
    }

    const sql = `
      SELECT COUNT(*) AS cnt
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      WHERE ${conditions.join(' AND ')}
    `

    const row = this.db.prepare(sql).get(...params) as { cnt: number }
    return row.cnt
  }
}
