import { basename } from 'node:path'
import type { ContextCollapse } from '../../types'
import type { SessionMetadataResult } from '../../types/adapter'
import { streamJsonlLines } from '../../infrastructure/file-system'
import { extractSessionIdFromFilename } from './rollout-header'
import { firstTextFromContent } from './content-utils'

interface CodexTopLine {
  readonly type?: string
  readonly payload?: unknown
}

interface CodexResponseItemPayload {
  readonly type?: string
  readonly id?: string
  readonly role?: string
  readonly content?: unknown
}

interface CodexEventMsgPayload {
  readonly type?: string
  readonly last_agent_message?: string
}

interface CodexCompactedPayload {
  readonly message?: string
  readonly replacement_history?: unknown
}

interface CodexSessionMetaPayload {
  // `id` is this rollout's own id on both parent and child rollouts;
  // `session_id` holds the PARENT's id on a child rollout, so it is never
  // used to identify "this session" here (see rollout-header.ts).
  readonly id?: string
}

/**
 * Extracts session-level metadata from Codex rollout lines the conversation
 * parser skips: session titles (synthesized from the first user turn, Codex
 * has no native title concept), task summaries (task_complete's
 * last_agent_message), and context collapses (compacted lines).
 *
 * Codex has no tags/mode/PR-link/worktree/speculation concepts, so those
 * fields are always empty/undefined — not invented.
 */
export class CodexMetadataParser {
  async extractMetadata(sessionPath: string): Promise<SessionMetadataResult> {
    let sessionId = extractSessionIdFromFilename(basename(sessionPath)) ?? basename(sessionPath, '.jsonl')

    let aiTitle: string | undefined
    const collapses: ContextCollapse[] = []
    const taskSummaries: string[] = []
    let firstResponseItemId: string | undefined
    let lastResponseItemId: string | undefined
    let collapseCounter = 0

    for await (const { line } of streamJsonlLines(sessionPath)) {
      let parsed: CodexTopLine
      try {
        parsed = JSON.parse(line) as CodexTopLine
      } catch {
        continue
      }

      if (parsed.type === 'session_meta') {
        const sid = (parsed.payload as CodexSessionMetaPayload | undefined)?.id
        if (typeof sid === 'string' && sid.length > 0) sessionId = sid
        continue
      }

      if (parsed.type === 'response_item') {
        const p = parsed.payload as CodexResponseItemPayload | undefined
        if (typeof p?.id === 'string') {
          if (!firstResponseItemId) firstResponseItemId = p.id
          lastResponseItemId = p.id
        }
        if (p?.type === 'message' && p.role === 'user' && !aiTitle) {
          const text = firstTextFromContent(p.content)
          if (text) aiTitle = text.length > 100 ? text.slice(0, 97) + '...' : text
        }
        continue
      }

      if (parsed.type === 'event_msg') {
        const p = parsed.payload as CodexEventMsgPayload | undefined
        if (p?.type === 'task_complete' && typeof p.last_agent_message === 'string' && p.last_agent_message.length > 0) {
          taskSummaries.push(p.last_agent_message)
        }
        continue
      }

      if (parsed.type === 'compacted') {
        const p = parsed.payload as CodexCompactedPayload | undefined
        const keptCount = Array.isArray(p?.replacement_history) ? p.replacement_history.length : 0
        const summary =
          typeof p?.message === 'string' && p.message.length > 0
            ? p.message
            : `Context compacted (kept ${keptCount} entries)`

        collapseCounter += 1
        collapses.push({
          sessionId,
          collapseId: `codex-compact-${sessionId}-${collapseCounter}`,
          summary,
          // Codex replaces history wholesale rather than archiving an
          // explicit uuid range like claude-code's marble-origami-commit —
          // approximated here as "everything up to the last response_item
          // seen before this compaction point".
          firstArchivedUuid: firstResponseItemId ?? 'unknown',
          lastArchivedUuid: lastResponseItemId ?? 'unknown',
        })
        continue
      }
    }

    return {
      customTitle: undefined,
      aiTitle,
      tags: [],
      mode: undefined,
      prLinks: [],
      collapses,
      taskSummaries,
      worktreeBranch: undefined,
      worktreePath: undefined,
      speculationTimeSavedMs: 0,
      gitBranch: undefined,
    }
  }
}
