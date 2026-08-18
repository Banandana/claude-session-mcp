import type { ProjectMeta } from './project'
import type { SessionMeta, NormalizedMessage, FileChange, SubagentMeta, PrLink, ContextCollapse } from './session'
import type { MemoryEntry } from './project'

export interface IndexState {
  /**
   * sessionId -> the last-recorded watermark for that session. A watermark
   * is an opaque, monotonically-increasing integer: the adapter that owns
   * a session compares the current watermark to the stored one to decide
   * whether the session changed. Claude-code and pi-code use on-disk file
   * size; Codex will do the same; opencode (no files) will use
   * `session.time_updated` (epoch ms). Callers must not interpret the
   * value beyond "bigger means newer, and if it moved, re-sync."
   */
  readonly sessionWatermarks: ReadonlyMap<string, number>
  readonly lastSyncAt: string
}

export interface FreshnessResult {
  readonly isStale: boolean
  readonly newSessions: readonly string[]
  readonly changedSessions: readonly string[]
  readonly removedSessions: readonly string[]
}

export interface SessionMetadataResult {
  readonly customTitle?: string | undefined
  readonly aiTitle?: string | undefined
  readonly tags: readonly string[]
  readonly mode?: 'coordinator' | 'normal' | undefined
  readonly prLinks: readonly PrLink[]
  readonly collapses: readonly ContextCollapse[]
  readonly taskSummaries: readonly string[]
  readonly worktreeBranch?: string | undefined
  readonly worktreePath?: string | undefined
  readonly speculationTimeSavedMs: number
  readonly gitBranch?: string | undefined
}

/**
 * Whether a source's transcript format can tell us a tool call FAILED.
 *
 * - `'explicit'` — the format carries a real failure flag the adapter reads
 *   (claude's `tool_result.is_error`, pi's `toolResult.isError`, opencode's
 *   `state.status === 'error'`).
 * - `'none'` — the format carries no failure channel at all. Codex tool
 *   outputs have only `type/id/call_id/output`, and every `patch_apply_end`
 *   observed reports `success: true`; a failure is visible only as prose
 *   inside the output text, which is exactly the signal that inflated error
 *   counts 175% before finding B1.
 *
 * A source with `'none'` stores `error_count = NULL`, not 0. Zero would read
 * as "this agent never fails" in precisely the cross-source comparisons this
 * server exists to support; NULL reads as "not observable here", which is
 * the truth.
 */
export type ErrorSignalSupport = 'explicit' | 'none'

export interface SessionAdapter {
  readonly source: string
  /** See {@link ErrorSignalSupport}. Governs whether error_count is a count or NULL. */
  readonly errorSignal: ErrorSignalSupport
  discoverProjects(): AsyncIterable<ProjectMeta>
  discoverSessions(project?: string): AsyncIterable<SessionMeta>
  getMessages(sessionId: string): AsyncIterable<NormalizedMessage>
  getFileChanges(sessionId: string): AsyncIterable<FileChange>
  getSubagents(sessionId: string): AsyncIterable<SubagentMeta>
  getMemory(project?: string): AsyncIterable<MemoryEntry>
  getSessionMetadata(sessionId: string): Promise<SessionMetadataResult | undefined>
  getSessionCost(projectSlug: string, sessionId: string): Promise<number | undefined>
  resolveProject(path: string): Promise<ProjectMeta | undefined>
  checkFreshness(known: IndexState): Promise<FreshnessResult>
  /** Returns true if this adapter is the owner of `sessionId` (i.e. can locate its underlying log). */
  claimsSessionId(sessionId: string): Promise<boolean>
  /**
   * Returns the current watermark for `sessionId`, or undefined if not
   * found. An opaque, monotonically-increasing integer — the adapter
   * compares it to the stored value to decide whether the session
   * changed. Claude-code/pi-code/Codex use on-disk file size; opencode
   * (no files) uses `session.time_updated` (epoch ms). Callers must treat
   * this as a comparable-for-change-detection value only, never as bytes.
   */
  getSessionWatermark(sessionId: string): Promise<number | undefined>
}
