import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectMeta, SessionMeta } from '../../types'
import { fileExists, listFiles } from '../../infrastructure/file-system'

/**
 * Pi encodes the session cwd as folder name: `/data/project` → `--data-project--`.
 * Leading and trailing `--` wrap the path; remaining single `-` are path separators.
 * Hyphens in real directory names become separators (lossy, same as claude-code).
 */
function slugToPath(slug: string): string {
  let s = slug
  if (s.startsWith('--')) s = s.slice(2)
  if (s.endsWith('--')) s = s.slice(0, -2)
  if (s.length === 0) return '/'
  return '/' + s.replace(/-/g, '/')
}

/**
 * Pi session JSONL filenames: `<timestamp>_<uuid>.jsonl`.
 * The UUID is the stable session id.
 */
const SESSION_JSONL_RE = /^.+?_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

export function extractSessionIdFromFilename(filename: string): string | undefined {
  const match = SESSION_JSONL_RE.exec(filename)
  return match ? match[1] : undefined
}

export class PiSessionDiscovery {
  private projectCache: Map<string, ProjectMeta> = new Map()
  private cacheBuilt = false

  constructor(private readonly piDir: string) {}

  private sessionsDir(): string {
    return join(this.piDir, 'sessions')
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    const sessionsDir = this.sessionsDir()
    if (!(await fileExists(sessionsDir))) return

    const entries = await readdir(sessionsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const slug = entry.name
      const projectDir = join(sessionsDir, slug)
      const derivedPath = slugToPath(slug)

      const files = await listFiles(projectDir, '.jsonl')
      const sessionCount = files.filter(f => SESSION_JSONL_RE.test(f)).length
      if (sessionCount === 0) continue

      yield {
        slug,
        path: derivedPath,
        source: 'pi-code',
        sessionCount,
        hasMemory: false,
        hasClaudeMd: await fileExists(join(derivedPath, 'CLAUDE.md')),
      }
    }
  }

  async *discoverSessions(projectSlug?: string): AsyncIterable<SessionMeta> {
    const sessionsDir = this.sessionsDir()
    if (!(await fileExists(sessionsDir))) return

    const entries = await readdir(sessionsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (projectSlug && entry.name !== projectSlug) continue

      const slug = entry.name
      const projectDir = join(sessionsDir, slug)
      const cwd = slugToPath(slug)

      const files = await listFiles(projectDir, '.jsonl')
      for (const file of files) {
        const sessionId = extractSessionIdFromFilename(file)
        if (!sessionId) continue

        const filePath = join(projectDir, file)
        const fileStat = await stat(filePath)

        yield {
          id: sessionId,
          source: 'pi-code',
          projectSlug: slug,
          cwd,
          startedAt: fileStat.birthtime.toISOString(),
        }
      }
    }
  }

  /**
   * Async because a fresh process may need to build the cache first.
   * Before this fix (finding B10), resolveProject read a cache that was
   * only ever populated by buildProjectCache() — which nothing called on
   * a cold `path:`-scoped MCP tool invocation, so resolution always
   * returned undefined. Mirrors the lazy-build pattern in claude-code's
   * SessionDiscovery.resolveProject.
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
      const slug = '--' + current.slice(1).replace(/\//g, '-') + '--'
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

  /**
   * Snapshot of the cache built by the most recent buildProjectCache()
   * call — lets callers that already paid for a full disk walk avoid
   * paying for a second one just to enumerate the same projects
   * (finding B11).
   */
  cachedProjects(): readonly ProjectMeta[] {
    return [...this.projectCache.values()]
  }

  /**
   * Locate the full JSONL file path for a sessionId by scanning all project dirs.
   */
  async findSessionFile(sessionId: string): Promise<{ path: string; slug: string; filename: string } | undefined> {
    const sessionsDir = this.sessionsDir()
    if (!(await fileExists(sessionsDir))) return undefined

    const entries = await readdir(sessionsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectDir = join(sessionsDir, entry.name)
      const files = await listFiles(projectDir, '.jsonl')
      for (const file of files) {
        const id = extractSessionIdFromFilename(file)
        if (id === sessionId) {
          return { path: join(projectDir, file), slug: entry.name, filename: file }
        }
      }
    }
    return undefined
  }
}
