import { describe, it, expect } from 'vitest'
import { isToolResultError, isSuspectedError } from './error-detection'

describe('isToolResultError (authoritative — finding B1 regression)', () => {
  it('a SUCCESSFUL tool result whose text contains the word "error" yields false', () => {
    expect(
      isToolResultError({
        text: 'Ran the linter: 0 errors found, build succeeded.',
      }),
    ).toBe(false)
  })

  it('an explicit is_error:true yields true regardless of text', () => {
    expect(
      isToolResultError({
        explicitError: true,
        text: 'Everything looks fine',
      }),
    ).toBe(true)
  })

  it('a successful command with non-empty stderr yields false', () => {
    expect(
      isToolResultError({
        stderr: 'warning: deprecated flag used',
      }),
    ).toBe(false)
  })

  it('an explicit false flag yields false even with alarming text/stderr', () => {
    expect(
      isToolResultError({
        explicitError: false,
        text: 'FATAL ERROR: catastrophic failure',
        stderr: 'error: something broke',
      }),
    ).toBe(false)
  })

  it('no signal at all yields false', () => {
    expect(isToolResultError({})).toBe(false)
  })
})

describe('isSuspectedError (non-authoritative text heuristic)', () => {
  it('flags text containing the word "error" as a whole word', () => {
    expect(isSuspectedError('Error: file not found')).toBe(true)
    expect(isSuspectedError('an error occurred')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isSuspectedError('ERROR: something broke')).toBe(true)
  })

  it('does not flag "error" as a mere prefix of a longer word', () => {
    // \berror\b requires a word boundary on both sides — "errorless" has
    // "error" immediately followed by "less" with no boundary between them.
    expect(isSuspectedError('the new UI is errorless and fast')).toBe(false)
  })

  it('returns false for empty/undefined/null text', () => {
    expect(isSuspectedError('')).toBe(false)
    expect(isSuspectedError(undefined)).toBe(false)
    expect(isSuspectedError(null)).toBe(false)
  })

  it('is explicitly NOT wired into isToolResultError', () => {
    const suspiciousText = 'error: this looks bad but the command actually succeeded'
    expect(isSuspectedError(suspiciousText)).toBe(true)
    expect(isToolResultError({ text: suspiciousText })).toBe(false)
  })
})
