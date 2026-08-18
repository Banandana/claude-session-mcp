import type { SubagentMeta } from '../../types'
import type { OpencodeDatabase } from './database'
import type { OpencodeSessionRow } from './schema'
import { parseSessionModel } from './schema'

interface TaskToolPartData {
  readonly type: string
  readonly tool?: string
  readonly state?: {
    readonly title?: string
    readonly metadata?: { readonly sessionId?: string }
    readonly input?: { readonly description?: string; readonly subagent_type?: string }
  }
}

/**
 * Sub-agent sessions are ordinary `session` rows with `parent_id` set. This
 * enriches each child with the parent's `task` tool part that spawned it
 * (matched via `state.metadata.sessionId`) for a human-readable
 * description/agent type, when one exists.
 */
export class OpencodeSubagentParser {
  constructor(private readonly database: OpencodeDatabase) {}

  async *getSubagents(parentId: string): AsyncIterable<SubagentMeta> {
    const db = this.database.get()
    if (!db) return

    const children = db
      .prepare('SELECT * FROM session WHERE parent_id = ? ORDER BY time_created')
      .all(parentId) as OpencodeSessionRow[]
    if (children.length === 0) return

    const taskByChildId = this.collectTaskParts(db, parentId)

    for (const child of children) {
      const task = taskByChildId.get(child.id)
      const totalTools = this.countToolParts(db, child.id)
      const totalTokens = child.tokens_input + child.tokens_output + child.tokens_reasoning
      const description = task?.state?.title ?? task?.state?.input?.description ?? (child.title.length > 0 ? child.title : undefined)

      yield {
        id: child.id,
        sessionId: parentId,
        agentType: child.agent ?? task?.state?.input?.subagent_type,
        description,
        totalTokens: totalTokens > 0 ? totalTokens : undefined,
        totalTools: totalTools > 0 ? totalTools : undefined,
        durationMs: child.time_updated - child.time_created,
        model: parseSessionModel(child.model),
      }
    }
  }

  private collectTaskParts(db: NonNullable<ReturnType<OpencodeDatabase['get']>>, parentId: string): Map<string, TaskToolPartData> {
    const map = new Map<string, TaskToolPartData>()
    const rows = db.prepare('SELECT data FROM part WHERE session_id = ?').all(parentId) as Array<{ data: string }>
    for (const row of rows) {
      let data: TaskToolPartData
      try {
        data = JSON.parse(row.data) as TaskToolPartData
      } catch {
        continue
      }
      if (data.type !== 'tool' || data.tool !== 'task') continue
      const childId = data.state?.metadata?.sessionId
      if (childId) map.set(childId, data)
    }
    return map
  }

  private countToolParts(db: NonNullable<ReturnType<OpencodeDatabase['get']>>, sessionId: string): number {
    const rows = db.prepare('SELECT data FROM part WHERE session_id = ?').all(sessionId) as Array<{ data: string }>
    let count = 0
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data) as { type?: string }
        if (parsed.type === 'tool') count++
      } catch {
        // skip malformed rows
      }
    }
    return count
  }
}
