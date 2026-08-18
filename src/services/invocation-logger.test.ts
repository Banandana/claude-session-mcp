import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { ToolInvocationLogger, canonicalStringify } from './invocation-logger'
import { IndexManager } from './index-manager'

describe('ToolInvocationLogger', () => {
  let db: Database.Database
  let logger: ToolInvocationLogger

  beforeEach(() => {
    db = new Database(':memory:')
    new IndexManager(db).ensureSchema()
    logger = new ToolInvocationLogger(db)
  })

  afterEach(() => {
    db.close()
  })

  it('writes a raw invocation row for any tool', () => {
    logger.record({
      toolName: 'list_projects',
      rawParams: {},
      status: 'ok',
      durationMs: 12,
      resultSize: 500,
    })

    const rows = db.prepare('SELECT * FROM tool_invocations').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].tool_name).toBe('list_projects')
    expect(rows[0].result_status).toBe('ok')
    expect(rows[0].result_size).toBe(500)
    expect(rows[0].duration_ms).toBe(12)
  })

  it('writes a raw invocation row on error too', () => {
    logger.record({
      toolName: 'analyze',
      rawParams: { metric: 'errors' },
      status: 'error',
      durationMs: 3,
      resultSize: 0,
    })

    const raw = db.prepare('SELECT * FROM tool_invocations').all() as Array<Record<string, unknown>>
    expect(raw).toHaveLength(1)
    expect(raw[0].result_status).toBe('error')
  })

  it('records calledAt when provided', () => {
    logger.record({
      toolName: 'analyze',
      rawParams: { metric: 'errors', project: 'proj-a' },
      status: 'ok',
      durationMs: 5,
      resultSize: 100,
      calledAt: 1_000,
    })

    const rows = db.prepare('SELECT * FROM tool_invocations').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].called_at).toBe(1_000)
  })

  it('canonical stringify sorts object keys recursively', () => {
    const a = canonicalStringify({ b: 1, a: { y: 2, x: 1 } })
    const b = canonicalStringify({ a: { x: 1, y: 2 }, b: 1 })
    expect(a).toBe(b)
  })

  it('swallows database errors so real tool calls keep working', () => {
    // Drop the table out from under the logger
    db.exec('DROP TABLE tool_invocations')
    expect(() => logger.record({
      toolName: 'analyze',
      rawParams: { metric: 'errors' },
      status: 'ok',
      durationMs: 1,
      resultSize: 0,
    })).not.toThrow()
  })
})
