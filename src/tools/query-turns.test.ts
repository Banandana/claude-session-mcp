import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from '../services/index-manager'
import { messageMatchesFilters, summarizeMessage, summarizeFromDbRow, parseToolNames, queryCrossSession } from './query-turns'
import type { NormalizedMessage } from '../types'

function makeMessage(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    role: overrides.role ?? 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    contentBlocks: overrides.contentBlocks ?? [{ type: 'text', text: 'hello' }],
    isError: overrides.isError ?? false,
    isCorrection: overrides.isCorrection ?? false,
    hasThinking: false,
    uuid: overrides.id,
    toolNames: overrides.toolNames,
  }
}

describe('messageMatchesFilters', () => {
  it('filters by tool names', () => {
    const msg = makeMessage({ id: '1', toolNames: ['Bash', 'Edit'] })
    expect(messageMatchesFilters(msg, 0, { toolNames: ['Bash'] }).matches).toBe(true)
    expect(messageMatchesFilters(msg, 0, { toolNames: ['Read'] }).matches).toBe(false)
  })

  it('filters by error flag', () => {
    const msg = makeMessage({ id: '1', isError: true })
    expect(messageMatchesFilters(msg, 0, { isError: true }).matches).toBe(true)
    expect(messageMatchesFilters(msg, 0, { isError: false }).matches).toBe(false)
  })

  it('filters by text pattern with match context', () => {
    const msg = makeMessage({ id: '1', contentBlocks: [{ type: 'text', text: 'failed to compile auth module' }] })
    const result = messageMatchesFilters(msg, 0, { textPattern: 'compile' })
    expect(result.matches).toBe(true)
    expect(result.matchContext).toContain('compile')
  })

  it('filters by turn range', () => {
    const msg = makeMessage({ id: '1' })
    expect(messageMatchesFilters(msg, 5, { turnRange: { from: 3, to: 7 } }).matches).toBe(true)
    expect(messageMatchesFilters(msg, 1, { turnRange: { from: 3, to: 7 } }).matches).toBe(false)
  })

  it('returns true when no filters specified', () => {
    const msg = makeMessage({ id: '1' })
    expect(messageMatchesFilters(msg, 0, {}).matches).toBe(true)
  })

  it('filters by role', () => {
    const msg = makeMessage({ id: '1', role: 'user' })
    expect(messageMatchesFilters(msg, 0, { roles: ['user'] }).matches).toBe(true)
    expect(messageMatchesFilters(msg, 0, { roles: ['assistant'] }).matches).toBe(false)
  })

  it('filters by correction flag', () => {
    const msg = makeMessage({ id: '1', isCorrection: true })
    expect(messageMatchesFilters(msg, 0, { isCorrection: true }).matches).toBe(true)
    expect(messageMatchesFilters(msg, 0, { isCorrection: false }).matches).toBe(false)
  })

  it('combines multiple filters with AND logic', () => {
    const msg = makeMessage({ id: '1', role: 'assistant', isError: true, toolNames: ['Bash'] })
    expect(messageMatchesFilters(msg, 0, { isError: true, toolNames: ['Bash'] }).matches).toBe(true)
    expect(messageMatchesFilters(msg, 0, { isError: true, toolNames: ['Read'] }).matches).toBe(false)
  })
})

describe('parseToolNames', () => {
  it('parses valid JSON array', () => {
    expect(parseToolNames('["Bash","Edit"]')).toEqual(['Bash', 'Edit'])
  })

  it('returns empty array for empty JSON array', () => {
    expect(parseToolNames('[]')).toEqual([])
  })

  it('returns empty array for invalid JSON', () => {
    expect(parseToolNames('not-json')).toEqual([])
  })
})

describe('summarizeFromDbRow', () => {
  it('formats error with text preview', () => {
    const result = summarizeFromDbRow(true, [], 'command not found')
    expect(result).toBe('[error: command not found]')
  })

  it('truncates long error text to 120 chars', () => {
    const longText = 'a'.repeat(200)
    const result = summarizeFromDbRow(true, [], longText)
    expect(result).toContain('[error:')
    expect(result.length).toBeLessThanOrEqual(135) // [error: + 120 + ... + ]
  })

  it('formats multi-tool turns', () => {
    expect(summarizeFromDbRow(false, ['Read', 'Grep'], null)).toBe('[Read, Grep]')
  })

  it('formats single-tool turns', () => {
    expect(summarizeFromDbRow(false, ['Bash'], null)).toBe('[Bash]')
  })

  it('uses text preview when no tools', () => {
    expect(summarizeFromDbRow(false, [], 'hello world')).toBe('hello world')
  })

  it('returns empty string when nothing available', () => {
    expect(summarizeFromDbRow(false, [], null)).toBe('')
  })
})

