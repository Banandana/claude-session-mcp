import type { SessionMetadataResult, ContextCollapse } from '../../types'
import type { OpencodeDatabase } from './database'
import type { OpencodePartRow, OpencodeSessionRow } from './schema'

interface CompactionPartData {
  readonly type: string
  readonly auto?: boolean
  readonly overflow?: boolean
  readonly tail_start_id?: string
}

interface MessageIdRow {
  readonly id: string
}

export class OpencodeMetadataParser {
  constructor(private readonly database: OpencodeDatabase) {}

  /**
   * opencode has no tags/PR-link/mode/worktree-branch concept in its
   * store, so most of SessionMetadataResult is intentionally empty here —
   * only `customTitle` (from `session.title`) and `collapses` (from
   * `compaction` parts) carry real data.
   */
  async extractMetadata(session: OpencodeSessionRow): Promise<SessionMetadataResult> {
    const collapses = await this.collectCollapses(session.id)
    return {
      customTitle: session.title.length > 0 ? session.title : undefined,
      aiTitle: undefined,
      tags: [],
      mode: undefined,
      prLinks: [],
      collapses,
      taskSummaries: [],
      worktreeBranch: undefined,
      worktreePath: undefined,
      speculationTimeSavedMs: 0,
      gitBranch: undefined,
    }
  }

  /**
   * `compaction` parts carry `tail_start_id` — "the surviving-prefix
   * anchor" — i.e. the id of the first message opencode kept. Everything
   * before it in time_created/id order was archived, so the archived
   * range's last member is whichever message immediately precedes
   * `tail_start_id` in that same order. There's no explicit archived-range
   * field in the schema, so this is a best-effort reconstruction, not a
   * stored fact.
   */
  private async collectCollapses(sessionId: string): Promise<readonly ContextCollapse[]> {
    const db = this.database.get()
    if (!db) return []

    const messageIds = (
      db
        .prepare('SELECT id FROM message WHERE session_id = ? ORDER BY time_created, id')
        .all(sessionId) as MessageIdRow[]
    ).map(row => row.id)

    const partRows = db
      .prepare(
        `SELECT part.id, part.message_id, part.session_id, part.time_created, part.time_updated, part.data
         FROM part JOIN message ON message.id = part.message_id
         WHERE part.session_id = ? ORDER BY message.time_created, part.id`,
      )
      .all(sessionId) as OpencodePartRow[]

    const collapses: ContextCollapse[] = []
    for (const row of partRows) {
      let data: CompactionPartData
      try {
        data = JSON.parse(row.data) as CompactionPartData
      } catch {
        continue
      }
      if (data.type !== 'compaction') continue

      const tailStartId = data.tail_start_id
      const tailIdx = tailStartId ? messageIds.indexOf(tailStartId) : -1
      const firstArchivedUuid = messageIds[0] ?? ''
      const lastArchivedUuid = tailIdx > 0 ? (messageIds[tailIdx - 1] ?? '') : (tailStartId ?? '')

      collapses.push({
        sessionId,
        collapseId: row.id,
        summary: `context compacted (auto=${data.auto === true}, overflow=${data.overflow === true})`,
        firstArchivedUuid,
        lastArchivedUuid,
      })
    }
    return collapses
  }
}
