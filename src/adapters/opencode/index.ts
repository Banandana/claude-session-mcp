import type {
  SessionAdapter,
  SessionMetadataResult,
  IndexState,
  FreshnessResult,
  ProjectMeta,
  SessionMeta,
  NormalizedMessage,
  FileChange,
  SubagentMeta,
  MemoryEntry,
} from '../../types'
import { OpencodeDatabase, defaultOpencodeDbPath } from './database'
import { OpencodeSessionDiscovery } from './session-discovery'
import { OpencodeConversationParser } from './conversation-parser'
import { OpencodeFileChangeExtractor } from './file-change-extractor'
import { OpencodeMetadataParser } from './metadata-parser'
import { OpencodeSubagentParser } from './subagent-parser'

export { OpencodeDatabase, defaultOpencodeDbPath } from './database'
export { OpencodeSessionDiscovery } from './session-discovery'
export { OpencodeConversationParser } from './conversation-parser'
export { OpencodeFileChangeExtractor } from './file-change-extractor'
export { OpencodeMetadataParser } from './metadata-parser'
export { OpencodeSubagentParser } from './subagent-parser'
export * from './schema'

interface SessionWatermarkRow {
  readonly id: string
  readonly time_updated: number
}

/**
 * Adapter for opencode's session store at
 * `~/.local/share/opencode/opencode.db` — a single SQLite database owned
 * by the live `opencode` process, opened strictly read-only. Unlike
 * claude-code/pi-code (many JSONL files on disk) this source has no files
 * to walk: every method here is a query against `project` / `session` /
 * `message` / `part`.
 *
 * Sub-agent sessions are ordinary rows in `session` with `parent_id` set.
 * They're excluded from `discoverSessions`/`checkFreshness`'s top-level
 * session universe (mirrors claude-code/pi-code, where sub-agent content
 * likewise isn't independently synced), but remain directly addressable
 * by id through `getMessages`/`getFileChanges`/`getSessionCost`/
 * `getSessionWatermark`/`claimsSessionId`, since they live in the exact
 * same tables as a top-level session and cost nothing extra to support.
 */
export class OpencodeAdapter implements SessionAdapter {
  readonly source = 'opencode'
  readonly errorSignal = 'explicit' as const

  private readonly database: OpencodeDatabase
  private readonly discovery: OpencodeSessionDiscovery
  private readonly conversationParser: OpencodeConversationParser
  private readonly fileChangeExtractor: OpencodeFileChangeExtractor
  private readonly metadataParser: OpencodeMetadataParser
  private readonly subagentParser: OpencodeSubagentParser

  constructor(dbPath: string = defaultOpencodeDbPath()) {
    this.database = new OpencodeDatabase(dbPath)
    this.discovery = new OpencodeSessionDiscovery(this.database)
    this.conversationParser = new OpencodeConversationParser(this.database)
    this.fileChangeExtractor = new OpencodeFileChangeExtractor(this.database)
    this.metadataParser = new OpencodeMetadataParser(this.database)
    this.subagentParser = new OpencodeSubagentParser(this.database)
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    await this.discovery.buildProjectCache()
    yield* this.discovery.cachedProjects()
  }

  async *discoverSessions(project?: string): AsyncIterable<SessionMeta> {
    yield* this.discovery.discoverSessions(project)
  }

  async *getMessages(sessionId: string): AsyncIterable<NormalizedMessage> {
    const session = await this.discovery.findSessionRow(sessionId)
    if (!session) return
    yield* this.conversationParser.parseSession(sessionId, session.directory)
  }

  async *getFileChanges(sessionId: string): AsyncIterable<FileChange> {
    yield* this.fileChangeExtractor.extractChanges(sessionId)
  }

  async *getSubagents(sessionId: string): AsyncIterable<SubagentMeta> {
    yield* this.subagentParser.getSubagents(sessionId)
  }

  // opencode has no memory-file concept (no CLAUDE.md/MEMORY.md analogue
  // in its store); nothing to yield.
  // eslint-disable-next-line require-yield
  async *getMemory(_project?: string): AsyncIterable<MemoryEntry> {
    return
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadataResult | undefined> {
    const session = await this.discovery.findSessionRow(sessionId)
    if (!session) return undefined
    return this.metadataParser.extractMetadata(session)
  }

  async getSessionCost(_projectSlug: string, sessionId: string): Promise<number | undefined> {
    const session = await this.discovery.findSessionRow(sessionId)
    return session?.cost
  }

  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    return this.discovery.resolveProject(path)
  }

  /**
   * A single-query freshness check: opencode has no files to stat, so this
   * compares `session.time_updated` directly instead of the file-size
   * watermarks claude-code/pi-code use. Scoped to top-level sessions
   * (`parent_id IS NULL`) — the same universe `discoverSessions` exposes —
   * so a sub-agent's own watermark never causes a phantom top-level
   * session to appear in the index.
   */
  async checkFreshness(known: IndexState): Promise<FreshnessResult> {
    const db = this.database.get()
    if (!db) {
      // No database (opencode not installed, or not on this machine) —
      // claim no sessions, never report another adapter's sessions removed.
      return { isStale: false, newSessions: [], changedSessions: [], removedSessions: [] }
    }

    const knownMax = known.sessionWatermarks.size > 0 ? Math.max(...known.sessionWatermarks.values()) : -1

    // Cheap short-circuit: one aggregate query instead of materializing
    // every session row on every cycle. If the newest top-level session
    // hasn't moved past the highest watermark already recorded, nothing is
    // new or changed. This can miss a session *removed* without any other
    // session's watermark advancing in the same cycle (rare in practice —
    // opencode sessions aren't normally deleted); the next cycle where
    // anything else changes still catches up via the full diff below.
    const maxRow = db
      .prepare('SELECT MAX(time_updated) as maxUpdated FROM session WHERE parent_id IS NULL')
      .get() as { maxUpdated: number | null }
    if (maxRow.maxUpdated !== null && maxRow.maxUpdated <= knownMax) {
      return { isStale: false, newSessions: [], changedSessions: [], removedSessions: [] }
    }

    const rows = db
      .prepare('SELECT id, time_updated FROM session WHERE parent_id IS NULL')
      .all() as SessionWatermarkRow[]

    const newSessions: string[] = []
    const changedSessions: string[] = []
    const removedSessions: string[] = []
    const seenIds = new Set<string>()

    for (const row of rows) {
      seenIds.add(row.id)
      const knownWatermark = known.sessionWatermarks.get(row.id)
      if (knownWatermark === undefined) {
        newSessions.push(row.id)
      } else if (row.time_updated > knownWatermark) {
        changedSessions.push(row.id)
      }
    }

    // Registry pre-filters known.sessionWatermarks to ids this adapter
    // claims, so any known id we don't see in the table anymore really is gone.
    for (const knownId of known.sessionWatermarks.keys()) {
      if (!seenIds.has(knownId)) removedSessions.push(knownId)
    }

    return {
      isStale: newSessions.length > 0 || changedSessions.length > 0 || removedSessions.length > 0,
      newSessions,
      changedSessions,
      removedSessions,
    }
  }

  async claimsSessionId(sessionId: string): Promise<boolean> {
    return (await this.discovery.findSessionRow(sessionId)) !== undefined
  }

  async getSessionWatermark(sessionId: string): Promise<number | undefined> {
    const session = await this.discovery.findSessionRow(sessionId)
    return session?.time_updated
  }
}
