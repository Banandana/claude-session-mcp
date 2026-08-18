import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { ProjectResolver } from '../services/project-resolver'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { ProjectMeta, MemoryEntry, ProjectSettings } from '../types'
import { ConfigReader } from '../adapters/claude-code/config-reader'
import { mergeProjectsByPath, resolveCanonicalPath } from './list-projects'

interface CrossSourceSessionRow {
  readonly id: string
  readonly source: string
  readonly started_at: string
  readonly model: string | null
}

interface CrossSourceSession {
  readonly id: string
  readonly source: string
  readonly startedAt: string
  readonly model?: string | undefined
}

/**
 * Every session belonging to this canonical project, across every source
 * that has touched it. Prefers `sessions.project_id` (populated by
 * FreshnessGuard.resolveProjectId, V7) and falls back to `project_slug`
 * for rows indexed before V7 — or any row a sync cycle hasn't touched
 * since — that never got a project_id backfilled.
 */
export function loadCrossSourceSessions(
  db: Database.Database,
  canonicalPath: string,
  knownSlugs: readonly string[],
): readonly CrossSourceSession[] {
  const params: unknown[] = [canonicalPath]
  let sql = 'SELECT id, source, started_at, model FROM sessions WHERE project_id = ?'
  if (knownSlugs.length > 0) {
    sql += ` OR (project_id IS NULL AND project_slug IN (${knownSlugs.map(() => '?').join(', ')}))`
    params.push(...knownSlugs)
  }
  sql += ' ORDER BY started_at DESC'

  const rows = db.prepare(sql).all(...params) as CrossSourceSessionRow[]
  return rows.map(r => ({
    id: r.id,
    source: r.source,
    startedAt: r.started_at,
    model: r.model ?? undefined,
  }))
}

export function registerGetProject(server: McpServer): void {
  server.tool(
    'get_project',
    'Get details for a specific project by slug or filesystem path. Merges data across every source adapter (claude-code, pi-code, codex, opencode) that has touched the project — session counts and lists span all of them, reported per-source. With detail=full, includes CLAUDE.md content, settings, and memory entries.',
    {
      project: z.string().optional().describe('Project slug'),
      path: z.string().optional().describe('Filesystem path to project or subdirectory'),
      detail: z.enum(['summary', 'full']).optional().describe('Detail level'),
    },
    async (params) => {
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const registry = container.get<AdapterRegistry>(TOKENS.AdapterRegistry)
      const projectResolver = container.get<ProjectResolver>(TOKENS.ProjectResolver)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.get<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()

      const freshness = await freshnessGuard.ensureFresh()

      const slug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      if (!slug) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Could not resolve project. Provide a valid project slug or path.' }, null, 2) }],
        }
      }

      // Collect every source's ProjectMeta once — used both to anchor the
      // requested slug and to merge in every OTHER source touching the
      // same canonical path.
      const allProjects: ProjectMeta[] = []
      for await (const p of registry.discoverProjects()) {
        allProjects.push(p)
      }

      const foundProject = allProjects.find(p => p.slug === slug)

      if (!foundProject) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Project not found: ${slug}` }, null, 2) }],
        }
      }

      const canonicalPath = resolveCanonicalPath(db, foundProject.source, foundProject.slug, foundProject.path)
      const merged = mergeProjectsByPath(db, allProjects).find(m => m.path === canonicalPath)
        // mergeProjectsByPath computes the same key for the same input, so
        // foundProject is guaranteed to land in some group — this fallback
        // only exists to satisfy the type checker.
        ?? { path: canonicalPath, sessionCount: foundProject.sessionCount, lastActive: foundProject.lastActive, hasMemory: foundProject.hasMemory, hasClaudeMd: foundProject.hasClaudeMd, branches: foundProject.branches, sources: { [foundProject.source]: { slug: foundProject.slug, sessionCount: foundProject.sessionCount, lastActive: foundProject.lastActive } } }

      const detail = params.detail ?? 'summary'

      if (detail === 'full') {
        // CLAUDE.md and settings are claude-code-specific concepts; read
        // them from whichever source in this MERGED project is claude-code
        // (not necessarily the source the caller's slug/path resolved to).
        let claudeMd: string | undefined
        let settings: ProjectSettings | undefined
        const claudeCodeProject = allProjects.find(
          p => p.source === 'claude-code' && resolveCanonicalPath(db, p.source, p.slug, p.path) === canonicalPath
        )
        if (claudeCodeProject) {
          const claudeDir = container.get<string>(TOKENS.ClaudeDataDir)
          const configReader = new ConfigReader(claudeDir)
          claudeMd = await configReader.readProjectClaudeMd(claudeCodeProject.path)
          settings = await configReader.readSettings()
        }

        // Memory: route through registry so each adapter surfaces its own
        // memory format (claude's `~/.claude/memory`, pi's `~/.pi/agent/memory`),
        // once per source that has touched this project.
        const memoryEntries: MemoryEntry[] = []
        for (const sourceInfo of Object.values(merged.sources)) {
          for await (const entry of registry.getMemory(sourceInfo.slug)) {
            memoryEntries.push(entry)
          }
        }

        // Session list spans every source, not just the one the input
        // slug/path happened to resolve to.
        const knownSlugs = Object.values(merged.sources).map(s => s.slug)
        const sessions = loadCrossSourceSessions(db, canonicalPath, knownSlugs)

        const fullResult = {
          ...merged,
          claudeMd,
          settings,
          memoryEntries,
          sessions,
        }

        const meta = formatter.formatMeta(freshness)
        const response = formatter.format(fullResult, meta)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        }
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(merged, meta)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
