import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseConnection } from './database'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('DatabaseConnection', () => {
  let tempDir: string
  let db: DatabaseConnection
  let originalEnv: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-mcp-test-'))
    originalEnv = process.env['SESSION_HISTORY_DB']
    // Path resolution now lives entirely inside DatabaseConnection.get(),
    // driven by SESSION_HISTORY_DB — not by the injected claudeDir (kept
    // only for constructor-signature stability). Point it at a temp file
    // so tests stay isolated from ~/.local/share/session-history-mcp.
    process.env['SESSION_HISTORY_DB'] = join(tempDir, 'index.db')
    db = new (DatabaseConnection as any)()
  })

  afterEach(() => {
    db.close()
    if (originalEnv === undefined) {
      delete process.env['SESSION_HISTORY_DB']
    } else {
      process.env['SESSION_HISTORY_DB'] = originalEnv
    }
    rmSync(tempDir, { recursive: true })
  })

  it('creates database with WAL mode', () => {
    const conn = db.get()
    const mode = conn.pragma('journal_mode', { simple: true })
    expect(mode).toBe('wal')
  })

  it('returns same connection on subsequent calls', () => {
    expect(db.get()).toBe(db.get())
  })

  it('creates new connection after close', () => {
    const first = db.get()
    db.close()
    const second = db.get()
    expect(second).not.toBe(first)
  })

  it('creates the database at the SESSION_HISTORY_DB path', () => {
    const dbPath = join(tempDir, 'index.db')
    db.get()
    expect(existsSync(dbPath)).toBe(true)
  })

  it('falls back to ~/.local/share/session-history-mcp/index.db when unset', () => {
    // Override HOME (not just skip SESSION_HISTORY_DB) so this never
    // touches the real default path on the machine running the test —
    // os.homedir() reads $HOME dynamically on POSIX.
    delete process.env['SESSION_HISTORY_DB']
    const originalHome = process.env['HOME']
    const fakeHome = mkdtempSync(join(tmpdir(), 'session-mcp-fakehome-'))
    process.env['HOME'] = fakeHome
    const fallbackDb = new (DatabaseConnection as any)()
    try {
      const conn = fallbackDb.get()
      const mode = conn.pragma('journal_mode', { simple: true })
      expect(mode).toBe('wal')
      const expectedPath = join(fakeHome, '.local', 'share', 'session-history-mcp', 'index.db')
      expect(existsSync(expectedPath)).toBe(true)
    } finally {
      fallbackDb.close()
      if (originalHome === undefined) {
        delete process.env['HOME']
      } else {
        process.env['HOME'] = originalHome
      }
      rmSync(fakeHome, { recursive: true })
    }
  })
})
