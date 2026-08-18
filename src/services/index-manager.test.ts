import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from './index-manager'

function getTableColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map(r => r.name)
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table)
  return row !== undefined
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
  ).get(indexName)
  return row !== undefined
}

/** Reproduce the v0 schema exactly as it existed before this migration */
function createV0Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      project_slug TEXT,
      cwd TEXT,
      branch TEXT,
      started_at TEXT,
      model TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_turns INTEGER DEFAULT 0,
      summary_text TEXT,
      byte_offset INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1,
      indexed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT,
      type TEXT,
      timestamp TEXT,
      model TEXT,
      token_count INTEGER DEFAULT 0,
      has_tool_use INTEGER DEFAULT 0,
      tool_names TEXT,
      is_error INTEGER DEFAULT 0,
      is_correction INTEGER DEFAULT 0,
      content_preview TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content_preview,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS file_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      message_id TEXT,
      file_path TEXT,
      operation TEXT,
      timestamp TEXT
    );

    CREATE TABLE IF NOT EXISTS subagents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      agent_type TEXT,
      description TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_tools INTEGER DEFAULT 0,
      duration_ms INTEGER,
      model TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_slug TEXT NOT NULL,
      file_name TEXT NOT NULL,
      name TEXT,
      description TEXT,
      type TEXT,
      content TEXT,
      UNIQUE(project_slug, file_name)
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      summary_text TEXT,
      generated_at TEXT,
      UNIQUE(entity_type, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project_slug ON sessions(project_slug);
    CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_is_error ON messages(session_id) WHERE is_error = 1;
    CREATE INDEX IF NOT EXISTS idx_messages_is_correction ON messages(session_id) WHERE is_correction = 1;
    CREATE INDEX IF NOT EXISTS idx_file_changes_session_id ON file_changes(session_id);
    CREATE INDEX IF NOT EXISTS idx_file_changes_file_path ON file_changes(file_path);
    CREATE INDEX IF NOT EXISTS idx_subagents_session_id ON subagents(session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_project_slug ON memory_entries(project_slug);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_type ON memory_entries(type);
  `)
  // user_version stays at 0 (SQLite default) — this is the v0 indicator
}

describe('IndexManager', () => {
  let tempDir: string
  let db: Database.Database
  let manager: IndexManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'index-manager-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    manager = new (IndexManager as unknown as new (db: Database.Database) => IndexManager)(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  // ─── Fresh schema (v1) ────────────────────────────────────────────────────

  describe('fresh schema', () => {
    it('creates all core tables', () => {
      manager.ensureSchema()

      expect(tableExists(db, 'sessions')).toBe(true)
      expect(tableExists(db, 'messages')).toBe(true)
      expect(tableExists(db, 'file_changes')).toBe(true)
      expect(tableExists(db, 'subagents')).toBe(true)
      expect(tableExists(db, 'memory_entries')).toBe(true)
    })

    it('creates FTS5 virtual table', () => {
      manager.ensureSchema()

      const vtable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
      ).get() as { name: string } | undefined

      expect(vtable?.name).toBe('messages_fts')
    })

    it('does NOT create the summaries table', () => {
      manager.ensureSchema()
      expect(tableExists(db, 'summaries')).toBe(false)
    })

    it('sessions table has all new columns', () => {
      manager.ensureSchema()
      const columns = getTableColumns(db, 'sessions')

      expect(columns).toContain('ended_at')
      expect(columns).toContain('duration_minutes')
      expect(columns).toContain('message_count')
      expect(columns).toContain('error_count')
      expect(columns).toContain('correction_count')
      expect(columns).toContain('subagent_count')
      expect(columns).toContain('tool_counts')
      expect(columns).toContain('files_changed')
      expect(columns).toContain('topic')
      expect(columns).toContain('summary')
      expect(columns).toContain('summary_generated_at')
    })

    it('sets user_version to latest', () => {
      manager.ensureSchema()
      const version = db.pragma('user_version', { simple: true }) as number
      expect(version).toBe(7)
    })

    it('creates new sort indexes', () => {
      manager.ensureSchema()

      expect(indexExists(db, 'idx_sessions_duration')).toBe(true)
      expect(indexExists(db, 'idx_sessions_total_turns')).toBe(true)
      expect(indexExists(db, 'idx_sessions_error_count')).toBe(true)
      expect(indexExists(db, 'idx_sessions_total_tokens')).toBe(true)
    })

    it('is idempotent — calling ensureSchema twice does not error', () => {
      expect(() => {
        manager.ensureSchema()
        manager.ensureSchema()
      }).not.toThrow()
    })
  })

  // ─── Existing utility methods ─────────────────────────────────────────────

  describe('utility methods', () => {
    beforeEach(() => {
      manager.ensureSchema()
    })

    it('tracks session byte offsets correctly', () => {
      db.prepare(
        `INSERT INTO sessions (id, source, byte_offset) VALUES (?, ?, ?)`
      ).run('session-001', 'claude-code', 0)

      expect(manager.getSessionWatermark('session-001')).toBe(0)
      manager.updateSessionWatermark('session-001', 4096)
      expect(manager.getSessionWatermark('session-001')).toBe(4096)
    })

    it('returns 0 for unknown session offset', () => {
      expect(manager.getSessionWatermark('nonexistent-session')).toBe(0)
    })

    it('returns all known session IDs', () => {
      db.prepare(`INSERT INTO sessions (id, source) VALUES (?, ?)`).run('s1', 'claude-code')
      db.prepare(`INSERT INTO sessions (id, source) VALUES (?, ?)`).run('s2', 'claude-code')

      const ids = manager.getKnownSessionIds()
      expect(ids).toBeInstanceOf(Set)
      expect(ids.has('s1')).toBe(true)
      expect(ids.has('s2')).toBe(true)
      expect(ids.size).toBe(2)
    })
  })

  // ─── V1 → V2 migration ───────────────────────────────────────────────────

  describe('v1 → v2 migration (turn_events)', () => {
    it('creates turn_events table with correct schema', () => {
      manager.ensureSchema()

      const columns = db.prepare("PRAGMA table_info('turn_events')").all() as Array<{ name: string; type: string; notnull: number }>
      const colNames = columns.map(c => c.name)

      expect(colNames).toContain('session_id')
      expect(colNames).toContain('turn_index')
      expect(colNames).toContain('turn_id')
      expect(colNames).toContain('role')
      expect(colNames).toContain('timestamp')
      expect(colNames).toContain('tool_names')
      expect(colNames).toContain('is_error')
      expect(colNames).toContain('is_correction')
      expect(colNames).toContain('text_preview')
    })

    it('adds turn_events_indexed column to sessions', () => {
      manager.ensureSchema()

      const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
      expect(columns.some(c => c.name === 'turn_events_indexed')).toBe(true)
    })

    it('sets user_version to latest', () => {
      manager.ensureSchema()

      const version = db.pragma('user_version', { simple: true }) as number
      expect(version).toBe(7)
    })

    it('creates turn_events indexes', () => {
      manager.ensureSchema()

      expect(indexExists(db, 'idx_turn_events_error')).toBe(true)
      expect(indexExists(db, 'idx_turn_events_correction')).toBe(true)
      expect(indexExists(db, 'idx_turn_events_timestamp')).toBe(true)
      expect(indexExists(db, 'idx_turn_events_session_id')).toBe(true)
    })

    it('migration is idempotent — calling ensureSchema twice does not error', () => {
      manager.ensureSchema()
      expect(() => manager.ensureSchema()).not.toThrow()
    })
  })

  // ─── addColumnIfMissing race condition safety ─────────────────────────────

  describe('addColumnIfMissing race safety', () => {
    it('handles column already existing gracefully', () => {
      // First call adds the column via ensureSchema
      manager.ensureSchema()

      // Second call should not throw even though columns exist
      expect(() => manager.ensureSchema()).not.toThrow()
    })
  })

  // ─── V0 → V1 migration ───────────────────────────────────────────────────

  describe('v0 → v1 migration', () => {
    beforeEach(() => {
      // Set up v0 schema before creating IndexManager
      db.close()
      db = new Database(join(tempDir, 'v0.db'))
      db.pragma('foreign_keys = ON')
      createV0Schema(db)
      manager = new (IndexManager as unknown as new (db: Database.Database) => IndexManager)(db)
    })

    it('adds all new columns without losing existing data', () => {
      db.prepare(`
        INSERT INTO sessions (id, source, project_slug, started_at, total_tokens, total_turns)
        VALUES ('sess-001', 'test', 'my-project', '2024-01-01T00:00:00Z', 1000, 5)
      `).run()

      manager.ensureSchema()

      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-001') as Record<string, unknown>

      // Original data preserved
      expect(row['id']).toBe('sess-001')
      expect(row['source']).toBe('test')
      expect(row['project_slug']).toBe('my-project')
      expect(row['total_tokens']).toBe(1000)
      expect(row['total_turns']).toBe(5)

      // New columns added (null or default values)
      expect('ended_at' in row).toBe(true)
      expect('duration_minutes' in row).toBe(true)
      expect('message_count' in row).toBe(true)
      expect('error_count' in row).toBe(true)
      expect('correction_count' in row).toBe(true)
      expect('subagent_count' in row).toBe(true)
      expect('tool_counts' in row).toBe(true)
      expect('files_changed' in row).toBe(true)
      expect('topic' in row).toBe(true)
      expect('summary' in row).toBe(true)
      expect('summary_generated_at' in row).toBe(true)
    })

    it('drops the summaries table', () => {
      expect(tableExists(db, 'summaries')).toBe(true)

      manager.ensureSchema()

      expect(tableExists(db, 'summaries')).toBe(false)
    })

    it('sets user_version to latest (all migrations applied)', () => {
      const vBefore = db.pragma('user_version', { simple: true }) as number
      expect(vBefore).toBe(0)

      manager.ensureSchema()

      const vAfter = db.pragma('user_version', { simple: true }) as number
      expect(vAfter).toBe(7)
    })

    it('creates new sort indexes', () => {
      manager.ensureSchema()

      expect(indexExists(db, 'idx_sessions_duration')).toBe(true)
      expect(indexExists(db, 'idx_sessions_total_turns')).toBe(true)
      expect(indexExists(db, 'idx_sessions_error_count')).toBe(true)
      expect(indexExists(db, 'idx_sessions_total_tokens')).toBe(true)
    })

    it('migration is idempotent — running ensureSchema twice on v0 does not error', () => {
      manager.ensureSchema()
      expect(() => manager.ensureSchema()).not.toThrow()
    })
  })

  // ─── V6 → V7 migration (canonical project identity) ───────────────────────

  describe('v6 → v7 migration (projects / project_aliases)', () => {
    it('creates the projects table', () => {
      manager.ensureSchema()

      expect(tableExists(db, 'projects')).toBe(true)
      const columns = getTableColumns(db, 'projects')
      expect(columns).toContain('id')
      expect(columns).toContain('path')
      expect(columns).toContain('first_seen_at')
    })

    it('creates the project_aliases table', () => {
      manager.ensureSchema()

      expect(tableExists(db, 'project_aliases')).toBe(true)
      const columns = getTableColumns(db, 'project_aliases')
      expect(columns).toContain('source')
      expect(columns).toContain('source_slug')
      expect(columns).toContain('project_id')
    })

    it('adds project_id column to sessions, keeping project_slug', () => {
      manager.ensureSchema()

      const columns = getTableColumns(db, 'sessions')
      expect(columns).toContain('project_id')
      expect(columns).toContain('project_slug')
    })

    it('lets project_aliases map multiple source slugs onto one canonical project', () => {
      manager.ensureSchema()

      db.prepare('INSERT INTO projects (id, path, first_seen_at) VALUES (?, ?, ?)')
        .run('/home/kitty/foo', '/home/kitty/foo', new Date().toISOString())
      db.prepare('INSERT INTO project_aliases (source, source_slug, project_id) VALUES (?, ?, ?)')
        .run('claude-code', '-home-kitty-foo', '/home/kitty/foo')
      db.prepare('INSERT INTO project_aliases (source, source_slug, project_id) VALUES (?, ?, ?)')
        .run('pi-code', '--home-kitty-foo--', '/home/kitty/foo')

      const rows = db.prepare('SELECT source, source_slug FROM project_aliases WHERE project_id = ?')
        .all('/home/kitty/foo') as Array<{ source: string; source_slug: string }>
      expect(rows).toHaveLength(2)
      expect(rows.map(r => r.source).sort()).toEqual(['claude-code', 'pi-code'])
    })

    it('sets user_version to latest', () => {
      manager.ensureSchema()
      const version = db.pragma('user_version', { simple: true }) as number
      expect(version).toBe(7)
    })

    it('migration is idempotent', () => {
      manager.ensureSchema()
      expect(() => manager.ensureSchema()).not.toThrow()
      expect(tableExists(db, 'projects')).toBe(true)
    })
  })
})
