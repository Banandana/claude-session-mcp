import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from '../services/index-manager'
import { mergeProjectsByPath, resolveCanonicalPath } from './list-projects'
import type { ProjectMeta } from '../types'

function makeProject(overrides: Partial<ProjectMeta> & { slug: string; source: string }): ProjectMeta {
  return {
    slug: overrides.slug,
    source: overrides.source,
    path: overrides.path ?? '/home/kitty/repo',
    sessionCount: overrides.sessionCount ?? 1,
    lastActive: overrides.lastActive,
    branches: overrides.branches,
    hasMemory: overrides.hasMemory ?? false,
    hasClaudeMd: overrides.hasClaudeMd ?? false,
  }
}

describe('list_projects cross-source merge', () => {
  let tempDir: string
  let db: Database.Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'list-projects-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')

    const indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  describe('resolveCanonicalPath', () => {
    it('falls back to the adapter-reported path when no alias row exists', () => {
      const key = resolveCanonicalPath(db, 'claude-code', '-home-kitty-repo', '/home/kitty/repo')
      expect(key).toBe('/home/kitty/repo')
    })

    it('normalizes a trailing slash the same way resolveProjectId does', () => {
      const key = resolveCanonicalPath(db, 'claude-code', '-home-kitty-repo', '/home/kitty/repo/')
      expect(key).toBe('/home/kitty/repo')
    })

    it('prefers the project_aliases -> projects join over the raw adapter path when one exists', () => {
      db.prepare(`INSERT INTO projects (id, path, first_seen_at) VALUES (?, ?, ?)`)
        .run('/home/kitty/repo', '/home/kitty/repo', '2026-01-01T00:00:00Z')
      db.prepare(`INSERT INTO project_aliases (source, source_slug, project_id) VALUES (?, ?, ?)`)
        .run('pi-code', '--home-kitty-repo--', '/home/kitty/repo')

      // The adapter's own `path` field disagrees with the canonical row —
      // proves the alias join actually wins, not just happens to agree.
      const key = resolveCanonicalPath(db, 'pi-code', '--home-kitty-repo--', '/some/other/stale/path')
      expect(key).toBe('/home/kitty/repo')
    })
  })

  describe('mergeProjectsByPath', () => {
    it('merges two sources with the same raw path into one entry', () => {
      const projects = [
        makeProject({ slug: '-home-kitty-repo', source: 'claude-code', path: '/home/kitty/repo', sessionCount: 5, lastActive: '2026-08-01T00:00:00Z', hasClaudeMd: true }),
        makeProject({ slug: '--home-kitty-repo--', source: 'pi-code', path: '/home/kitty/repo', sessionCount: 3, lastActive: '2026-08-10T00:00:00Z', hasMemory: true }),
      ]

      const merged = mergeProjectsByPath(db, projects)

      expect(merged).toHaveLength(1)
      expect(merged[0]!.path).toBe('/home/kitty/repo')
      expect(merged[0]!.sessionCount).toBe(8) // summed
      expect(merged[0]!.lastActive).toBe('2026-08-10T00:00:00Z') // max across sources
      expect(merged[0]!.hasClaudeMd).toBe(true) // OR
      expect(merged[0]!.hasMemory).toBe(true) // OR
      expect(merged[0]!.sources['claude-code']).toEqual({ slug: '-home-kitty-repo', sessionCount: 5, lastActive: '2026-08-01T00:00:00Z' })
      expect(merged[0]!.sources['pi-code']).toEqual({ slug: '--home-kitty-repo--', sessionCount: 3, lastActive: '2026-08-10T00:00:00Z' })
    })

    it('does NOT merge two genuinely different projects (proves this is not a no-op that merges everything)', () => {
      const projects = [
        makeProject({ slug: '-home-kitty-repo-a', source: 'claude-code', path: '/home/kitty/repo-a' }),
        makeProject({ slug: '-home-kitty-repo-b', source: 'claude-code', path: '/home/kitty/repo-b' }),
      ]

      const merged = mergeProjectsByPath(db, projects)

      expect(merged).toHaveLength(2)
      expect(merged.map(m => m.path).sort()).toEqual(['/home/kitty/repo-a', '/home/kitty/repo-b'])
    })

    it('merges four sources on the same project via the alias table even when raw paths differ', () => {
      db.prepare(`INSERT INTO projects (id, path, first_seen_at) VALUES (?, ?, ?)`)
        .run('/home/kitty/repo', '/home/kitty/repo', '2026-01-01T00:00:00Z')
      db.prepare(`INSERT INTO project_aliases (source, source_slug, project_id) VALUES (?, ?, ?)`)
        .run('opencode', 'sha1-abc123', '/home/kitty/repo')

      const projects = [
        makeProject({ slug: '-home-kitty-repo', source: 'claude-code', path: '/home/kitty/repo', sessionCount: 2 }),
        makeProject({ slug: '--home-kitty-repo--', source: 'pi-code', path: '/home/kitty/repo', sessionCount: 1 }),
        makeProject({ slug: '/home/kitty/repo', source: 'codex', path: '/home/kitty/repo', sessionCount: 4 }),
        // opencode's own `path` field is stale/different — the alias row must win.
        makeProject({ slug: 'sha1-abc123', source: 'opencode', path: '/stale/opencode/path', sessionCount: 7 }),
      ]

      const merged = mergeProjectsByPath(db, projects)

      expect(merged).toHaveLength(1)
      expect(merged[0]!.path).toBe('/home/kitty/repo')
      expect(merged[0]!.sessionCount).toBe(14)
      expect(Object.keys(merged[0]!.sources).sort()).toEqual(['claude-code', 'codex', 'opencode', 'pi-code'])
      expect(merged[0]!.sources['opencode']!.sessionCount).toBe(7)
    })

    it('unions branches across sources', () => {
      const projects = [
        makeProject({ slug: 'a', source: 'claude-code', path: '/repo', branches: ['main', 'feature-x'] }),
        makeProject({ slug: 'b', source: 'codex', path: '/repo', branches: ['feature-x', 'feature-y'] }),
      ]

      const merged = mergeProjectsByPath(db, projects)
      expect(merged[0]!.branches).toEqual(['feature-x', 'feature-y', 'main'])
    })
  })
})
