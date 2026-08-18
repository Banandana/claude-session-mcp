import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from '../services/index-manager'
import { queryListSessions } from './list-sessions'

describe('queryListSessions source filter', () => {
  let tempDir: string
  let db: Database.Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'list-sessions-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')

    const indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()

    const insertSession = db.prepare(`
      INSERT INTO sessions (id, source, project_slug, started_at, total_tokens)
      VALUES (?, ?, ?, ?, ?)
    `)
    insertSession.run('session-claude', 'claude-code', 'project-alpha', '2026-03-28T10:00:00Z', 1000)
    insertSession.run('session-pi', 'pi-code', 'project-alpha', '2026-03-28T11:00:00Z', 2000)
    insertSession.run('session-codex', 'codex', 'project-alpha', '2026-03-28T12:00:00Z', 3000)
    insertSession.run('session-opencode', 'opencode', 'project-alpha', '2026-03-28T13:00:00Z', 4000)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('returns sessions from every source when no source filter is set', () => {
    const { sessions, total } = queryListSessions(db, {}, 'recent', 50, 0)
    expect(total).toBe(4)
    expect(sessions.map(s => s.source).sort()).toEqual(['claude-code', 'codex', 'opencode', 'pi-code'])
  })

  it('filters to a single source string', () => {
    const { sessions, total } = queryListSessions(db, { source: 'codex' }, 'recent', 50, 0)
    expect(total).toBe(1)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe('session-codex')
  })

  it('filters to an array of sources (OR-matched)', () => {
    const { sessions, total } = queryListSessions(db, { source: ['claude-code', 'opencode'] }, 'recent', 50, 0)
    expect(total).toBe(2)
    expect(sessions.map(s => s.id).sort()).toEqual(['session-claude', 'session-opencode'])
  })

  it('an unmatched source excludes everything (proves the filter is applied, not ignored)', () => {
    const { sessions, total } = queryListSessions(db, { source: 'nonexistent-source' }, 'recent', 50, 0)
    expect(total).toBe(0)
    expect(sessions).toHaveLength(0)
  })

  it('combines with other filters (project + source)', () => {
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, started_at, total_tokens)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-codex-other-project', 'codex', 'project-beta', '2026-03-28T14:00:00Z', 500)

    const { sessions, total } = queryListSessions(
      db, { projectSlug: 'project-alpha', source: 'codex' }, 'recent', 50, 0,
    )
    expect(total).toBe(1)
    expect(sessions[0]!.id).toBe('session-codex')
  })

  it('the countRow total respects the source filter, not just the returned page', () => {
    // limit=1 forces pagination — total must still reflect the FULL
    // filtered set, not just what fits on this page.
    const { sessions, total } = queryListSessions(
      db, { source: ['claude-code', 'pi-code', 'codex'] }, 'recent', 1, 0,
    )
    expect(sessions).toHaveLength(1)
    expect(total).toBe(3)
  })
})