describe('summarizeMessage', () => {
  it('summarizes text-only turns', () => {
    const msg = makeMessage({ id: '1', contentBlocks: [{ type: 'text', text: 'fix the authentication bug' }] })
    expect(summarizeMessage(msg)).toBe('fix the authentication bug')
  })

  it('summarizes error turns', () => {
    const msg = makeMessage({
      id: '1', isError: true,
      contentBlocks: [{ type: 'tool_result', content: 'command not found: npm' }],
    })
    expect(summarizeMessage(msg)).toContain('[error:')
  })

  it('summarizes multi-tool turns', () => {
    const msg = makeMessage({
      id: '1', toolNames: ['Read', 'Grep'],
      contentBlocks: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep' }],
    })
    expect(summarizeMessage(msg)).toBe('[Read, Grep]')
  })

  it('summarizes single tool with params', () => {
    const msg = makeMessage({
      id: '1', toolNames: ['Bash'],
      contentBlocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
    })
    expect(summarizeMessage(msg)).toBe('[Bash: npm test]')
  })

  it('truncates long text to 120 chars', () => {
    const longText = 'a'.repeat(200)
    const msg = makeMessage({ id: '1', contentBlocks: [{ type: 'text', text: longText }] })
    const summary = summarizeMessage(msg)
    expect(summary.length).toBeLessThanOrEqual(123) // 120 + '...'
  })

  it('summarizes single tool with file_path param', () => {
    const msg = makeMessage({
      id: '1', toolNames: ['Read'],
      contentBlocks: [{ type: 'tool_use', name: 'Read', input: { file_path: '/home/user/project/src/main.ts' } }],
    })
    expect(summarizeMessage(msg)).toBe('[Read: main.ts]')
  })
})

describe('queryCrossSession source filter', () => {
  let tempDir: string
  let db: Database.Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'query-turns-source-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')

    const indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()

    const insertSession = db.prepare(
      `INSERT INTO sessions (id, source, project_slug, started_at) VALUES (?, ?, ?, ?)`
    )
    insertSession.run('s-claude', 'claude-code', 'proj-a', '2026-01-01T00:00:00Z')
    insertSession.run('s-codex', 'codex', 'proj-a', '2026-01-02T00:00:00Z')
    insertSession.run('s-pi', 'pi-code', 'proj-a', '2026-01-03T00:00:00Z')

    const insertTurn = db.prepare(`
      INSERT INTO turn_events (session_id, turn_index, turn_id, role, timestamp, tool_names, is_error, is_correction, text_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insertTurn.run('s-claude', 0, 'turn-claude-0', 'user', '2026-01-01T00:01:00Z', '[]', 0, 0, 'hello from claude')
    insertTurn.run('s-codex', 0, 'turn-codex-0', 'user', '2026-01-02T00:01:00Z', '[]', 0, 0, 'hello from codex')
    insertTurn.run('s-pi', 0, 'turn-pi-0', 'user', '2026-01-03T00:01:00Z', '[]', 0, 0, 'hello from pi')
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('returns turns from every source when no source filter is set', () => {
    const { results, total } = queryCrossSession('proj-a', db, {}, 50, 0)
    expect(total).toBe(3)
    expect(results.map(r => r.sessionId).sort()).toEqual(['s-claude', 's-codex', 's-pi'])
  })

  it('filters to a single source string', () => {
    const { results, total } = queryCrossSession('proj-a', db, { source: 'codex' }, 50, 0)
    expect(total).toBe(1)
    expect(results).toHaveLength(1)
    expect(results[0]!.sessionId).toBe('s-codex')
  })

  it('filters to an array of sources (OR-matched)', () => {
    const { results, total } = queryCrossSession('proj-a', db, { source: ['claude-code', 'pi-code'] }, 50, 0)
    expect(total).toBe(2)
    expect(results.map(r => r.sessionId).sort()).toEqual(['s-claude', 's-pi'])
  })

  it('is not a no-op — an unmatched source excludes everything', () => {
    const { results, total } = queryCrossSession('proj-a', db, { source: 'opencode' }, 50, 0)
    expect(total).toBe(0)
    expect(results).toHaveLength(0)
  })
})
