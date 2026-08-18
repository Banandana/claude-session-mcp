import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from './index-manager'
import { SearchIndex, sanitizeFtsQuery } from './search-index'

describe('sanitizeFtsQuery', () => {
  it('wraps hyphenated terms as phrase literals', () => {
    expect(sanitizeFtsQuery('project-tracker')).toBe('"project-tracker"')
  })

  it('preserves safe bare words', () => {
    expect(sanitizeFtsQuery('authentication')).toBe('authentication')
    expect(sanitizeFtsQuery('foo_bar')).toBe('foo_bar')
    expect(sanitizeFtsQuery('prefix*')).toBe('prefix*')
  })

  it('preserves boolean operators and parentheses', () => {
    expect(sanitizeFtsQuery('foo AND bar'))
      .toBe('foo AND bar')
    expect(sanitizeFtsQuery('(foo OR bar) AND baz'))
      .toBe('(foo OR bar) AND baz')
    expect(sanitizeFtsQuery('foo NOT bar')).toBe('foo NOT bar')
  })

  it('preserves explicit quoted phrases', () => {
    expect(sanitizeFtsQuery('"hello world"')).toBe('"hello world"')
  })

  it('quotes mixed-punctuation tokens', () => {
    expect(sanitizeFtsQuery('src/foo.ts')).toBe('"src/foo.ts"')
    expect(sanitizeFtsQuery('subagent_type:project')).toBe('"subagent_type:project"')
  })

  it('handles compound queries with hyphens and operators', () => {
    expect(sanitizeFtsQuery('"project-tracker" AND jira'))
      .toBe('"project-tracker" AND jira')
    expect(sanitizeFtsQuery('smoke-tester Sentry'))
      .toBe('"smoke-tester" Sentry')
  })

  it('returns empty string for empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('')
    expect(sanitizeFtsQuery('   ')).toBe('')
  })
})

