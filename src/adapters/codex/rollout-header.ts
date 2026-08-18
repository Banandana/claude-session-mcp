import { basename, join } from 'node:path'
import { fileExists, listDirectories, listFiles, streamJsonlLines } from '../../infrastructure/file-system'

/**
 * Codex rollout filenames: `rollout-<ISO-ts-with-dashes>-<uuid>.jsonl`.
 * The timestamp portion also contains dashes, so the UUID must be matched
 * as the trailing fixed-shape segment (regex backtracking handles this).
 */
const ROLLOUT_FILENAME_RE =
  /^rollout-.+-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/

export function extractSessionIdFromFilename(filename: string): string | undefined {
  const match = ROLLOUT_FILENAME_RE.exec(filename)
  return match ? match[1] : undefined
}

/**
 * Codex project slug encoding: `codex--` prefix (distinguishes from claude's
 * single-leading-dash `-home-...` and pi's double-leading-dash-wrapped
 * `--home-...--`) + path separators collapsed to single dashes + trailing
 * `--`. Round-trips via `slugToPath` for paths whose segments contain no
 * hyphens — same documented lossy caveat as claude-code and pi-code's own
 * slug schemes (a hyphen in a real directory name is indistinguishable from
 * a path separator once encoded).
 */
export function pathToSlug(path: string): string {
  const trimmed = path.startsWith('/') ? path.slice(1) : path
  return 'codex--' + trimmed.replace(/\//g, '-') + '--'
}

export function slugToPath(slug: string): string {
  let s = slug
  if (s.startsWith('codex--')) s = s.slice('codex--'.length)
  if (s.endsWith('--')) s = s.slice(0, -2)
  if (s.length === 0) return '/'
  return '/' + s.replace(/-/g, '/')
}

export interface ThreadSpawnInfo {
  readonly parentThreadId: string
  readonly depth: number
  readonly agentPath?: string | undefined
  readonly agentNickname?: string | undefined
  readonly agentRole?: string | null | undefined
}

/** Fields read from line 1 (`session_meta`) of a rollout file. */
export interface RolloutHeader {
  readonly sessionId: string
  readonly cwd?: string | undefined
  readonly timestamp?: string | undefined
  readonly originator?: string | undefined
  readonly cliVersion?: string | undefined
  /** Present only when this rollout is a sub-agent thread spawned by a parent. */
  readonly threadSpawn?: ThreadSpawnInfo | undefined
}

interface CodexSessionMetaPayload {
  /**
   * On a TOP-LEVEL rollout, equals this thread's own id. On a CHILD
   * (sub-agent) rollout, this instead holds the PARENT's id — Codex's own
   * quirk, confirmed against real `~/.codex` data. Never use this field
   * alone to identify "this rollout's session id"; use `id` for that (see
   * `readRolloutHeader`).
   */
  readonly session_id?: string
  /** This rollout's OWN id — matches the filename UUID for both parent and child rollouts. */
  readonly id?: string
  readonly cwd?: string
  readonly timestamp?: string
  readonly originator?: string
  readonly cli_version?: string
  /** Plain string discriminator: `"user"` (top-level) or `"subagent"` (child). NOT an object. */
  readonly thread_source?: unknown
  /** The actual spawn record lives here on a child rollout: `{subagent:{thread_spawn:{...}}}`. `"cli"` on a top-level rollout. */
  readonly source?: unknown
}

interface CodexSessionMetaLine {
  readonly type?: string
  readonly timestamp?: string
  readonly payload?: CodexSessionMetaPayload
}

function extractSpawnObject(value: unknown): ThreadSpawnInfo | undefined {
  if (!value || typeof value !== 'object') return undefined
  const subagent = (value as Record<string, unknown>)['subagent']
  if (!subagent || typeof subagent !== 'object') return undefined
  const spawn = (subagent as Record<string, unknown>)['thread_spawn']
  if (!spawn || typeof spawn !== 'object') return undefined

  const s = spawn as Record<string, unknown>
  const parentThreadId = s['parent_thread_id']
  if (typeof parentThreadId !== 'string' || parentThreadId.length === 0) return undefined

  const depth = typeof s['depth'] === 'number' ? s['depth'] : 0
  const agentPath = typeof s['agent_path'] === 'string' ? s['agent_path'] : undefined
  const agentNickname = typeof s['agent_nickname'] === 'string' ? s['agent_nickname'] : undefined
  const rawRole = s['agent_role']
  // agent_role can be null on real data — never assume a string.
  const agentRole = typeof rawRole === 'string' ? rawRole : rawRole === null ? null : undefined

  return { parentThreadId, depth, agentPath, agentNickname, agentRole }
}

/**
 * A rollout is a child/sub-agent thread when `thread_source === "subagent"`
 * (the reliable discriminator — a plain string, NOT an object) OR when the
 * spawn object is found directly (defensive: `source` is the field that
 * actually carries `{subagent:{thread_spawn:{...}}}`; `thread_source` never
 * does on real data, but tolerate it there too in case of drift). If the
 * string says "subagent" but no spawn object is parseable, fall back to
 * `session_id` for the parent id — on a child rollout that field holds the
 * PARENT's id, which is exactly the value we'd otherwise be missing.
 */
function extractThreadSpawn(payload: CodexSessionMetaPayload): ThreadSpawnInfo | undefined {
  const fromSource = extractSpawnObject(payload.source)
  if (fromSource) return fromSource

  const fromThreadSource = extractSpawnObject(payload.thread_source)
  if (fromThreadSource) return fromThreadSource

  if (
    payload.thread_source === 'subagent' &&
    typeof payload.session_id === 'string' &&
    payload.session_id.length > 0
  ) {
    return { parentThreadId: payload.session_id, depth: 0, agentPath: undefined, agentNickname: undefined, agentRole: undefined }
  }

  return undefined
}

/**
 * Reads only the first line of a rollout file (the `session_meta` entry).
 * Returns undefined for malformed/unreadable files or files that don't
 * start with a `session_meta` line.
 */
export async function readRolloutHeader(path: string): Promise<RolloutHeader | undefined> {
  for await (const { line } of streamJsonlLines(path)) {
    let parsed: CodexSessionMetaLine
    try {
      parsed = JSON.parse(line) as CodexSessionMetaLine
    } catch {
      return undefined
    }
    if (parsed.type !== 'session_meta' || !parsed.payload) return undefined

    const payload = parsed.payload
    const filenameId = extractSessionIdFromFilename(basename(path))
    // `id` is this rollout's own id on BOTH parent and child rollouts.
    // `session_id` is only trustworthy as "own id" on a parent rollout — on
    // a child it holds the PARENT's id instead, so it's a fallback only.
    const sessionId =
      typeof payload.id === 'string' && payload.id.length > 0
        ? payload.id
        : typeof payload.session_id === 'string' && payload.session_id.length > 0
          ? payload.session_id
          : filenameId

    if (!sessionId) return undefined

    return {
      sessionId,
      cwd: payload.cwd,
      timestamp: payload.timestamp ?? parsed.timestamp,
      originator: payload.originator,
      cliVersion: payload.cli_version,
      threadSpawn: extractThreadSpawn(payload),
    }
  }
  return undefined
}

/**
 * Walks `<codexDir>/sessions/YYYY/MM/DD/rollout-*.jsonl` and yields every
 * rollout file path found (parent and child/subagent threads alike —
 * callers filter as needed).
 */
export async function* listAllRollouts(
  sessionsDir: string,
): AsyncIterable<{ readonly path: string; readonly filename: string }> {
  if (!(await fileExists(sessionsDir))) return

  const years = await listDirectories(sessionsDir)
  for (const year of [...years].sort()) {
    const yearDir = join(sessionsDir, year)
    const months = await listDirectories(yearDir)
    for (const month of [...months].sort()) {
      const monthDir = join(yearDir, month)
      const days = await listDirectories(monthDir)
      for (const day of [...days].sort()) {
        const dayDir = join(monthDir, day)
        const files = await listFiles(dayDir, '.jsonl')
        for (const file of [...files].sort()) {
          if (!file.startsWith('rollout-')) continue
          yield { path: join(dayDir, file), filename: file }
        }
      }
    }
  }
}
