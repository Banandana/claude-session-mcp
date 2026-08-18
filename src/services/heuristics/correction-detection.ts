import type { ContentBlock } from '../../types'

const NEGATION_STARTS = /^(no[,.\s!]|stop[,.\s!]|don'?t\s|not that|wrong|nope|that'?s not|i said|i told you|should have|you should have)/
const CORRECTION_KEYWORDS = /\b(wrong|don'?t|not that|i said|i told you|should have|you should have|instead of|actually no|stop being|stop doing|stop adding)\b/
const ALL_CAPS_RE = /[A-Z]{4,}/

/**
 * Heuristic: is this user text message a correction of the preceding
 * assistant turn? Looks only at the first content block (a user turn's
 * leading block is assumed to carry the reply text).
 *
 * Ported verbatim from the near-duplicate copies previously kept in each
 * source adapter's conversation parser (claude-code and pi-code) — same
 * regexes, same precedence, same behaviour. Shared here so a third/fourth
 * source (Codex, opencode) gets the identical rule for free instead of a
 * fifth hand-copy that quietly drifts.
 */
export function detectCorrection(contentBlocks: readonly ContentBlock[]): boolean {
  const firstBlock = contentBlocks[0]
  if (firstBlock?.type !== 'text' || !firstBlock.text) return false

  const text = firstBlock.text.trim().toLowerCase()
  if (text.length === 0) return false

  // Pattern 1: Starts with negation/redirection
  if (NEGATION_STARTS.test(text)) return true

  // Pattern 2: Correction keywords anywhere in message
  if (CORRECTION_KEYWORDS.test(text)) return true

  // Pattern 3: ALL CAPS messages with 4+ consecutive caps (anger/emphasis)
  const original = firstBlock.text.trim()
  if (original === original.toUpperCase() && ALL_CAPS_RE.test(original)) {
    return true
  }

  return false
}
