import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { ProjectMeta } from '../types'

// ── Cross-source project merge ───────────────────────────────────────────────
//
// Each adapter's `discoverProjects()` yields one ProjectMeta per project IT
// knows about, slug-encoded in that adapter's own scheme (a claude slug
// like `-home-kitty-foo`, a pi slug like `--home-kitty-foo--`, a bare Codex
// cwd, an opencode sha1 — see the V7 migration note in index-manager.ts).
// Without merging, one repository worked on by three agents shows up as
// three unrelated projects. `mergeProjectsByPath` groups them by canonical
// real filesystem path instead, so list_projects and get_project return one
// entry per repo with a per-source breakdown.

export interface ProjectSourceBreakdown {
  readonly slug: string
  readonly sessionCount: number
  readonly lastActive?: string | undefined
}

export interface MergedProject {
  readonly path: string
  readonly sessionCount: number
  readonly lastActive?: string | undefined
  readonly hasMemory: boolean
  readonly hasClaudeMd: boolean
  readonly branches?: readonly string[] | undefined
  readonly sources: Record<string, ProjectSourceBreakdown>
}

/**
 * Resolves a ProjectMeta's canonical grouping key. Prefers the V7
 * `project_aliases -> projects` join (populated by
 * `FreshnessGuard.resolveProjectId` as sessions are synced — the id IS the
 * normalized real cwd, so it's stable across sources) since that's the
 * authoritative cross-source identity. Falls back to the adapter's own
 * `path` field, normalized the same way `resolveProjectId` normalizes cwd
 * (trailing slash stripped), for a project an adapter has discovered that
 * has no synced session yet — so no alias row exists — meaning this still
 * works before any indexing has happened for that project.
 */
export function resolveCanonicalPath(db: Database.Database, source: string, slug: string, fallbackPath: string): string {
  const row = db.prepare(
    `SELECT p.path as path FROM project_aliases a JOIN projects p ON p.id = a.project_id WHERE a.source = ? AND a.source_slug = ?`
  ).get(source, slug) as { path: string } | undefined
  if (row) return row.path
  return fallbackPath.length > 1 && fallbackPath.endsWith('/') ? fallbackPath.slice(0, -1) : fallbackPath
}

function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

function mergeBranches(a: readonly string[] | undefined, b: readonly string[] | undefined): readonly string[] | undefined {
  if (!a && !b) return undefined
  return [...new Set([...(a ?? []), ...(b ?? [])])].sort()
}

/**
 * Groups adapter-reported ProjectMeta by canonical real-filesystem path.
 * Merged session count sums per-source counts; lastActive is the max
 * across sources; hasMemory/hasClaudeMd are OR'd (true if ANY source has
 * it); branches are unioned.
 */
export function mergeProjectsByPath(db: Database.Database, projects: readonly ProjectMeta[]): MergedProject[] {
  const groups = new Map<string, MergedProject>()

  for (const p of projects) {
    const key = resolveCanonicalPath(db, p.source, p.slug, p.path)
    const sourceEntry: ProjectSourceBreakdown = { slug: p.slug, sessionCount: p.sessionCount, lastActive: p.lastActive }
    const existing = groups.get(key)

    if (!existing) {
      groups.set(key, {
        path: key,
        sessionCount: p.sessionCount,
        lastActive: p.lastActive,
        hasMemory: p.hasMemory,
        hasClaudeMd: p.hasClaudeMd,
        branches: p.branches,
        sources: { [p.source]: sourceEntry },
      })
    } else {
      groups.set(key, {
        path: key,
        sessionCount: existing.sessionCount + p.sessionCount,
        lastActive: laterOf(existing.lastActive, p.lastActive),
        hasMemory: existing.hasMemory || p.hasMemory,
        hasClaudeMd: existing.hasClaudeMd || p.hasClaudeMd,
        branches: mergeBranches(existing.branches, p.branches),
        sources: { ...existing.sources, [p.source]: sourceEntry },
      })
    }
  }

  return [...groups.values()]
}

// ── Tool registration ────────────────────────────────────────────────────────

export function registerListProjects(server: McpServer): void {
  server.tool(
    'list_projects',
    'List all known projects with session counts, last activity, and memory/config status. One entry per canonical filesystem path — projects touched by multiple source adapters (claude-code, pi-code, codex, opencode) are merged into a single entry with a per-source breakdown.',
    {
      sortBy: z.enum(['recent', 'sessions', 'name']).optional().describe('Sort order: recent (last active across all sources), sessions (most total sessions across all sources), name (alphabetical by path)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of projects to return'),
    },
    async (params) => {
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const registry = container.get<AdapterRegistry>(TOKENS.AdapterRegistry)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.get<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()

      const freshness = await freshnessGuard.ensureFresh()

      const projects: ProjectMeta[] = []
      for await (const p of registry.discoverProjects()) {
        projects.push(p)
      }

      const merged = mergeProjectsByPath(db, projects)

      // Sort
      const sortBy = params.sortBy ?? 'recent'
      if (sortBy === 'name') {
        merged.sort((a, b) => a.path.localeCompare(b.path))
      } else if (sortBy === 'sessions') {
        merged.sort((a, b) => b.sessionCount - a.sessionCount)
      } else {
        // 'recent' — by lastActive descending
        merged.sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''))
      }

      const limited = params.limit ? merged.slice(0, params.limit) : merged

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(limited, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
