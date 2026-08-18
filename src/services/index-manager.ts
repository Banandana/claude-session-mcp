import 'reflect-metadata'
import { injectable, inject } from 'inversify'
import type Database from 'better-sqlite3'
import { TOKENS } from '../container/tokens'
import type { DatabaseConnection } from '../infrastructure/database'

@injectable()
export class IndexManager {
  private db: Database.Database

  constructor(
    @inject(TOKENS.Database) dbOrConnection: Database.Database | DatabaseConnection
  ) {
    if ('get' in dbOrConnection && typeof (dbOrConnection as DatabaseConnection).get === 'function') {
      this.db = (dbOrConnection as DatabaseConnection).get()
    } else {
      this.db = dbOrConnection as Database.Database
    }
  }

  ensureSchema(): void {
    // Step 1: Create base tables (columns that exist since v0, minus summaries)
    this.db.exec(`
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
        content_preview TEXT,
        search_text TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        search_text,
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

    // Step 2: Run versioned migrations (adds columns, drops summaries, creates new indexes)
    this.runMigrations()
  }

  private runMigrations(): void {
    const userVersion = this.db.pragma('user_version', { simple: true }) as number

    if (userVersion < 1) {
      this.db.transaction(() => {
        this.migrateToV1()
      })()
      this.db.pragma('user_version = 1')
    }
    if (userVersion < 2) {
      this.db.transaction(() => {
        this.migrateToV2()
      })()
      this.db.pragma('user_version = 2')
    }
    if (userVersion < 3) {
      this.db.transaction(() => {
        this.migrateToV3()
      })()
      this.db.pragma('user_version = 3')
    }
    if (userVersion < 4) {
      this.db.transaction(() => {
        this.migrateToV4()
      })()
      this.db.pragma('user_version = 4')
    }
    if (userVersion < 5) {
      this.db.transaction(() => {
        this.migrateToV5()
      })()
      this.db.pragma('user_version = 5')
    }
    if (userVersion < 6) {
      this.db.transaction(() => {
        this.migrateToV6()
      })()
      this.db.pragma('user_version = 6')
    }
    if (userVersion < 7) {
      this.db.transaction(() => {
        this.migrateToV7()
      })()
      this.db.pragma('user_version = 7')
    }
  }

  private migrateToV7(): void {
    // Canonical project identity: a `projects` table keyed on the real
    // filesystem path, with a `project_aliases` table mapping each
    // source's own slug encoding onto that canonical id. A claude slug
    // (-home-kitty-foo), a pi slug (--home-kitty-foo--), an opencode sha1,
    // and a bare Codex cwd can all describe the same directory — this is
    // what lets "show me everything that touched this repo" work across
    // sources. `project_slug` on `sessions` is kept as-is (additive) —
    // other tool queries still use it.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        first_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS project_aliases (
        source TEXT NOT NULL,
        source_slug TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        PRIMARY KEY (source, source_slug)
      );

      CREATE INDEX IF NOT EXISTS idx_project_aliases_project_id ON project_aliases(project_id);
    `)

    this.addColumnIfMissing('sessions', 'project_id', 'TEXT')
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id)`)
  }

  private migrateToV6(): void {
    // Marker for the one-time branch backfill — distinguishes "never checked"
    // from "checked, no gitBranch in JSONL" so the backfill loop terminates.
    this.addColumnIfMissing('sessions', 'metadata_backfilled_at', 'TEXT')
  }

  private migrateToV5(): void {
    // Tool-invocation log: every MCP call recorded as a raw row.
    // No result content stored — just status and byte size.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        params_json TEXT NOT NULL,
        params_hash TEXT NOT NULL,
        called_at INTEGER NOT NULL,
        duration_ms INTEGER,
        result_status TEXT NOT NULL,
        result_size INTEGER,
        caller_session TEXT,
        project_path TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tool_invocations_tool_hash_time
        ON tool_invocations(tool_name, params_hash, called_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_invocations_project_time
        ON tool_invocations(project_path, called_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_invocations_called_at
        ON tool_invocations(called_at DESC);

      CREATE TABLE IF NOT EXISTS audit_watermarks (
        tool_name TEXT NOT NULL,
        params_hash TEXT NOT NULL,
        params_canonical_json TEXT NOT NULL,
        project_path TEXT,
        first_called_at INTEGER NOT NULL,
        last_called_at INTEGER NOT NULL,
        call_count INTEGER NOT NULL,
        PRIMARY KEY (tool_name, params_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_audit_watermarks_project_recent
        ON audit_watermarks(project_path, last_called_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_watermarks_tool_recent
        ON audit_watermarks(tool_name, last_called_at DESC);
    `)
  }

  private migrateToV2(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turn_events (
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_index    INTEGER NOT NULL,
        turn_id       TEXT NOT NULL,
        role          TEXT NOT NULL,
        timestamp     TEXT NOT NULL,
        tool_names    TEXT NOT NULL DEFAULT '[]',
        is_error      INTEGER NOT NULL DEFAULT 0,
        is_correction INTEGER NOT NULL DEFAULT 0,
        text_preview  TEXT,
        PRIMARY KEY (session_id, turn_index)
      );

      CREATE INDEX IF NOT EXISTS idx_turn_events_error ON turn_events(is_error) WHERE is_error = 1;
      CREATE INDEX IF NOT EXISTS idx_turn_events_correction ON turn_events(is_correction) WHERE is_correction = 1;
      CREATE INDEX IF NOT EXISTS idx_turn_events_timestamp ON turn_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_turn_events_session_id ON turn_events(session_id);
    `)

    this.addColumnIfMissing('sessions', 'turn_events_indexed', 'INTEGER DEFAULT 0')
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.some(r => r.name === column)
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      } catch (err) {
        // Column may have been added concurrently — verify it exists now
        if (!this.hasColumn(table, column)) throw err
      }
    }
  }

  private migrateToV1(): void {
    this.addColumnIfMissing('sessions', 'ended_at', 'TEXT')
    this.addColumnIfMissing('sessions', 'duration_minutes', 'INTEGER')
    this.addColumnIfMissing('sessions', 'message_count', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'error_count', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'correction_count', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'subagent_count', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'tool_counts', 'TEXT')
    this.addColumnIfMissing('sessions', 'files_changed', 'TEXT')
    this.addColumnIfMissing('sessions', 'topic', 'TEXT')
    this.addColumnIfMissing('sessions', 'summary', 'TEXT')
    this.addColumnIfMissing('sessions', 'summary_generated_at', 'TEXT')

    // Drop the summaries table — replaced by columns on sessions
    this.db.exec(`DROP TABLE IF EXISTS summaries`)

    // New sort indexes (idempotent via IF NOT EXISTS)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_duration ON sessions(duration_minutes);
      CREATE INDEX IF NOT EXISTS idx_sessions_total_turns ON sessions(total_turns);
      CREATE INDEX IF NOT EXISTS idx_sessions_error_count ON sessions(error_count);
      CREATE INDEX IF NOT EXISTS idx_sessions_total_tokens ON sessions(total_tokens);
    `)
  }

  private migrateToV3(): void {
    // Session-level metadata from JSONL metadata entries
    this.addColumnIfMissing('sessions', 'custom_title', 'TEXT')
    this.addColumnIfMissing('sessions', 'ai_title', 'TEXT')
    this.addColumnIfMissing('sessions', 'tags', 'TEXT')             // JSON array
    this.addColumnIfMissing('sessions', 'cost_usd', 'REAL')
    this.addColumnIfMissing('sessions', 'mode', 'TEXT')             // 'coordinator' | 'normal'
    this.addColumnIfMissing('sessions', 'entrypoint', 'TEXT')       // 'cli' | 'sdk-ts' | etc.
    this.addColumnIfMissing('sessions', 'has_thinking', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'worktree_branch', 'TEXT')
    this.addColumnIfMissing('sessions', 'speculation_time_saved_ms', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'total_cache_read_tokens', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'total_cache_creation_tokens', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'models_used', 'TEXT')      // JSON array of distinct models

    // Per-message cache token tracking
    this.addColumnIfMissing('messages', 'cache_creation_tokens', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('messages', 'cache_read_tokens', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('messages', 'has_thinking', 'INTEGER DEFAULT 0')

    // PR links table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        pr_number INTEGER NOT NULL,
        pr_url TEXT NOT NULL,
        pr_repository TEXT NOT NULL,
        timestamp TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pr_links_session_id ON pr_links(session_id);
      CREATE INDEX IF NOT EXISTS idx_pr_links_repository ON pr_links(pr_repository);
    `)

    // Context collapses table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_collapses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        collapse_id TEXT NOT NULL,
        summary TEXT,
        first_archived_uuid TEXT,
        last_archived_uuid TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_context_collapses_session_id ON context_collapses(session_id);
    `)
  }

  private migrateToV4(): void {
    // Full-text search on complete message content instead of 500-char preview.
    // Add search_text column for full searchable content.
    this.addColumnIfMissing('messages', 'search_text', 'TEXT')

    // Recreate FTS table to index search_text instead of content_preview.
    // Drop old FTS and create new one as external-content table pointing at search_text.
    this.db.exec(`DROP TABLE IF EXISTS messages_fts`)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        search_text,
        content='messages',
        content_rowid='rowid'
      )
    `)

    // Force full re-index of all sessions so search_text gets populated
    this.db.exec(`UPDATE sessions SET byte_offset = 0`)
  }

  /**
   * The stored watermark for a session — an opaque, monotonically-
   * increasing integer an adapter uses to detect change (byte size for
   * file-backed sources, `time_updated` for DB-backed ones). The column
   * is still named `byte_offset` in SQL (no migration needed — same
   * INTEGER type, just a naming/contract change at the TS layer).
   */
  getSessionWatermark(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT byte_offset FROM sessions WHERE id = ?'
    ).get(sessionId) as { byte_offset: number } | undefined

    return row?.byte_offset ?? 0
  }

  getAllSessionWatermarks(): Map<string, number> {
    const rows = this.db.prepare(
      'SELECT id, byte_offset FROM sessions'
    ).all() as { id: string; byte_offset: number }[]
    const out = new Map<string, number>()
    for (const r of rows) out.set(r.id, r.byte_offset)
    return out
  }

  updateSessionWatermark(sessionId: string, watermark: number): void {
    this.db.prepare(
      'UPDATE sessions SET byte_offset = ? WHERE id = ?'
    ).run(watermark, sessionId)
  }

  getKnownSessionIds(): Set<string> {
    const rows = this.db.prepare('SELECT id FROM sessions').all() as { id: string }[]
    return new Set(rows.map(r => r.id))
  }
}
