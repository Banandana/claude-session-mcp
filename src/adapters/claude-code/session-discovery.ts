import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectMeta, SessionMeta } from '../../types'
import { readJsonFile, fileExists, listFiles, streamJsonlLines } from '../../infrastructure/file-system'

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

interface SessionsIndexEntry {
  readonly sessionId: string
  readonly firstPrompt?: string
  readonly created?: string
  readonly modified?: string
  readonly fileMtime?: number
  readonly gitBranch?: string
}

interface SessionsIndex {
  readonly version: number
  readonly entries: readonly SessionsIndexEntry[]
}

/**
 * Lossy fallback. Used only when no session JSONL is available to read
 * the authoritative `cwd`. Real dir names that contain hyphens get
 * mangled into separators here — that's the bug `findRealCwd` works
 * around when it can.
 */
function slugToPathHeuristic(slug: string): string {
  const stripped = slug.startsWith('-') ? slug.slice(1) : slug
  return '/' + stripped.replace(/-/g, '/')
}

const MAX_CWD_PROBE_LINES = 50

/**
 * Find the authoritative cwd for a project by scanning the first ~50 lines
 * of any session JSONL in the project directory. The `cwd` field is written
 * by Claude Code on every user/assistant message — it's the real filesystem
 * path, unlike `slugToPath` which inverts ambiguously.
 */
async function findRealCwd(projectDir: string): Promise<string | undefined> {
  let files: string[]
  try {
    files = await listFiles(projectDir, '.jsonl')
  } catch {
    return undefined
  }
  for (const f of files) {
    if (!UUID_JSONL.test(f)) continue
    const fullPath = join(projectDir, f)
    let lineCount = 0
    try {
      for await (const { line } of streamJsonlLines(fullPath)) {
        if (lineCount++ >= MAX_CWD_PROBE_LINES) break
        try {
          const obj = JSON.parse(line) as { cwd?: unknown }
          if (typeof obj.cwd === 'string' && obj.cwd.startsWith('/')) {
            return obj.cwd
          }
        } catch {
          continue
        }
      }
    } catch {
      continue
    }
  }
  return undefined
}

export class SessionDiscovery {
  private readonly claudeDir: string
  private projectCache: Map<string, ProjectMeta> = new Map()
  /** Index from real filesystem path → slug for fast resolveProject lookups. */
  private pathToSlug: Map<string, string> = new Map()
  private cacheBuilt = false

  constructor(claudeDir: string) {
    this.claudeDir = claudeDir
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return

    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const slug = entry.name
      const projectDir = join(projectsDir, slug)

      // Authoritative path comes from the session JSONLs (`cwd` field).
      // Fall back to the lossy slug heuristic only when no JSONL is readable.
      const realCwd = await findRealCwd(projectDir)
      const projectPath = realCwd ?? slugToPathHeuristic(slug)

      // Count UUID .jsonl files
      const files = await listFiles(projectDir, '.jsonl')
      const sessionCount = files.filter(f => UUID_JSONL.test(f)).length

      // Check for memory directory
      const memoryDir = join(projectDir, 'memory')
      const hasMemory = await fileExists(memoryDir)

      // Check for CLAUDE.md at the real project path
      const claudeMdPath = join(projectPath, 'CLAUDE.md')
      const hasClaudeMd = await fileExists(claudeMdPath)

      const project: ProjectMeta = {
        slug,
        path: projectPath,
        source: 'claude-code',
        sessionCount,
        hasMemory,
        hasClaudeMd,
      }

      yield project
    }
  }

  async *discoverSessions(projectSlug?: string): AsyncIterable<SessionMeta> {
    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return

    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (projectSlug && entry.name !== projectSlug) continue

      const slug = entry.name
      const projectDir = join(projectsDir, slug)
      const indexPath = join(projectDir, 'sessions-index.json')

      // Resolve the real cwd once per project; fall back to the heuristic.
      const cwd = (await findRealCwd(projectDir)) ?? slugToPathHeuristic(slug)

      if (await fileExists(indexPath)) {
        // Use sessions-index.json
        const index = await readJsonFile<SessionsIndex>(indexPath)
        for (const e of index.entries) {
          const session: SessionMeta = {
            id: e.sessionId,
            source: 'claude-code',
            projectSlug: slug,
            cwd,
            branch: e.gitBranch,
            startedAt: e.created ?? new Date(e.fileMtime ?? 0).toISOString(),
            summaryText: e.firstPrompt,
          }
          yield session
        }
      } else {
        // Fall back to listing UUID .jsonl files
        const files = await listFiles(projectDir, '.jsonl')
        for (const file of files) {
          if (!UUID_JSONL.test(file)) continue
          const sessionId = file.replace('.jsonl', '')
          const filePath = join(projectDir, file)
          const fileStat = await stat(filePath)

          const session: SessionMeta = {
            id: sessionId,
            source: 'claude-code',
            projectSlug: slug,
            cwd,
            startedAt: fileStat.birthtime.toISOString(),
          }
          yield session
        }
      }
    }
  }

  /**
   * Async because we may need to build the cache. After the first call, the
   * cache is warm and subsequent lookups are O(depth-of-path).
   */
  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    if (!this.cacheBuilt) {
      await this.buildProjectCache()
    }
    return this.lookupCached(path)
  }

  /** Sync lookup that assumes the cache is already built. */
  private lookupCached(path: string): ProjectMeta | undefined {
    let current = path
    while (current && current !== '/') {
      // First match by real filesystem path (handles hyphens correctly)
      const slugByPath = this.pathToSlug.get(current)
      if (slugByPath) {
        const project = this.projectCache.get(slugByPath)
        if (project) return project
      }
      // Fall back to slug heuristic — covers cases where the cache stores a
      // heuristic-derived path because no JSONL was readable at discovery time.
      const heuristicSlug = '-' + current.slice(1).replace(/\//g, '-')
      const project = this.projectCache.get(heuristicSlug)
      if (project) return project

      const lastSlash = current.lastIndexOf('/')
      current = lastSlash > 0 ? current.slice(0, lastSlash) : '/'
    }
    return undefined
  }

  async buildProjectCache(): Promise<void> {
    this.projectCache.clear()
    this.pathToSlug.clear()
    for await (const project of this.discoverProjects()) {
      this.projectCache.set(project.slug, project)
      this.pathToSlug.set(project.path, project.slug)
    }
    this.cacheBuilt = true
  }

  /**
   * Snapshot of the cache built by the most recent buildProjectCache() call
   * — lets callers that already paid for a full disk walk avoid paying for
   * a second one just to enumerate the same projects (finding B11).
   */
  cachedProjects(): readonly ProjectMeta[] {
    return [...this.projectCache.values()]
  }
}
