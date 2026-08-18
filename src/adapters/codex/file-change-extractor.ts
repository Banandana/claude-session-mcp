import { basename } from 'node:path'
import type { FileChange } from '../../types'
import { streamJsonlLines } from '../../infrastructure/file-system'
import { extractSessionIdFromFilename } from './rollout-header'

interface CodexChangeEntry {
  readonly type?: string
}

interface CodexPatchApplyEndPayload {
  readonly type?: string
  readonly call_id?: string
  readonly success?: unknown
  readonly changes?: unknown
}

/**
 * Maps `event_msg/patch_apply_end` -> FileChange[]. Codex's `changes` object
 * uses `type: "add"|"update"|"delete"` per path, which maps onto
 * FileChange.operation as create/edit/delete. Codex is currently the only
 * source that records removals explicitly; the others simply never emit
 * 'delete'.
 */
export class CodexFileChangeExtractor {
  async *extractChanges(sessionPath: string): AsyncIterable<FileChange> {
    const sessionId = extractSessionIdFromFilename(basename(sessionPath)) ?? basename(sessionPath, '.jsonl')

    for await (const { line } of streamJsonlLines(sessionPath)) {
      let parsed: { type?: string; timestamp?: string; payload?: unknown }
      try {
        parsed = JSON.parse(line) as { type?: string; timestamp?: string; payload?: unknown }
      } catch {
        continue
      }

      if (parsed.type !== 'event_msg') continue
      const payload = parsed.payload as CodexPatchApplyEndPayload | undefined
      if (payload?.type !== 'patch_apply_end') continue
      if (payload.success === false) continue // failed patch — nothing was actually applied

      const changes = payload.changes
      if (!changes || typeof changes !== 'object') continue

      const messageId = payload.call_id
      const timestamp = parsed.timestamp ?? new Date().toISOString()

      for (const [filePath, raw] of Object.entries(changes as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue
        const entry = raw as CodexChangeEntry
        const operation = entry.type === 'add'
          ? 'create' as const
          : entry.type === 'update'
            ? 'edit' as const
            : entry.type === 'delete'
              ? 'delete' as const
              : undefined
        if (!operation) continue

        yield {
          sessionId,
          messageId,
          filePath,
          operation,
          timestamp,
        }
      }
    }
  }
}
