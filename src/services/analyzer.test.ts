import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from './index-manager'
import { Analyzer } from './analyzer'

describe('Analyzer', () => {
  let tempDir: string
  let db: Database.Database
  let analyzer: Analyzer

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'analyzer-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')

    const indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()

    // Insert sessions
    const insertSession = db.prepare(`
      INSERT INTO sessions (id, source, project_slug, started_at, total_tokens)
      VALUES (?, ?, ?, ?, ?)
    `)
    insertSession.run('session-alpha-1', 'claude-code', 'project-alpha', '2026-03-28T10:00:00Z', 5000)
    insertSession.run('session-alpha-2', 'claude-code', 'project-alpha', '2026-03-28T11:00:00Z', 3000)
    insertSession.run('session-beta-1', 'claude-code', 'project-beta', '2026-03-28T12:00:00Z', 8000)
    insertSession.run('session-beta-2', 'claude-code', 'project-beta', '2026-03-28T13:00:00Z', 1000)

    // Insert messages
    const insertMsg = db.prepare(`
      INSERT INTO messages (id, session_id, role, type, timestamp, is_error, is_correction, has_tool_use, tool_names)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    // Errors: session-alpha-1 has 3, session-alpha-2 has 1, session-beta-1 has 2
    insertMsg.run('msg-e1', 'session-alpha-1', 'assistant', 'assistant', '2026-03-28T10:01:00Z', 1, 0, 0, null)
    insertMsg.run('msg-e2', 'session-alpha-1', 'assistant', 'assistant', '2026-03-28T10:02:00Z', 1, 0, 0, null)
    insertMsg.run('msg-e3', 'session-alpha-1', 'assistant', 'assistant', '2026-03-28T10:03:00Z', 1, 0, 0, null)
    insertMsg.run('msg-e4', 'session-alpha-2', 'assistant', 'assistant', '2026-03-28T11:01:00Z', 1, 0, 0, null)
    insertMsg.run('msg-e5', 'session-beta-1', 'assistant', 'assistant', '2026-03-28T12:01:00Z', 1, 0, 0, null)
    insertMsg.run('msg-e6', 'session-beta-1', 'assistant', 'assistant', '2026-03-28T12:02:00Z', 1, 0, 0, null)

    // Corrections: session-alpha-2 has 2, session-beta-2 has 1
    insertMsg.run('msg-c1', 'session-alpha-2', 'user', 'user', '2026-03-28T11:02:00Z', 0, 1, 0, null)
    insertMsg.run('msg-c2', 'session-alpha-2', 'user', 'user', '2026-03-28T11:03:00Z', 0, 1, 0, null)
    insertMsg.run('msg-c3', 'session-beta-2', 'user', 'user', '2026-03-28T13:01:00Z', 0, 1, 0, null)

    // Tool failures: Bash x2, Read x1
    insertMsg.run('msg-tf1', 'session-alpha-1', 'assistant', 'assistant', '2026-03-28T10:04:00Z', 1, 0, 1, 'Bash')
    insertMsg.run('msg-tf2', 'session-beta-1', 'assistant', 'assistant', '2026-03-28T12:03:00Z', 1, 0, 1, 'Bash')
    insertMsg.run('msg-tf3', 'session-alpha-2', 'assistant', 'assistant', '2026-03-28T11:04:00Z', 1, 0, 1, 'Read')

    // Normal messages (no errors or corrections)
    insertMsg.run('msg-n1', 'session-alpha-1', 'user', 'user', '2026-03-28T10:00:30Z', 0, 0, 0, null)
    insertMsg.run('msg-n2', 'session-beta-1', 'user', 'user', '2026-03-28T12:00:30Z', 0, 0, 0, null)

    // Insert file_changes
    const insertFile = db.prepare(`
      INSERT INTO file_changes (session_id, message_id, file_path, operation, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `)
    // src/index.ts changed 3 times, src/utils.ts 2 times, src/types.ts 1 time
    insertFile.run('session-alpha-1', 'msg-n1', 'src/index.ts', 'edit', '2026-03-28T10:01:00Z')
    insertFile.run('session-alpha-1', 'msg-n1', 'src/index.ts', 'edit', '2026-03-28T10:02:00Z')
    insertFile.run('session-beta-1', 'msg-n2', 'src/index.ts', 'edit', '2026-03-28T12:01:00Z')
    insertFile.run('session-alpha-2', null, 'src/utils.ts', 'edit', '2026-03-28T11:01:00Z')
    insertFile.run('session-beta-1', null, 'src/utils.ts', 'edit', '2026-03-28T12:02:00Z')
    insertFile.run('session-beta-2', null, 'src/types.ts', 'edit', '2026-03-28T13:01:00Z')

    analyzer = new Analyzer(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  describe('errors metric', () => {
    it('returns sessions ranked by error count', () => {
      const results = analyzer.analyze('errors')
      expect(results.length).toBeGreaterThan(0)
      // session-alpha-1 has most errors (3 + 1 from tool failure = 4 total with is_error=1)
      expect(results[0].sessionId).toBe('session-alpha-1')
      expect(results[0].count).toBeGreaterThanOrEqual(3)
      // Verify descending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].count).toBeGreaterThanOrEqual(results[i].count)
      }
    })

    it('includes sessionId and projectSlug in results', () => {
      const results = analyzer.analyze('errors')
      expect(results[0].sessionId).toBeDefined()
      expect(results[0].projectSlug).toBeDefined()
      // Label is human-readable: "YYYY-MM-DD" or "YYYY-MM-DD — topic"
      expect(results[0].label).toMatch(/^\d{4}-\d{2}-\d{2}/)
      expect(results[0].sessionId).toBeDefined()
    })

    it('filters by project slug', () => {
      const results = analyzer.analyze('errors', { projectSlug: 'project-alpha' })
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.projectSlug).toBe('project-alpha')
      }
    })

    it('respects limit', () => {
      const results = analyzer.analyze('errors', { limit: 1 })
      expect(results.length).toBe(1)
    })

    it('returns empty for project with no errors', () => {
      const results = analyzer.analyze('errors', { projectSlug: 'project-nonexistent' })
      expect(results).toEqual([])
    })
  })

  describe('corrections metric', () => {
    it('returns sessions ranked by correction count', () => {
      const results = analyzer.analyze('corrections')
      expect(results.length).toBeGreaterThan(0)
      // session-alpha-2 has 2 corrections (top)
      expect(results[0].sessionId).toBe('session-alpha-2')
      expect(results[0].count).toBe(2)
      // Verify descending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].count).toBeGreaterThanOrEqual(results[i].count)
      }
    })

    it('filters by project slug', () => {
      const results = analyzer.analyze('corrections', { projectSlug: 'project-beta' })
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.projectSlug).toBe('project-beta')
      }
    })

    it('respects limit', () => {
      const results = analyzer.analyze('corrections', { limit: 1 })
      expect(results.length).toBe(1)
    })

    it('returns empty for metric with no matching data', () => {
      // project-alpha-1 session has no corrections
      const results = analyzer.analyze('corrections', { projectSlug: 'project-nonexistent' })
      expect(results).toEqual([])
    })
  })

  describe('tool_failures metric', () => {
    it('returns tools ranked by failure count', () => {
      const results = analyzer.analyze('tool_failures')
      expect(results.length).toBeGreaterThan(0)
      // Bash appears in 2 sessions, Read in 1
      expect(results[0].label).toBe('Bash')
      expect(results[0].count).toBe(2)
      // Verify descending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].count).toBeGreaterThanOrEqual(results[i].count)
      }
    })

    it('includes tool name as label and details', () => {
      const results = analyzer.analyze('tool_failures')
      expect(results[0].label).toBe(results[0].details)
    })

    it('respects limit', () => {
      const results = analyzer.analyze('tool_failures', { limit: 1 })
      expect(results.length).toBe(1)
    })

    it('returns empty when no tool failures exist', () => {
      // Use a fresh db with only non-error tool messages
      db.prepare(`DELETE FROM messages WHERE has_tool_use = 1`).run()
      const results = analyzer.analyze('tool_failures')
      expect(results).toEqual([])
    })

    it('splits a multi-tool error turn so BOTH tools get credited (regression: GROUP BY raw CSV string)', () => {
      // Before the fix, a turn with tool_names='Bash,Read' formed its own
      // "Bash,Read" bucket instead of incrementing the existing Bash and
      // Read buckets.
      db.prepare(`
        INSERT INTO messages (id, session_id, role, type, timestamp, is_error, is_correction, has_tool_use, tool_names)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('msg-tf-multi', 'session-alpha-1', 'assistant', 'assistant', '2026-03-28T10:05:00Z', 1, 0, 1, 'Bash,Read')

      const results = analyzer.analyze('tool_failures')
      const byLabel = new Map(results.map(r => [r.label, r.count]))

      expect(byLabel.has('Bash,Read')).toBe(false)
      // Existing fixture: Bash x2 (msg-tf1, msg-tf2), Read x1 (msg-tf3),
      // plus this new multi-tool turn credits both.
      expect(byLabel.get('Bash')).toBe(3)
      expect(byLabel.get('Read')).toBe(2)
    })
  })

  describe('costly_sessions metric', () => {
    it('returns sessions ranked by token count', () => {
      const results = analyzer.analyze('costly_sessions')
      expect(results.length).toBeGreaterThan(0)
      // session-beta-1 has 8000 tokens (highest)
      expect(results[0].sessionId).toBe('session-beta-1')
      expect(results[0].count).toBe(8000)
      // Verify descending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].count).toBeGreaterThanOrEqual(results[i].count)
      }
    })

    it('filters by project slug', () => {
      const results = analyzer.analyze('costly_sessions', { projectSlug: 'project-alpha' })
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.projectSlug).toBe('project-alpha')
      }
      // alpha sessions: 5000, 3000
      expect(results[0].count).toBe(5000)
    })

    it('respects limit', () => {
      const results = analyzer.analyze('costly_sessions', { limit: 2 })
      expect(results.length).toBe(2)
    })

    it('returns empty for nonexistent project', () => {
      const results = analyzer.analyze('costly_sessions', { projectSlug: 'nonexistent' })
      expect(results).toEqual([])
    })
  })

  describe('frequent_files metric', () => {
    it('returns files ranked by change frequency', () => {
      const results = analyzer.analyze('frequent_files')
      expect(results.length).toBeGreaterThan(0)
      // src/index.ts changed 3 times (most)
      expect(results[0].label).toBe('src/index.ts')
      expect(results[0].count).toBe(3)
      // Verify descending order
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].count).toBeGreaterThanOrEqual(results[i].count)
      }
    })

    it('includes file path as label and details', () => {
      const results = analyzer.analyze('frequent_files')
      expect(results[0].label).toBe(results[0].details)
    })

    it('filters by project slug', () => {
      // project-alpha has sessions alpha-1 (src/index.ts x2) and alpha-2 (src/utils.ts x1)
      const results = analyzer.analyze('frequent_files', { projectSlug: 'project-alpha' })
      expect(results.length).toBeGreaterThan(0)
      // src/index.ts: 2 changes in alpha, src/utils.ts: 1 change in alpha
      expect(results[0].label).toBe('src/index.ts')
      expect(results[0].count).toBe(2)
    })

    it('respects limit', () => {
      const results = analyzer.analyze('frequent_files', { limit: 1 })
      expect(results.length).toBe(1)
    })

    it('returns empty when no file changes exist', () => {
      db.prepare(`DELETE FROM file_changes`).run()
      const results = analyzer.analyze('frequent_files')
      expect(results).toEqual([])
    })
  })

  describe('date range filtering', () => {
    it('errors: filters by date range', () => {
      // Only include messages from 10:00 - 10:59 (session-alpha-1 only)
      const results = analyzer.analyze('errors', {
        dateRange: { from: '2026-03-28T10:00:00Z', to: '2026-03-28T10:59:59Z' },
      })
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.projectSlug).toBe('project-alpha')
        expect(r.sessionId).toBe('session-alpha-1')
      }
    })

    it('costly_sessions: filters by date range', () => {
      // Only include sessions started after 12:00 (beta sessions)
      const results = analyzer.analyze('costly_sessions', {
        dateRange: { from: '2026-03-28T12:00:00Z' },
      })
      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.projectSlug).toBe('project-beta')
      }
    })
  })
})
