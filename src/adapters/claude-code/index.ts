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
import { SessionDiscovery } from './session-discovery'
import { ConversationParser } from './conversation-parser'
import { SubagentParser } from './subagent-parser'
import { FileChangeExtractor } from './file-change-extractor'
import { MetadataParser } from './metadata-parser'
import { MemoryReader } from './memory-reader'
import { ConfigReader } from './config-reader'

export { SessionDiscovery } from './session-discovery'
export { ConversationParser } from './conversation-parser'
export { SubagentParser } from './subagent-parser'
export { FileChangeExtractor } from './file-change-extractor'
export { MetadataParser } from './metadata-parser'
export { MemoryReader } from './memory-reader'
export { ConfigReader } from './config-reader'

export class ClaudeCodeAdapter implements SessionAdapter {
  readonly source = 'claude-code'

  private readonly discovery: SessionDiscovery
  private readonly conversationParser: ConversationParser
  private readonly subagentParser: SubagentParser
  private readonly fileChangeExtractor: FileChangeExtractor
  private readonly metadataParser: MetadataParser
  private readonly memoryReader: MemoryReader
  readonly configReader: ConfigReader

  constructor(private readonly claudeDir: string) {
    this.discovery = new SessionDiscovery(claudeDir)
    this.conversationParser = new ConversationParser()
    this.subagentParser = new SubagentParser(claudeDir)
    this.fileChangeExtractor = new FileChangeExtractor()
    this.metadataParser = new MetadataParser()
    this.memoryReader = new MemoryReader(claudeDir)
    this.configReader = new ConfigReader(claudeDir)
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    // buildProjectCache() already walks the full projects dir (and sniffs
    // each project's JSONLs for the real cwd) to populate the cache —
    // yield from that cache instead of re-walking disk a second time
    // (finding B11, second half).
    await this.discovery.buildProjectCache()
    yield* this.discovery.cachedProjects()
  }

  async *discoverSessions(project?: string): AsyncIterable<SessionMeta> {
    yield* this.discovery.discoverSessions(project)
  }

  async *getMessages(sessionId: string): AsyncIterable<NormalizedMessage> {
    const sessionPath = await this.findSessionPath(sessionId)
    if (!sessionPath) return
    yield* this.conversationParser.parseSession(sessionPath)
  }

  async *getFileChanges(sessionId: string): AsyncIterable<FileChange> {
    const sessionPath = await this.findSessionPath(sessionId)
    if (!sessionPath) return
    yield* this.fileChangeExtractor.extractChanges(sessionPath)
  }

  async *getSubagents(sessionId: string): AsyncIterable<SubagentMeta> {
    const projectSlug = await this.findProjectSlugForSession(sessionId)
    if (!projectSlug) return
    yield* this.subagentParser.getSubagents(projectSlug, sessionId)
  }

  async *getMemory(project?: string): AsyncIterable<MemoryEntry> {
    yield* this.memoryReader.readMemory(project)
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadataResult | undefined> {
    const sessionPath = await this.findSessionPath(sessionId)
    if (!sessionPath) return undefined
    return this.metadataParser.extractMetadata(sessionPath)
  }

  async getSessionCost(projectSlug: string, sessionId: string): Promise<number | undefined> {
    return this.configReader.getSessionCost(projectSlug, sessionId)
  }

  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    return this.discovery.resolveProject(path)
  }

  async checkFreshness(known: IndexState): Promise<FreshnessResult> {
    const newSessions: string[] = []
    const changedSessions: string[] = []
    const removedSessions: string[] = []
    const seenIds = new Set<string>()

    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) {
      // No projects dir — every id the registry passed us was already filtered
      // to ids we previously claimed, so all are gone.
      const allKnown = Array.from(known.sessionWatermarks.keys())
      return {
        isStale: allKnown.length > 0,
        newSessions: [],
        changedSessions: [],
        removedSessions: allKnown,
      }
    }

    // Walk all project directories, find all session JSONL files
    for await (const session of this.discovery.discoverSessions()) {
      const sessionId = session.id
      seenIds.add(sessionId)

      const sessionPath = join(projectsDir, session.projectSlug, `${sessionId}.jsonl`)
      if (!(await fileExists(sessionPath))) continue

      const currentWatermark = await fileSize(sessionPath)
      const knownWatermark = known.sessionWatermarks.get(sessionId)

      if (knownWatermark === undefined) {
        newSessions.push(sessionId)
      } else if (currentWatermark > knownWatermark) {
        changedSessions.push(sessionId)
      }
    }

    // The registry pre-filters `known.sessionWatermarks` to ids this adapter
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
    return (await this.findSessionPath(sessionId)) !== undefined
  }

  async getSessionWatermark(sessionId: string): Promise<number | undefined> {
    const path = await this.findSessionPath(sessionId)
    if (!path) return undefined
    return fileSize(path)
  }

  /**
   * Finds the JSONL file path for a given sessionId by searching all project directories.
   */
  private async findSessionPath(sessionId: string): Promise<string | undefined> {
    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return undefined

    const { listDirectories } = await import('../../infrastructure/file-system')
    const slugs = await listDirectories(projectsDir)

    for (const slug of slugs) {
      const candidate = join(projectsDir, slug, `${sessionId}.jsonl`)
      if (await fileExists(candidate)) {
        return candidate
      }
    }
    return undefined
  }

  /**
   * Finds the project slug that contains a given sessionId.
   */
  private async findProjectSlugForSession(sessionId: string): Promise<string | undefined> {
    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return undefined

    const { listDirectories } = await import('../../infrastructure/file-system')
    const slugs = await listDirectories(projectsDir)

    for (const slug of slugs) {
      const candidate = join(projectsDir, slug, `${sessionId}.jsonl`)
      if (await fileExists(candidate)) {
        return slug
      }
    }
    return undefined
  }
}
