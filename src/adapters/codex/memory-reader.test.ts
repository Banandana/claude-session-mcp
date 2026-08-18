import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexMemoryReader, CODEX_MEMORY_SLUG } from './memory-reader'
import type { MemoryEntry } from '../../types'

const CODEX_HOME_FIXTURE = join(__dirname, '../../../fixtures/codex-home')

async function collect(reader: CodexMemoryReader, slug?: string): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = []
  for await (const e of reader.readMemory(slug)) out.push(e)
  return out
}

describe('CodexMemoryReader', () => {
  it('returns nothing when no AGENTS.md or rules dir exists (fixtures/codex-home)', async () => {
    const reader = new CodexMemoryReader(CODEX_HOME_FIXTURE)
    expect(await collect(reader)).toEqual([])
  })

  it('returns nothing for a project slug other than the synthetic global one', async () => {
    const reader = new CodexMemoryReader(CODEX_HOME_FIXTURE)
    expect(await collect(reader, 'codex--home-test-project-alpha--')).toEqual([])
  })

  describe('with a synthesized ~/.codex layout', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'codex-memory-'))
      writeFileSync(join(tempDir, 'AGENTS.md'), '# Global agent instructions\n\nAlways run tests before committing.\n')
      mkdirSync(join(tempDir, 'rules'))
      writeFileSync(join(tempDir, 'rules', 'coding-style.md'), 'Prefer named exports over default exports.\n')
    })

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    it('surfaces AGENTS.md under the codex-global slug with type project (no invented frontmatter)', async () => {
      const reader = new CodexMemoryReader(tempDir)
      const entries = await collect(reader)
      const agents = entries.find(e => e.fileName === 'AGENTS.md')
      expect(agents).toBeDefined()
      expect(agents?.projectSlug).toBe(CODEX_MEMORY_SLUG)
      expect(agents?.type).toBe('project')
      expect(agents?.content).toContain('Always run tests')
    })

    it('surfaces rules/*.md files', async () => {
      const reader = new CodexMemoryReader(tempDir)
      const entries = await collect(reader)
      const rule = entries.find(e => e.fileName === 'coding-style.md')
      expect(rule).toBeDefined()
      expect(rule?.name).toBe('coding-style')
      expect(rule?.projectSlug).toBe(CODEX_MEMORY_SLUG)
      expect(rule?.content).toContain('named exports')
    })

    it('is retrievable by the synthetic codex-global slug', async () => {
      const reader = new CodexMemoryReader(tempDir)
      const entries = await collect(reader, CODEX_MEMORY_SLUG)
      expect(entries.length).toBe(2)
    })
  })
})
