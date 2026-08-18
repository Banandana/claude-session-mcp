import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { CodexSessionDiscovery } from './session-discovery'
import type { ProjectMeta, SessionMeta } from '../../types'

const CODEX_HOME = join(__dirname, '../../../fixtures/codex-home')
const PARENT_ID = '01a00000-0000-7000-8000-000000000001'
const CHILD_ID = '01a00000-0000-7000-8000-000000000002'

async function collectSessions(discovery: CodexSessionDiscovery, project?: string): Promise<SessionMeta[]> {
  const out: SessionMeta[] = []
  for await (const s of discovery.discoverSessions(project)) out.push(s)
  return out
}

async function collectProjects(discovery: CodexSessionDiscovery): Promise<ProjectMeta[]> {
  const out: ProjectMeta[] = []
  for await (const p of discovery.discoverProjects()) out.push(p)
  return out
}

describe('CodexSessionDiscovery', () => {
  it('discovers the parent rollout and excludes the child (sub-agent) rollout', async () => {
    const discovery = new CodexSessionDiscovery(CODEX_HOME)
    const sessions = await collectSessions(discovery)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe(PARENT_ID)
    expect(sessions[0]?.source).toBe('codex')
    expect(sessions[0]?.cwd).toBe('/home/test/project-alpha')
    expect(sessions[0]?.version).toBe('0.146.1')
    expect(sessions[0]?.entrypoint).toBe('codex-tui')
  })

  it('regression: sub-agent exclusion count stays exactly 1, not 2 (spawn-shape detection guard)', async () => {
    // Guards the bug where child detection looked at the wrong field
    // (payload.thread_source as an object) and never fired on real data —
    // discoverSessions silently listed every thread instead of excluding
    // children. A regression here should show up as a COUNT mismatch (2
    // instead of 1), not as a subtler behavioral difference.
    const discovery = new CodexSessionDiscovery(CODEX_HOME)
    const sessions = await collectSessions(discovery)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe(PARENT_ID)
    expect(sessions.map(s => s.id)).not.toContain(CHILD_ID)
  })

  it('derives one project from the sessions cwd', async () => {
    const discovery = new CodexSessionDiscovery(CODEX_HOME)
    const projects = await collectProjects(discovery)
    expect(projects).toHaveLength(1)
    expect(projects[0]?.path).toBe('/home/test/project-alpha')
    expect(projects[0]?.source).toBe('codex')
    expect(projects[0]?.sessionCount).toBe(1) // child excluded from the count
  })

  it('resolves a project by exact and nested path', async () => {
    const discovery = new CodexSessionDiscovery(CODEX_HOME)
    const exact = await discovery.resolveProject('/home/test/project-alpha')
    expect(exact?.path).toBe('/home/test/project-alpha')

    const nested = await discovery.resolveProject('/home/test/project-alpha/src')
    expect(nested?.path).toBe('/home/test/project-alpha')
  })

  it('findSessionFile locates both parent and child rollouts by id', async () => {
    const discovery = new CodexSessionDiscovery(CODEX_HOME)
    const parent = await discovery.findSessionFile(PARENT_ID)
    expect(parent?.path).toContain('01a00000-0000-7000-8000-000000000001')

    const child = await discovery.findSessionFile(CHILD_ID)
    expect(child?.path).toContain('01a00000-0000-7000-8000-000000000002')
    expect(child?.header.threadSpawn?.parentThreadId).toBe(PARENT_ID)
  })

  it('findChildRollouts returns the child for the parent id and nothing for the child id', async () => {
    const discovery = new CodexSessionDiscovery(CODEX_HOME)

    const children: string[] = []
    for await (const c of discovery.findChildRollouts(PARENT_ID)) children.push(c.header.sessionId)
    expect(children).toEqual([CHILD_ID])

    const grandchildren: string[] = []
    for await (const c of discovery.findChildRollouts(CHILD_ID)) grandchildren.push(c.header.sessionId)
    expect(grandchildren).toEqual([])
  })

  it('degrades quietly when the sessions directory is missing', async () => {
    const discovery = new CodexSessionDiscovery(join(CODEX_HOME, 'does-not-exist'))
    expect(await collectSessions(discovery)).toEqual([])
    expect(await collectProjects(discovery)).toEqual([])
    expect(await discovery.findSessionFile(PARENT_ID)).toBeUndefined()
  })
})
