import { describe, it, expect, beforeAll } from 'vitest'
import { OpencodeDatabase } from './database'
import { OpencodeSessionDiscovery } from './session-discovery'
import { buildFixtureDb } from './test-fixture'
import type { ProjectMeta, SessionMeta } from '../../types'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

describe('OpencodeSessionDiscovery', () => {
  let dbPath: string
  let discovery: OpencodeSessionDiscovery

  beforeAll(() => {
    dbPath = buildFixtureDb()
    discovery = new OpencodeSessionDiscovery(new OpencodeDatabase(dbPath))
  })

  describe('discoverProjects', () => {
    it('yields one namespaced, richly-described project', async () => {
      const projects = await collect<ProjectMeta>(discovery.discoverProjects())
      expect(projects).toHaveLength(1)
      const [project] = projects
      expect(project?.slug).toBe('oc-proj_alpha_sha1')
      expect(project?.path).toBe('/home/test/project-alpha')
      expect(project?.source).toBe('opencode')
      expect(project?.sessionCount).toBe(1)
      expect(project?.hasMemory).toBe(false)
      expect(project?.hasClaudeMd).toBe(false)
      expect(project?.lastActive).toBe(new Date(1787000600000).toISOString())
    })
  })

  describe('discoverSessions', () => {
    it('excludes the child (sub-agent) session', async () => {
      const sessions = await collect<SessionMeta>(discovery.discoverSessions())
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.id).toBe('ses_parent0000000000000001')
    })

    it('maps directory/title/cost/tokens/time correctly', async () => {
      const [session] = await collect<SessionMeta>(discovery.discoverSessions())
      expect(session?.projectSlug).toBe('oc-proj_alpha_sha1')
      expect(session?.cwd).toBe('/home/test/project-alpha')
      expect(session?.customTitle).toBe('Add retry to fetch helper')
      expect(session?.costUsd).toBeCloseTo(0.1925675)
      expect(session?.totalTokens).toBe(10086 + 2258 + 134)
      expect(session?.startedAt).toBe(new Date(1787000000000).toISOString())
      expect(session?.model).toBe('cerebras/zai-glm-4.7')
      expect(session?.subagentCount).toBe(1)
    })

    it('filters by project slug', async () => {
      const sessions = await collect<SessionMeta>(discovery.discoverSessions('oc-proj_alpha_sha1'))
      expect(sessions).toHaveLength(1)
      const none = await collect<SessionMeta>(discovery.discoverSessions('oc-nonexistent'))
      expect(none).toHaveLength(0)
    })
  })

  describe('findSessionRow', () => {
    it('finds the parent session', async () => {
      const row = await discovery.findSessionRow('ses_parent0000000000000001')
      expect(row?.title).toBe('Add retry to fetch helper')
    })

    it('also finds the child (sub-agent) session, unlike discoverSessions', async () => {
      const row = await discovery.findSessionRow('ses_child00000000000000002')
      expect(row?.parent_id).toBe('ses_parent0000000000000001')
    })

    it('returns undefined for an unknown id', async () => {
      expect(await discovery.findSessionRow('nonexistent')).toBeUndefined()
    })
  })

  describe('resolveProject', () => {
    it('lazy-builds the cache on first call (cold start)', async () => {
      const fresh = new OpencodeSessionDiscovery(new OpencodeDatabase(dbPath))
      const result = await fresh.resolveProject('/home/test/project-alpha')
      expect(result?.slug).toBe('oc-proj_alpha_sha1')
    })

    it('resolves a nested path up to the project worktree', async () => {
      const result = await discovery.resolveProject('/home/test/project-alpha/src/fetch.ts')
      expect(result?.slug).toBe('oc-proj_alpha_sha1')
    })

    it('returns undefined for a path outside any known worktree', async () => {
      const result = await discovery.resolveProject('/somewhere/else')
      expect(result).toBeUndefined()
    })
  })
})
