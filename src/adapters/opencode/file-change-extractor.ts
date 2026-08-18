import type { FileChange } from '../../types'
import type { OpencodeDatabase } from './database'
import type { OpencodePartRow } from './schema'
import { toIsoString } from './schema'

interface PatchPartData {
  readonly type: string
  readonly files?: readonly string[]
}

/**
 * opencode's `patch` part records only the set of touched file paths, with
 * no per-file operation kind (unlike Claude's write/edit/create split).
 * Every entry is recorded as `edit` — a deliberate, documented
 * approximation rather than a guessed fact, since nothing in the schema
 * distinguishes create-vs-edit without diffing the working tree ourselves.
 */
export class OpencodeFileChangeExtractor {
  constructor(private readonly database: OpencodeDatabase) {}

  async *extractChanges(sessionId: string): AsyncIterable<FileChange> {
    const db = this.database.get()
    if (!db) return

    const rows = db
      .prepare(
        `SELECT part.id, part.message_id, part.session_id, part.time_created, part.time_updated, part.data
         FROM part
         JOIN message ON message.id = part.message_id
         WHERE part.session_id = ?
         ORDER BY message.time_created, part.id`,
      )
      .all(sessionId) as OpencodePartRow[]

    for (const row of rows) {
      let data: PatchPartData
      try {
        data = JSON.parse(row.data) as PatchPartData
      } catch {
        continue
      }
      if (data.type !== 'patch' || !Array.isArray(data.files)) continue

      const timestamp = toIsoString(row.time_created)
      for (const filePath of data.files) {
        if (typeof filePath !== 'string' || filePath.length === 0) continue
        yield {
          sessionId,
          messageId: row.message_id,
          filePath,
          operation: 'edit',
          timestamp,
        }
      }
    }
  }
}
