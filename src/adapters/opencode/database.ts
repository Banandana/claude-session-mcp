import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `~/.local/share/opencode/opencode.db` — overridable via constructor arg. */
export function defaultOpencodeDbPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

/**
 * Lazily opens the opencode SQLite database, read-only. This file belongs
 * to the live `opencode` process — every call here must never write,
 * migrate, or run a mutating PRAGMA/VACUUM.
 *
 * Tolerant of absence by design: every caller in this adapter treats "no
 * database" identically to "no data" (empty results), never as an error.
 * `existsSync` is checked on every `get()` rather than cached negatively,
 * so an adapter constructed before opencode's first run will pick the
 * database up as soon as it appears, without needing to be recreated.
 */
export class OpencodeDatabase {
  private db: Database.Database | undefined

  constructor(private readonly dbPath: string) {}

  get(): Database.Database | undefined {
    if (this.db) return this.db
    if (!existsSync(this.dbPath)) return undefined
    try {
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true })
      return this.db
    } catch {
      return undefined
    }
  }
}
