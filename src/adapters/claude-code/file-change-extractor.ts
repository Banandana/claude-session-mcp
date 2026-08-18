import { basename, isAbsolute, join } from 'node:path'
import type { FileChange } from '../../types'
import { streamJsonlLines } from '../../infrastructure/file-system'

interface TrackedFileBackup {
  readonly version?: number | undefined
  readonly backupFileName?: string | null | undefined
}

interface FileHistorySnapshot {
  readonly type: 'file-history-snapshot'
  readonly messageId: string
  readonly snapshot: {
    readonly messageId: string
    readonly trackedFileBackups: Record<string, TrackedFileBackup>
    readonly timestamp: string
  }
  readonly isSnapshotUpdate?: boolean | undefined
}

function isFileHistorySnapshot(parsed: Record<string, unknown>): parsed is Record<string, unknown> & FileHistorySnapshot {
  return parsed['type'] === 'file-history-snapshot' && parsed['snapshot'] != null
}

/**
 * Extracts file operations from Claude Code's `file-history-snapshot` lines.
 *
 * Each snapshot carries the FULL tracked-file set as of that message, with a
 * monotonically-increasing `version` per file — not a delta. So the change
 * signal is the version moving, not the presence of an entry: a file that
 * appears in 400 consecutive snapshots at version 3 was edited once, not 400
 * times.
 *
 * This previously keyed off `isSnapshotUpdate === true` and skipped anything
 * else. Current Claude Code writes that flag as `false` on every snapshot —
 * measured across a real 10k-line session: 413 snapshot lines, 413 with the
 * flag present, ZERO set to true, while `trackedFileBackups` grew from 30 to
 * 302 files. The extractor therefore yielded nothing at all, and `get_changes`
 * plus `sessions.files_changed` were silently empty for claude-code sessions.
 * Tracking versions instead recovers 499 real operations from that session.
 *
 * Paths in the snapshot are relative to the session's `cwd`; they are resolved
 * to absolute here so a `get_changes(filePath: ...)` lookup matches across
 * sources — Codex and opencode both record absolute paths.
 */
const MAX_CWD_PROBE_LINES = 200

/**
 * Bounded pre-scan for the session `cwd`. Snapshots can appear before the
 * first message line that carries one — measured on a real session, 9 of 499
 * operations came from snapshots written before any `cwd` was seen, and would
 * otherwise stay relative while the other 490 were absolute. A few KB read
 * twice is worth not emitting two path shapes from one session.
 */
async function probeCwd(sessionPath: string): Promise<string | undefined> {
  let lines = 0
  try {
    for await (const { line } of streamJsonlLines(sessionPath)) {
      if (lines++ >= MAX_CWD_PROBE_LINES) break
      try {
        const obj = JSON.parse(line) as { cwd?: unknown }
        if (typeof obj.cwd === 'string' && obj.cwd.startsWith('/')) return obj.cwd
      } catch {
        continue
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

export class FileChangeExtractor {
  async *extractChanges(sessionPath: string): AsyncIterable<FileChange> {
    const sessionId = basename(sessionPath, '.jsonl')

    /** Last version emitted per file, so repeated snapshots don't re-emit. */
    const lastVersion = new Map<string, number>()
    /**
     * Session cwd. Probed up front so snapshots that precede the first
     * cwd-carrying line still resolve; still updated opportunistically below
     * for sessions whose cwd appears later than the probe window.
     */
    let cwd: string | undefined = await probeCwd(sessionPath)

    for await (const { line } of streamJsonlLines(sessionPath)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      // Any line may carry the cwd; remember the first one seen so relative
      // snapshot paths can be resolved.
      if (cwd === undefined && typeof parsed['cwd'] === 'string' && parsed['cwd'].startsWith('/')) {
        cwd = parsed['cwd']
      }

      if (!isFileHistorySnapshot(parsed)) continue

      const snapshot = parsed as unknown as FileHistorySnapshot
      const backups = snapshot.snapshot.trackedFileBackups
      if (!backups || typeof backups !== 'object') continue

      for (const [rawPath, backup] of Object.entries(backups)) {
        const version = typeof backup.version === 'number' ? backup.version : undefined
        const previous = lastVersion.get(rawPath)

        if (previous !== undefined) {
          // Seen before: only a version bump counts as a new operation.
          if (version === undefined || version <= previous) continue
          lastVersion.set(rawPath, version)
        } else {
          lastVersion.set(rawPath, version ?? 0)
        }

        // A null backupFileName means there was no prior content to back up,
        // i.e. the file was created in this session.
        const operation = previous === undefined && backup.backupFileName === null ? 'create' : 'edit'
        const filePath = !isAbsolute(rawPath) && cwd !== undefined ? join(cwd, rawPath) : rawPath

        yield {
          sessionId,
          messageId: snapshot.messageId,
          filePath,
          operation,
          timestamp: snapshot.snapshot.timestamp,
        }
      }
    }
  }
}
