import 'reflect-metadata'
import { injectable, inject } from 'inversify'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { TOKENS } from '../container/tokens'

/**
 * Resolves the index database path. `SESSION_HISTORY_DB` overrides;
 * otherwise defaults to `~/.local/share/session-history-mcp/index.db`.
 * Deliberately independent of any per-adapter data directory (e.g.
 * `~/.claude`) — four agents' history should not live inside one agent's
 * own directory. No migration needed: no index database exists on any
 * machine yet.
 *
 * `homedir()` is resolved fresh on each call (not cached at module load)
 * so it honors a `HOME` override made after import — relevant for tests.
 */
function resolveDbPath(): string {
  return process.env['SESSION_HISTORY_DB'] || join(homedir(), '.local', 'share', 'session-history-mcp', 'index.db')
}

@injectable()
export class DatabaseConnection {
  private db: Database.Database | null = null
  private vecLoaded = false

  constructor(
    // Retained for constructor-signature stability with existing DI wiring
    // in container/modules.ts — no longer used to locate the database file.
    @inject(TOKENS.ClaudeDataDir) private readonly claudeDir: string
  ) {}

  get(): Database.Database {
    if (!this.db) {
      const dbPath = resolveDbPath()
      mkdirSync(dirname(dbPath), { recursive: true })
      this.db = new Database(dbPath)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('synchronous = NORMAL')

      // sqlite-vec provides the vec0 virtual table used by semantic search.
      // Loading it is best-effort — on platforms without a prebuilt binary
      // the semantic_search tool will surface the error at query time.
      try {
        sqliteVec.load(this.db)
        this.vecLoaded = true
      } catch {
        this.vecLoaded = false
      }
    }
    return this.db
  }

  /** True if the sqlite-vec extension loaded successfully. */
  isVecAvailable(): boolean {
    if (!this.db) this.get()
    return this.vecLoaded
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}