describe('SearchIndex', () => {
  let tempDir: string
  let db: Database.Database
  let indexManager: IndexManager
  let searchIndex: SearchIndex

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'search-index-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')

    indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()

    // Pre-populate with test data
    db.prepare(`INSERT INTO sessions (id, source, project_slug, started_at) VALUES (?, ?, ?, ?)`).run(
      'session-1', 'claude-code', 'project-alpha', '2026-03-28T10:00:00Z',
    )
    db.prepare(`INSERT INTO sessions (id, source, project_slug, started_at) VALUES (?, ?, ?, ?)`).run(
      'session-2', 'claude-code', 'project-beta', '2026-03-28T11:00:00Z',
    )

    // Insert messages
    const insertMsg = db.prepare(`
      INSERT INTO messages (id, session_id, role, type, timestamp, model, content_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = db.prepare(`INSERT INTO messages_fts (rowid, search_text) VALUES (?, ?)`)

    insertMsg.run('msg-1', 'session-1', 'user', 'user', '2026-03-28T10:00:01Z', null, 'Build the authentication module')
    let row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-1') as { rowid: number }
    insertFts.run(row.rowid, 'Build the authentication module')

    insertMsg.run('msg-2', 'session-1', 'assistant', 'assistant', '2026-03-28T10:00:05Z', 'claude-opus-4-6', 'I will build the auth module with JWT tokens')
    row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-2') as { rowid: number }
    insertFts.run(row.rowid, 'I will build the auth module with JWT tokens')

    insertMsg.run('msg-3', 'session-2', 'user', 'user', '2026-03-28T11:00:01Z', null, 'Fix the database connection pooling')
    row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-3') as { rowid: number }
    insertFts.run(row.rowid, 'Fix the database connection pooling')

    insertMsg.run('msg-4', 'session-2', 'assistant', 'assistant', '2026-03-28T11:00:05Z', 'claude-opus-4-6', 'I will optimize the database connection pool configuration')
    row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-4') as { rowid: number }
    insertFts.run(row.rowid, 'I will optimize the database connection pool configuration')

    insertMsg.run('msg-5', 'session-1', 'user', 'user', '2026-03-28T10:05:00Z', null, 'Now add database migration support')
    row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-5') as { rowid: number }
    insertFts.run(row.rowid, 'Now add database migration support')

    searchIndex = new SearchIndex(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('returns ranked search results', () => {
    const results = searchIndex.search('authentication')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].messageId).toBeDefined()
    expect(results[0].sessionId).toBe('session-1')
    expect(results[0].contentPreview).toContain('auth')
    expect(typeof results[0].rank).toBe('number')
  })

  it('searches across sessions', () => {
    const results = searchIndex.search('database')
    expect(results.length).toBeGreaterThanOrEqual(3)
    // Should find results in both sessions
    const sessionIds = new Set(results.map(r => r.sessionId))
    expect(sessionIds.has('session-1')).toBe(true)
    expect(sessionIds.has('session-2')).toBe(true)
  })

  it('filters by project slug', () => {
    const results = searchIndex.search('database', { projectSlug: 'project-beta' })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.projectSlug).toBe('project-beta')
    }
  })

  it('filters by session ID', () => {
    const results = searchIndex.search('database', { sessionId: 'session-1' })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.sessionId).toBe('session-1')
    }
  })

  it('filters by date range', () => {
    const results = searchIndex.search('database', {
      dateRange: { from: '2026-03-28T10:30:00Z', to: '2026-03-28T12:00:00Z' },
    })
    // Should only match session-2 messages (11:00+)
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.sessionId).toBe('session-2')
    }
  })

  it('returns empty array for no matches', () => {
    const results = searchIndex.search('nonexistent_xyz_query')
    expect(results).toEqual([])
  })

  it('returns empty array for empty query', () => {
    const results = searchIndex.search('')
    expect(results).toEqual([])
    const results2 = searchIndex.search('   ')
    expect(results2).toEqual([])
  })

  it('supports limit and offset', () => {
    const allResults = searchIndex.search('database')
    const limited = searchIndex.search('database', { limit: 2 })
    const offsetResults = searchIndex.search('database', { limit: 2, offset: 1 })

    expect(limited.length).toBeLessThanOrEqual(2)
    if (allResults.length > 1) {
      expect(offsetResults[0].messageId).toBe(allResults[1].messageId)
    }
  })

  it('searchCount returns correct number', () => {
    const count = searchIndex.searchCount('database')
    const results = searchIndex.search('database')
    expect(count).toBe(results.length)
  })

  it('searchCount with project filter', () => {
    const count = searchIndex.searchCount('database', { projectSlug: 'project-beta' })
    expect(count).toBeGreaterThan(0)
    const totalCount = searchIndex.searchCount('database')
    expect(count).toBeLessThanOrEqual(totalCount)
  })

  it('searchCount returns 0 for empty query', () => {
    expect(searchIndex.searchCount('')).toBe(0)
  })

  it('searchCount respects dateRange (regression: totalEstimate ignored the date filter search() used)', () => {
    // 'database' matches msg-3 (11:00:01), msg-4 (11:00:05), and msg-5
    // (10:05:00). Restricting to 10:30-12:00 excludes msg-5, leaving only
    // session-2's two messages.
    const dateRange = { from: '2026-03-28T10:30:00Z', to: '2026-03-28T12:00:00Z' }
    const filteredResults = searchIndex.search('database', { dateRange })
    const filteredCount = searchIndex.searchCount('database', { dateRange })
    const unfilteredCount = searchIndex.searchCount('database')

    expect(filteredCount).toBe(filteredResults.length)
    expect(filteredCount).toBeLessThan(unfilteredCount)
  })

  it('returns projectSlug in results', () => {
    const results = searchIndex.search('authentication')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].projectSlug).toBe('project-alpha')
  })

  it('does not throw on hyphenated terms (regression: FTS5 column-subtraction)', () => {
    // Before the sanitizer, `project-tracker` parsed as `project NOT tracker`
    // and errored with `no such column: tracker`.
    expect(() => searchIndex.search('project-tracker')).not.toThrow()
    expect(() => searchIndex.search('smoke-tester Sentry')).not.toThrow()
    expect(() => searchIndex.search('src/foo.ts')).not.toThrow()
  })

  it('returns role and toolNames in results', () => {
    const results = searchIndex.search('authentication')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].role).toBe('user')
    expect(Array.isArray(results[0].toolNames)).toBe(true)
  })

  describe('source filter', () => {
    beforeEach(() => {
      db.prepare(`INSERT INTO sessions (id, source, project_slug, started_at) VALUES (?, ?, ?, ?)`).run(
        'session-3', 'codex', 'project-gamma', '2026-03-28T12:00:00Z',
      )
      const insertMsg = db.prepare(`
        INSERT INTO messages (id, session_id, role, type, timestamp, model, content_preview)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      const insertFts = db.prepare(`INSERT INTO messages_fts (rowid, search_text) VALUES (?, ?)`)
      insertMsg.run('msg-6', 'session-3', 'user', 'user', '2026-03-28T12:00:01Z', null, 'Restore the database backup')
      const row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-6') as { rowid: number }
      insertFts.run(row.rowid, 'Restore the database backup')
    })

    it('search: a single source string excludes other sources', () => {
      const all = searchIndex.search('database')
      const codexOnly = searchIndex.search('database', { source: 'codex' })

      expect(all.some(r => r.sessionId === 'session-3')).toBe(true)
      expect(codexOnly).toHaveLength(1)
      expect(codexOnly[0]!.sessionId).toBe('session-3')
    })

    it('search: an array of sources is OR-matched and still excludes codex', () => {
      const results = searchIndex.search('database', { source: ['claude-code'] })
      expect(results.length).toBeGreaterThan(0)
      expect(results.some(r => r.sessionId === 'session-3')).toBe(false)
    })

    it('searchCount: stays in sync with the source-filtered search() count', () => {
      const filteredResults = searchIndex.search('database', { source: 'codex' })
      const filteredCount = searchIndex.searchCount('database', { source: 'codex' })
      const unfilteredCount = searchIndex.searchCount('database')

      expect(filteredCount).toBe(filteredResults.length)
      expect(filteredCount).toBeLessThan(unfilteredCount)
    })
  })
})
