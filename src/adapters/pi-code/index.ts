import { join } from 'node:path'
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
import { fileExists, fileSize } from '../../infrastructure/file-system'
import { PiSessionDiscovery } from './session-discovery'
import { PiConversationParser } from './conversation-parser'
import { PiFileChangeExtractor } from './file-change-extractor'
import { PiMetadataParser } from './metadata-parser'
import { PiMemoryReader } from './memory-reader'
import { PiSubagentParser } from './subagent-parser'
import { ok, err, type Result } from 'neverthrow'
import { PiSessionNotFoundError, PiSessionReadError, type PiAdapterError } from './errors'

export { PiSessionDiscovery } from './session-discovery'
export { PiConversationParser } from './conversation-parser'
export { PiFileChangeExtractor } from './file-change-extractor'
export { PiMetadataParser } from './metadata-parser'
export { PiMemoryReader, PI_MEMORY_SLUG } from './memory-reader'
export { PiSubagentParser } from './subagent-parser'
export { PiSessionNotFoundError, PiSessionReadError, PiAdapterError } from './errors'

/**
 * Adapter for pi-coding-agent session logs at `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`.
 *
 * Session id = the v7 UUID portion of the JSONL filename.
 * Project slug = pi's encoded-cwd folder name (e.g. `--data-project--`).
 * Memory = global `~/.pi/agent/memory/` surfaced under synthetic slug `pi-global`.
 * Subagents = none (pi has no agent-X.jsonl files).
 */
export class PiCodeAdapter implements SessionAdapter {
  readonly source = 'pi-code'

  private readonly discovery: PiSessionDiscovery
  private readonly conversationParser: PiConversationParser
  private readonly fileChangeExtractor: PiFileChangeExtractor
  private readonly metadataParser: PiMetadataParser
  private readonly memoryReader: PiMemoryReader
  private readonly subagentParser: PiSubagentParser

  constructor(private readonly piDir: string) {
    this.discovery = new PiSessionDiscovery(piDir)
    this.conversationParser = new PiConversationParser()
    this.fileChangeExtractor = new PiFileChangeExtractor()
    this.metadataParser = new PiMetadataParser()
    this.memoryReader = new PiMemoryReader(piDir)
    this.subagentParser = new PiSubagentParser()
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    // buildProjectCache() already walks the full sessions dir to populate
    // the cache — yield from that cache instead of re-walking disk a
    // second time (finding B11, second half).
    await this.discovery.buildProjectCache()
    yield* this.discovery.cachedProjects()
  }

  async *discoverSessions(project?: string): AsyncIterable<SessionMeta> {
    yield* this.discovery.discoverSessions(project)
  }

  async *getMessages(sessionId: string): AsyncIterable<NormalizedMessage> {
    const found = await this.discovery.findSessionFile(sessionId)
    if (!found) return
    yield* this.conversationParser.parseSession(found.path)
  }

  async *getFileChanges(sessionId: string): AsyncIterable<FileChange> {
    const found = await this.discovery.findSessionFile(sessionId)
    if (!found) return
    yield* this.fileChangeExtractor.extractChanges(found.path)
  }

  async *getSubagents(sessionId: string): AsyncIterable<SubagentMeta> {
    yield* this.subagentParser.getSubagents(sessionId)
  }

  async *getMemory(project?: string): AsyncIterable<MemoryEntry> {
    yield* this.memoryReader.readMemory(project)
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadataResult | undefined> {
    const result = await this.getSessionMetadataResult(sessionId)
    return result.isOk() ? result.value : undefined
  }

  /**
   * Result-typed variant of getSessionMetadata. New callers should prefer this
   * — the SessionAdapter interface forces an `undefined`-erasing return, which
   * loses the distinction between "session doesn't exist" and "session exists
   * but failed to parse". The Result form preserves both.
   */
  async getSessionMetadataResult(
    sessionId: string,
  ): Promise<Result<SessionMetadataResult, PiAdapterError>> {
    const found = await this.discovery.findSessionFile(sessionId)
    if (!found) return err(new PiSessionNotFoundError(sessionId))
    try {
      const meta = await this.metadataParser.extractMetadata(found.path)
      return ok(meta)
    } catch (cause) {
      return err(new PiSessionReadError(found.path, cause))
    }
  }

  async getSessionCost(_projectSlug: string, _sessionId: string): Promise<number | undefined> {
    // Pi stores cost inside each assistant message's usage.cost.total. The cost field
    // is zero on this rig (local provider emits no cost). Skip per-session aggregation.
    return undefined
  }

  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    return await this.discovery.resolveProject(path)
  }

  async checkFreshness(known: IndexState): Promise<FreshnessResult> {
    const newSessions: string[] = []
    const changedSessions: string[] = []
    const removedSessions: string[] = []
    const seenIds = new Set<string>()

    const sessionsDir = join(this.piDir, 'sessions')
    if (!(await fileExists(sessionsDir))) {
      // Pi never installed / no sessions yet — claim no sessions, don't reap claude's.
      return { isStale: false, newSessions: [], changedSessions: [], removedSessions: [] }
    }

    for await (const session of this.discovery.discoverSessions()) {
      seenIds.add(session.id)
      const found = await this.discovery.findSessionFile(session.id)
      if (!found) continue
      const currentWatermark = await fileSize(found.path)
      const knownWatermark = known.sessionWatermarks.get(session.id)
      if (knownWatermark === undefined) {
        newSessions.push(session.id)
      } else if (currentWatermark > knownWatermark) {
        changedSessions.push(session.id)
      }
    }

    // Registry pre-filters `known.sessionWatermarks` to ids this adapter
    // claims, so any known id we don't see on disk really is gone.
    for (const knownId of known.sessionWatermarks.keys()) {
      if (!seenIds.has(knownId)) {
        removedSessions.push(knownId)
      }
    }

    return {
      isStale: newSessions.length > 0 || changedSessions.length > 0 || removedSessions.length > 0,
      newSessions,
      changedSessions,
      removedSessions,
    }
  }

  async claimsSessionId(sessionId: string): Promise<boolean> {
    const found = await this.discovery.findSessionFile(sessionId)
    return found !== undefined
  }

  async getSessionWatermark(sessionId: string): Promise<number | undefined> {
    const found = await this.discovery.findSessionFile(sessionId)
    if (!found) return undefined
    return fileSize(found.path)
  }
}
