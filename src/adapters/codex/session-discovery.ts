import { join } from 'node:path'
import type { ProjectMeta, SessionMeta } from '../../types'
import { fileExists, fileMtime } from '../../infrastructure/file-system'
import { listAllRollouts, pathToSlug, readRolloutHeader, type RolloutHeader } from './rollout-header'

export class CodexSessionDiscovery {
  private projectCache: Map<string, ProjectMeta> = new Map()
  private cacheBuilt = false

  constructor(private readonly codexDir: string) {}

  private sessionsDir(): string {
    return join(this.codexDir, 'sessions')
  }

  /**
   * Derives projects from the `cwd` of every rollout (parent AND child —
   * children share their parent's cwd, so including them just confirms the
   * same project; sessionCount only counts non-child rollouts to match what
   * discoverSessions actually returns).
   */
  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    const sessionsDir = this.sessionsDir()
    if (!(await fileExists(sessionsDir))) return

    const sessionCountByCwd = new Map<string, number>()
    for await (const { path } of listAllRollouts(sessionsDir)) {
      const header = await readRolloutHeader(path)
      if (!header?.cwd) continue
      if (header.threadSpawn) continue // sub-agent threads don't count as sessions
      sessionCountByCwd.set(header.cwd, (sessionCountByCwd.get(header.cwd) ?? 0) + 1)
    }

    for (const [cwd, sessionCount] of sessionCountByCwd) {
      yield {
        slug: pathToSlug(cwd),
        path: cwd,
        source: 'codex',
        sessionCount,
        hasMemory: false,
        // Codex's memory analogue is AGENTS.md, but this field's literal
        // meaning (checked project-CLAUDE.md presence elsewhere in the
        // codebase, e.g. ConfigReader.readProjectClaudeMd) is source-agnostic
        // by name only — Codex's AGENTS.md is surfaced instead via getMemory.
        hasClaudeMd: await fileExists(join(cwd, 'CLAUDE.md')),
      }
    }
  }

  /** Excludes sub-agent/child rollouts — see class doc on the adapter. */
  async *discoverSessions(projectSlug?: string): AsyncIterable<SessionMeta> {
    const sessionsDir = this.sessionsDir()
    if (!(await fileExists(sessionsDir))) return

    for await (const { path } of listAllRollouts(sessionsDir)) {
      const header = await readRolloutHeader(path)
      if (!header) continue
      if (header.threadSpawn) continue

      const cwd = header.cwd ?? '/'
      const slug = pathToSlug(cwd)
      if (projectSlug && slug !== projectSlug) continue

      const startedAt = header.timestamp ?? new Date(await fileMtime(path)).toISOString()

      yield {
        id: header.sessionId,
        source: 'codex',
        projectSlug: slug,
        cwd,
        startedAt,
        version: header.cliVersion,
        entrypoint: header.originator,
      }
    }
  }

  /** Lazy cache pattern (mirrors PiSessionDiscovery.resolveProject). */
  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    if (!this.cacheBuilt) {
      await this.buildProjectCache()
    }
    return this.lookupCached(path)
  }

  private lookupCached(path: string): ProjectMeta | undefined {
    let current = path
    while (current && current !== '/') {
      const slug = pathToSlug(current)
      const project = this.projectCache.get(slug)
      if (project) return project
      const lastSlash = current.lastIndexOf('/')
      current = lastSlash > 0 ? current.slice(0, lastSlash) : '/'
    }
    return undefined
  }

  async buildProjectCache(): Promise<void> {
    this.projectCache.clear()
    for await (const project of this.discoverProjects()) {
      this.projectCache.set(project.slug, project)
    }
    this.cacheBuilt = true
  }

  cachedProjects(): readonly ProjectMeta[] {
    return [...this.projectCache.values()]
  }

  /**
   * Locates the rollout file for a sessionId, searching parent AND child
   * (sub-agent) rollouts alike — a caller that already has a child's id
   * (from getSubagents) must still be able to fetch its messages.
   */
  async findSessionFile(sessionId: string): Promise<{ path: string; header: RolloutHeader } | undefined> {
    const sessionsDir = this.sessionsDir()
    if (!(await fileExists(sessionsDir))) return undefined

    for await (const { path } of listAllRollouts(sessionsDir)) {
      const header = await readRolloutHeader(path)
      if (header?.sessionId === sessionId) {
        return { path, header }
      }
    }
    return undefined
  }

  /** All child/sub-agent rollouts spawned by `parentSessionId`. */
  async *findChildRollouts(
    parentSessionId: string,
  ): AsyncIterable<{ path: string; header: RolloutHeader }> {
    const sessionsDir = this.sessionsDir()
    if (!(await fileExists(sessionsDir))) return

    for await (const { path } of listAllRollouts(sessionsDir)) {
      const header = await readRolloutHeader(path)
      if (header?.threadSpawn?.parentThreadId === parentSessionId) {
        yield { path, header }
      }
    }
  }
}
