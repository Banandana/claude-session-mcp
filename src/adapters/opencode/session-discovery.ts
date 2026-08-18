import { join } from 'node:path'
import type { ProjectMeta, SessionMeta } from '../../types'
import { fileExists } from '../../infrastructure/file-system'
import type { OpencodeDatabase } from './database'
import type { OpencodeProjectRow, OpencodeSessionRow } from './schema'
import { isGlobalProject, toProjectSlug, fromProjectSlug, parseSessionModel, toIsoString } from './schema'

interface ProjectSessionAgg {
  readonly project_id: string
  readonly cnt: number
  readonly last_active: number
}

interface SubagentCountRow {
  readonly parent_id: string
  readonly cnt: number
}

export class OpencodeSessionDiscovery {
  /** worktree path -> ProjectMeta, for resolveProject's parent-dir walk. */
  private projectCache = new Map<string, ProjectMeta>()
  private cacheBuilt = false

  constructor(private readonly database: OpencodeDatabase) {}

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    const db = this.database.get()
    if (!db) return

    const projects = db
      .prepare('SELECT id, worktree, vcs, name, time_created, time_updated FROM project')
      .all() as OpencodeProjectRow[]

    // Session count + last activity per project, grouped in one query —
    // top-level sessions only, matching discoverSessions' universe.
    const aggRows = db
      .prepare(
        `SELECT project_id, COUNT(*) as cnt, MAX(time_updated) as last_active
         FROM session WHERE parent_id IS NULL GROUP BY project_id`,
      )
      .all() as ProjectSessionAgg[]
    const aggByProject = new Map(aggRows.map(r => [r.project_id, r]))

    for (const project of projects) {
      if (isGlobalProject(project)) continue
      const agg = aggByProject.get(project.id)

      const meta: ProjectMeta = {
        slug: toProjectSlug(project.id),
        path: project.worktree,
        source: 'opencode',
        sessionCount: agg?.cnt ?? 0,
        lastActive: toIsoString(agg?.last_active ?? project.time_updated),
        hasMemory: false,
        hasClaudeMd: await fileExists(join(project.worktree, 'CLAUDE.md')),
      }
      yield meta
    }
  }

  /**
   * Walks the full project table (via discoverProjects) once and caches
   * it by worktree path — mirrors claude-code/pi-code's lazy-cache shape
   * so resolveProject() never re-walks the table per call.
   */
  async buildProjectCache(): Promise<void> {
    this.projectCache.clear()
    for await (const project of this.discoverProjects()) {
      this.projectCache.set(project.path, project)
    }
    this.cacheBuilt = true
  }

  /** Snapshot of the cache built by the most recent buildProjectCache() call. */
  cachedProjects(): readonly ProjectMeta[] {
    return [...this.projectCache.values()]
  }

  /**
   * Walks parent directories of `path` looking for an exact worktree match.
   * opencode's `worktree` is a real filesystem path (unlike claude/pi's
   * lossy hyphen-encoded slugs), so this needs no slug decoding — just
   * string comparison against the cache, one directory level at a time.
   */
  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    if (!this.cacheBuilt) await this.buildProjectCache()

    let current: string | undefined = path
    while (current) {
      const hit = this.projectCache.get(current)
      if (hit) return hit
      if (current === '/') break
      const idx = current.lastIndexOf('/')
      current = idx > 0 ? current.slice(0, idx) : '/'
    }
    return undefined
  }

  async *discoverSessions(projectSlug?: string): AsyncIterable<SessionMeta> {
    const db = this.database.get()
    if (!db) return

    const rows = projectSlug
      ? (db
          .prepare('SELECT * FROM session WHERE parent_id IS NULL AND project_id = ? ORDER BY time_created')
          .all(fromProjectSlug(projectSlug)) as OpencodeSessionRow[])
      : (db.prepare('SELECT * FROM session WHERE parent_id IS NULL ORDER BY time_created').all() as OpencodeSessionRow[])

    const subagentCountRows = db
      .prepare('SELECT parent_id, COUNT(*) as cnt FROM session WHERE parent_id IS NOT NULL GROUP BY parent_id')
      .all() as SubagentCountRow[]
    const subagentCountByParent = new Map(subagentCountRows.map(r => [r.parent_id, r.cnt]))

    for (const row of rows) {
      yield this.toSessionMeta(row, subagentCountByParent.get(row.id) ?? 0)
    }
  }

  toSessionMeta(row: OpencodeSessionRow, subagentCount: number): SessionMeta {
    const totalTokens = row.tokens_input + row.tokens_output + row.tokens_reasoning
    return {
      id: row.id,
      source: 'opencode',
      projectSlug: toProjectSlug(row.project_id),
      cwd: row.directory,
      startedAt: toIsoString(row.time_created),
      endedAt: toIsoString(row.time_updated),
      version: row.version,
      model: parseSessionModel(row.model),
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      costUsd: row.cost,
      customTitle: row.title.length > 0 ? row.title : undefined,
      subagentCount,
    }
  }

  /**
   * Looks up any session row by id — parent or child. Sub-agent sessions
   * are excluded from discoverSessions' top-level listing but are still
   * ordinary rows in the same table, so this must not filter on
   * `parent_id` the way discoverSessions does.
   */
  async findSessionRow(sessionId: string): Promise<OpencodeSessionRow | undefined> {
    const db = this.database.get()
    if (!db) return undefined
    return db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId) as OpencodeSessionRow | undefined
  }
}
