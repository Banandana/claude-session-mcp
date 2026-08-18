import { join } from 'node:path'
import { homedir } from 'node:os'
import { ok, err, type Result } from 'neverthrow'
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
import { CodexSessionDiscovery } from './session-discovery'
import { CodexConversationParser } from './conversation-parser'
import { CodexFileChangeExtractor } from './file-change-extractor'
import { CodexMetadataParser } from './metadata-parser'
import { CodexMemoryReader } from './memory-reader'
import { CodexSubagentParser } from './subagent-parser'
import { CodexSessionNotFoundError, CodexSessionReadError, type CodexAdapterError } from './errors'

export { CodexSessionDiscovery } from './session-discovery'
export { CodexConversationParser } from './conversation-parser'
export { CodexFileChangeExtractor } from './file-change-extractor'
export { CodexMetadataParser } from './metadata-parser'
export { CodexMemoryReader, CODEX_MEMORY_SLUG } from './memory-reader'
export { CodexSubagentParser } from './subagent-parser'
export { CodexSessionNotFoundError, CodexSessionReadError, CodexAdapterError } from './errors'
export { pathToSlug, slugToPath, extractSessionIdFromFilename } from './rollout-header'

/**
 * Adapter for Codex CLI session logs at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`.
 *
 * Session id = the UUID tail of the filename, cross-checked against
 * `session_meta.payload.id` on line 1 (the payload value wins when
 * present). NOTE: `payload.session_id` is NOT this rollout's own id on a
 * child/sub-agent rollout — Codex writes the PARENT's id there instead;
 * `payload.id` is the one that's always this rollout's own id.
 *
 * Project slug = a `codex--<path-with-dashes>--` encoding derived from each
 * session's `cwd` (Codex has no project directories of its own).
 *
 * Sub-agent threads are separate rollout files. The reliable discriminator
 * is `session_meta.payload.thread_source === "subagent"` (a plain string,
 * not an object); the spawn record itself (`parent_thread_id`, `depth`,
 * `agent_path`, `agent_nickname`) lives on `session_meta.payload.source`.
 * They're excluded from discoverSessions but still resolvable directly by
 * id (claimsSessionId/getMessages/etc.), and surfaced as SubagentMeta via
 * getSubagents(parentSessionId).
 *
 * Memory = global `AGENTS.md` + `~/.codex/rules/*.md`, surfaced under the
 * synthetic slug `codex-global`. No cost data exists in Codex rollouts.
 */
export class CodexAdapter implements SessionAdapter {
  readonly source = 'codex'

  private readonly discovery: CodexSessionDiscovery
  private readonly conversationParser: CodexConversationParser
  private readonly fileChangeExtractor: CodexFileChangeExtractor
  private readonly metadataParser: CodexMetadataParser
  private readonly memoryReader: CodexMemoryReader
  private readonly subagentParser: CodexSubagentParser

  constructor(private readonly codexDir: string = join(homedir(), '.codex')) {
    this.discovery = new CodexSessionDiscovery(codexDir)
    this.conversationParser = new CodexConversationParser()
    this.fileChangeExtractor = new CodexFileChangeExtractor()
    this.metadataParser = new CodexMetadataParser()
    this.memoryReader = new CodexMemoryReader(codexDir)
    this.subagentParser = new CodexSubagentParser(this.discovery)
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
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
   * Result-typed variant of getSessionMetadata — see pi-code's identical
   * method for rationale (preserves "not found" vs "found but failed to
   * parse" instead of collapsing both to undefined).
   */
  async getSessionMetadataResult(
    sessionId: string,
  ): Promise<Result<SessionMetadataResult, CodexAdapterError>> {
    const found = await this.discovery.findSessionFile(sessionId)
    if (!found) return err(new CodexSessionNotFoundError(sessionId))
    try {
      const meta = await this.metadataParser.extractMetadata(found.path)
      return ok(meta)
    } catch (cause) {
      return err(new CodexSessionReadError(found.path, cause))
    }
  }

  async getSessionCost(_projectSlug: string, _sessionId: string): Promise<number | undefined> {
    // Codex rollouts contain no cost data.
    return undefined
  }

  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    return this.discovery.resolveProject(path)
  }

  async checkFreshness(known: IndexState): Promise<FreshnessResult> {
    const newSessions: string[] = []
    const changedSessions: string[] = []
    const removedSessions: string[] = []
    const seenIds = new Set<string>()

    const sessionsDir = join(this.codexDir, 'sessions')
    if (!(await fileExists(sessionsDir))) {
      // Codex never installed / no sessions yet — claim no sessions, don't
      // reap another adapter's sessions.
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
