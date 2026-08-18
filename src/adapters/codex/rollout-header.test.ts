import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  extractSessionIdFromFilename,
  listAllRollouts,
  pathToSlug,
  readRolloutHeader,
  slugToPath,
} from './rollout-header'

const CODEX_HOME = join(__dirname, '../../../fixtures/codex-home')
const SESSIONS_DIR = join(CODEX_HOME, 'sessions')

const PARENT_FILE = 'rollout-2026-08-17T10-00-00-01a00000-0000-7000-8000-000000000001.jsonl'
const CHILD_FILE = 'rollout-2026-08-17T10-00-11-01a00000-0000-7000-8000-000000000002.jsonl'

describe('extractSessionIdFromFilename', () => {
  it('extracts the UUID tail past the ISO timestamp', () => {
    expect(extractSessionIdFromFilename(PARENT_FILE)).toBe('01a00000-0000-7000-8000-000000000001')
    expect(extractSessionIdFromFilename(CHILD_FILE)).toBe('01a00000-0000-7000-8000-000000000002')
  })

  it('returns undefined for non-matching filenames', () => {
    expect(extractSessionIdFromFilename('not-a-rollout.jsonl')).toBeUndefined()
  })
})

describe('pathToSlug / slugToPath', () => {
  it('round-trips an absolute path with no hyphens in its segments', () => {
    // Hyphens inside real directory names are lossy under this encoding
    // (they become indistinguishable from path separators) — the same
    // documented caveat claude-code and pi-code's slug schemes both have.
    const path = '/home/test/projectalpha'
    const slug = pathToSlug(path)
    expect(slugToPath(slug)).toBe(path)
  })

  it('does not collide with claude-code or pi-code slug shapes', () => {
    const slug = pathToSlug('/home/test/project-alpha')
    // claude-code: '-home-test-project-alpha' (single leading dash)
    expect(slug).not.toBe('-home-test-project-alpha')
    // pi-code: '--home-test-project-alpha--' (double dash, no prefix)
    expect(slug).not.toBe('--home-test-project-alpha--')
    expect(slug.startsWith('codex--')).toBe(true)
  })
})

describe('listAllRollouts', () => {
  it('walks the YYYY/MM/DD tree and finds both rollout files', async () => {
    const found: string[] = []
    for await (const { filename } of listAllRollouts(SESSIONS_DIR)) {
      found.push(filename)
    }
    expect(found.sort()).toEqual([CHILD_FILE, PARENT_FILE].sort())
  })

  it('returns nothing for a missing sessions directory', async () => {
    const found: string[] = []
    for await (const entry of listAllRollouts(join(CODEX_HOME, 'does-not-exist'))) {
      found.push(entry.filename)
    }
    expect(found).toEqual([])
  })
})

describe('readRolloutHeader', () => {
  it('reads session_id, cwd, originator, cli_version from the parent rollout', async () => {
    const header = await readRolloutHeader(join(SESSIONS_DIR, '2026/08/17', PARENT_FILE))
    expect(header).toBeDefined()
    expect(header?.sessionId).toBe('01a00000-0000-7000-8000-000000000001')
    expect(header?.cwd).toBe('/home/test/project-alpha')
    expect(header?.originator).toBe('codex-tui')
    expect(header?.cliVersion).toBe('0.146.1')
    expect(header?.threadSpawn).toBeUndefined()
  })

  it('extracts thread_spawn info from the child rollout', async () => {
    const header = await readRolloutHeader(join(SESSIONS_DIR, '2026/08/17', CHILD_FILE))
    expect(header?.threadSpawn).toBeDefined()
    expect(header?.threadSpawn?.parentThreadId).toBe('01a00000-0000-7000-8000-000000000001')
    expect(header?.threadSpawn?.depth).toBe(1)
    expect(header?.threadSpawn?.agentPath).toBe('/root/retry_reviewer')
    expect(header?.threadSpawn?.agentNickname).toBe('Hilbert')
    // agent_role is null on real data — must not crash or coerce to a string.
    expect(header?.threadSpawn?.agentRole).toBeNull()
  })

  it("regression: a child rollout's own sessionId is payload.id, never payload.session_id (which holds the PARENT's id there)", async () => {
    const header = await readRolloutHeader(join(SESSIONS_DIR, '2026/08/17', CHILD_FILE))
    expect(header?.sessionId).toBe('01a00000-0000-7000-8000-000000000002') // the child's own id
    expect(header?.sessionId).not.toBe(header?.threadSpawn?.parentThreadId)
  })
})
