import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from '../services/index-manager'
import { loadCrossSourceSessions } from './get-project'

describe('loadCrossSourceSessions', () => {
  let tempDir: string
  let db: Database.Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'get-project-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')

    const indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('matches sessions via project_id (V7 rows)', () => {
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, project_id, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-claude', 'claude-code', '-home-kitty-repo', '/home/kitty/repo', '2026-08-01T00:00:00Z')
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, project_id, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-codex', 'codex', '/home/kitty/repo', '/home/kitty/repo', '2026-08-02T00:00:00Z')
    // A session belonging to a DIFFERENT project — must be excluded.
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, project_id, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-other', 'claude-code', '-home-kitty-other', '/home/kitty/other', '2026-08-03T00:00:00Z')

    const sessions = loadCrossSourceSessions(db, '/home/kitty/repo', ['-home-kitty-repo', '/home/kitty/repo'])

    expect(sessions.map(s => s.id).sort()).toEqual(['session-claude', 'session-codex'])
    expect(sessions.every(s => s.id !== 'session-other')).toBe(true)
  })

  it('falls back to project_slug when project_id is NULL (pre-V7 rows)', () => {
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, started_at)
      VALUES (?, ?, ?, ?)
    `).run('session-pre-v7', 'claude-code', '-home-kitty-repo', '2026-01-01T00:00:00Z')

    const sessions = loadCrossSourceSessions(db, '/home/kitty/repo', ['-home-kitty-repo'])

    expect(sessions.map(s => s.id)).toEqual(['session-pre-v7'])
  })

  it('does NOT fall back to project_slug when project_id IS populated but points elsewhere (proves project_id takes precedence)', () => {
    // project_id disagrees with project_slug — a buggy implementation that
    // checked project_slug first (or OR'd them unconditionally) would wrongly
    // include this row.
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, project_id, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('session-elsewhere', 'claude-code', '-home-kitty-repo', '/home/kitty/some-other-project', '2026-01-01T00:00:00Z')

    const sessions = loadCrossSourceSessions(db, '/home/kitty/repo', ['-home-kitty-repo'])

    expect(sessions).toHaveLength(0)
  })

  it('excludes sessions whose project_slug is not in the known-slugs list', () => {
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, started_at)
      VALUES (?, ?, ?, ?)
    `).run('session-unrelated', 'pi-code', '--home-kitty-unrelated--', '2026-01-01T00:00:00Z')

    const sessions = loadCrossSourceSessions(db, '/home/kitty/repo', ['-home-kitty-repo'])

    expect(sessions).toHaveLength(0)
  })

  it('orders sessions by started_at descending and carries source + model', () => {
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, project_id, started_at, model)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('session-earlier', 'claude-code', '-home-kitty-repo', '/home/kitty/repo', '2026-08-01T00:00:00Z', 'claude-opus-4-6')
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, project_id, started_at, model)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('session-later', 'codex', '/home/kitty/repo', '/home/kitty/repo', '2026-08-02T00:00:00Z', null)

    const sessions = loadCrossSourceSessions(db, '/home/kitty/repo', [])

    expect(sessions.map(s => s.id)).toEqual(['session-later', 'session-earlier'])
    expect(sessions[0]!.source).toBe('codex')
    expect(sessions[0]!.model).toBeUndefined()
    expect(sessions[1]!.model).toBe('claude-opus-4-6')
  })
})
