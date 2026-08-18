import { describe, it, expect } from 'vitest'
import { isValidSessionId } from './session-id'

describe('isValidSessionId', () => {
  it('accepts a Claude Code UUID', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
  })

  it('accepts an opencode session id (regression: old UUID-only regex rejected these)', () => {
    // 27 chars, mixed case, underscore — the old /^[a-f0-9-]{32,40}$/i pattern
    // rejects this outright.
    expect(isValidSessionId('ses_fee30a92dffedVqMG6MZQ5oeM1')).toBe(true)
  })

  it('accepts a Codex rollout-style id', () => {
    expect(isValidSessionId('rollout-2026-08-18T10-00-00-9c1b2e3a-1234-4abc-8def-000000000000')).toBe(true)
  })

  it('rejects the empty string', () => {
    expect(isValidSessionId('')).toBe(false)
  })

  it('rejects ids longer than 128 characters', () => {
    expect(isValidSessionId('a'.repeat(129))).toBe(false)
  })

  it('accepts ids up to 128 characters', () => {
    expect(isValidSessionId('a'.repeat(128))).toBe(true)
  })

  it('rejects ids with unsafe characters', () => {
    expect(isValidSessionId('../../etc/passwd')).toBe(false)
    expect(isValidSessionId('session id with spaces')).toBe(false)
    expect(isValidSessionId("'; DROP TABLE sessions; --")).toBe(false)
    expect(isValidSessionId('session/with/slashes')).toBe(false)
  })
})
