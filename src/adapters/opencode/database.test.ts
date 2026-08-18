import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OpencodeDatabase, defaultOpencodeDbPath } from './database'
import { buildFixtureDb } from './test-fixture'

describe('defaultOpencodeDbPath', () => {
  it('points at ~/.local/share/opencode/opencode.db', () => {
    expect(defaultOpencodeDbPath()).toBe(join(homedir(), '.local', 'share', 'opencode', 'opencode.db'))
  })
})

describe('OpencodeDatabase', () => {
  it('tolerates a missing database file', () => {
    const db = new OpencodeDatabase('/nonexistent/path/opencode.db')
    expect(db.get()).toBeUndefined()
    // Calling again must not throw either.
    expect(db.get()).toBeUndefined()
  })

  it('opens an existing database read-only', () => {
    const dbPath = buildFixtureDb()
    const db = new OpencodeDatabase(dbPath)
    const handle = db.get()
    expect(handle).toBeDefined()
    const row = handle?.prepare('SELECT COUNT(*) as cnt FROM project').get() as { cnt: number }
    expect(row.cnt).toBe(1)
  })

  it('never allows a write through the readonly handle', () => {
    const dbPath = buildFixtureDb()
    const db = new OpencodeDatabase(dbPath)
    const handle = db.get()
    expect(() => handle?.prepare("UPDATE project SET name = 'x'").run()).toThrow()
  })
})
