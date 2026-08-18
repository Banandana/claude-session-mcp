/**
 * Source-agnostic session ID guard.
 *
 * Claude Code session IDs are UUIDs, but Codex and opencode sessions use
 * their own id shapes — e.g. opencode's `ses_fee30a92dffedVqMG6MZQ5oeM1`
 * (27 chars, mixed case, underscore) — that never match a UUID pattern.
 * This guard only rejects obvious junk instead of enforcing one source's
 * format on every source: non-empty, bounded length, and a safe character
 * set. It is not an authorization check — every call site still binds the
 * id as a parameterized query argument.
 */
export function isValidSessionId(id: string): boolean {
  if (!id) return false
  if (id.length > 128) return false
  return /^[A-Za-z0-9_.:-]+$/.test(id)
}
