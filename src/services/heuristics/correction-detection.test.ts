import { describe, it, expect } from 'vitest'
import { detectCorrection } from './correction-detection'
import type { ContentBlock } from '../../types'

function textBlocks(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

describe('detectCorrection', () => {
  it('detects negation-start corrections', () => {
    expect(detectCorrection(textBlocks("no, not that — I said use the database module"))).toBe(true)
    expect(detectCorrection(textBlocks("stop, don't do that"))).toBe(true)
  })

  it('detects correction keywords anywhere in the message', () => {
    expect(detectCorrection(textBlocks('please use the database module instead of the auth one'))).toBe(true)
  })

  it('detects ALL CAPS messages as corrections', () => {
    expect(detectCorrection(textBlocks('WHAT THE HELL ARE YOU DOING'))).toBe(true)
  })

  it('does not flag ordinary requests', () => {
    expect(detectCorrection(textBlocks('Refactor the auth service'))).toBe(false)
  })

  it('does not flag short ALL CAPS acronyms (fewer than 4 consecutive caps)', () => {
    expect(detectCorrection(textBlocks('Use the API for this'))).toBe(false)
  })

  it('returns false for empty content blocks', () => {
    expect(detectCorrection([])).toBe(false)
  })

  it('returns false when the first block is not text', () => {
    expect(detectCorrection([{ type: 'tool_use', name: 'Bash' }])).toBe(false)
  })

  it('returns false for whitespace-only text', () => {
    expect(detectCorrection(textBlocks('   '))).toBe(false)
  })
})
