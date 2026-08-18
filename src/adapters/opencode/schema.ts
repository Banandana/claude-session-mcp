/**
 * Row shapes for the opencode SQLite tables this adapter reads, plus a
 * handful of pure helpers shared across the adapter's modules. Verified
 * against opencode 1.18.16 (see docs/multi-source-plan.md). Only the
 * columns this adapter actually uses are declared — the real tables carry
 * more (e.g. `session.share_url`, `project.icon_color`).
 */

export interface OpencodeProjectRow {
  readonly id: string
  readonly worktree: string
  readonly vcs: string | null
  readonly name: string | null
  readonly time_created: number
  readonly time_updated: number
}

export interface OpencodeSessionRow {
  readonly id: string
  readonly project_id: string
  readonly parent_id: string | null
  readonly slug: string
  readonly directory: string
  readonly title: string
  readonly version: string
  readonly cost: number
  readonly tokens_input: number
  readonly tokens_output: number
  readonly tokens_reasoning: number
  readonly tokens_cache_read: number
  readonly tokens_cache_write: number
  readonly agent: string | null
  readonly model: string | null
  readonly time_created: number
  readonly time_updated: number
}

export interface OpencodeMessageRow {
  readonly id: string
  readonly session_id: string
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

export interface OpencodePartRow {
  readonly id: string
  readonly message_id: string
  readonly session_id: string
  readonly time_created: number
  readonly time_updated: number
  readonly data: string
}

/**
 * `project.id='global'` / `worktree='/'` is opencode's catch-all scratch
 * project (used for sessions started outside any real worktree), not a
 * project a human would recognize. Callers skip it in listings but still
 * resolve sessions that reference it.
 */
export function isGlobalProject(row: Pick<OpencodeProjectRow, 'id' | 'worktree'>): boolean {
  return row.id === 'global' || row.worktree === '/'
}

/**
 * Namespaces an opencode project id so it can never collide with
 * claude-code's `-home-kitty-foo` or pi's `--home-kitty-foo--` slug shapes
 * (neither of which can start with `oc-`).
 */
export function toProjectSlug(projectId: string): string {
  return `oc-${projectId}`
}

/** Inverse of `toProjectSlug` — tolerates an un-prefixed id defensively. */
export function fromProjectSlug(slug: string): string {
  return slug.startsWith('oc-') ? slug.slice(3) : slug
}

/** `providerID` + `modelID` -> a human-readable "provider/model" string. */
export function friendlyModel(providerId: string | undefined, modelId: string | undefined): string | undefined {
  if (!modelId) return undefined
  return providerId ? `${providerId}/${modelId}` : modelId
}

interface OpencodeModelField {
  readonly id?: string
  readonly providerID?: string
  readonly variant?: string
}

/** Parses `session.model`, a JSON string `{"id","providerID","variant"}`. */
export function parseSessionModel(raw: string | null): string | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as OpencodeModelField
    return friendlyModel(parsed.providerID, parsed.id)
  } catch {
    return undefined
  }
}

export function toIsoString(epochMs: number): string {
  return new Date(epochMs).toISOString()
}
