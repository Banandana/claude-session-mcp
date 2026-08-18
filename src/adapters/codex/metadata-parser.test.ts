import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { CodexMetadataParser } from './metadata-parser'

const PARENT_PATH = join(
  __dirname,
  '../../../fixtures/codex-home/sessions/2026/08/17/rollout-2026-08-17T10-00-00-01a00000-0000-7000-8000-000000000001.jsonl',
)

describe('CodexMetadataParser', () => {
  it('yields a ContextCollapse for the compacted line', async () => {
    const parser = new CodexMetadataParser()
    const meta = await parser.extractMetadata(PARENT_PATH)

    expect(meta.collapses).toHaveLength(1)
    const collapse = meta.collapses[0]
    expect(collapse?.sessionId).toBe('01a00000-0000-7000-8000-000000000001')
    expect(collapse?.summary.length).toBeGreaterThan(0)
    expect(collapse?.firstArchivedUuid).not.toBe('unknown')
    expect(collapse?.lastArchivedUuid).not.toBe('unknown')
  })

  it('derives aiTitle from the first user message', async () => {
    const parser = new CodexMetadataParser()
    const meta = await parser.extractMetadata(PARENT_PATH)
    expect(meta.aiTitle).toBe('add a retry to the fetch helper')
  })

  it('collects task_complete.last_agent_message as a task summary', async () => {
    const parser = new CodexMetadataParser()
    const meta = await parser.extractMetadata(PARENT_PATH)
    expect(meta.taskSummaries).toHaveLength(1)
    expect(meta.taskSummaries[0]).toContain('bounded retry')
  })

  it('leaves source-inapplicable fields empty rather than inventing data', async () => {
    const parser = new CodexMetadataParser()
    const meta = await parser.extractMetadata(PARENT_PATH)
    expect(meta.customTitle).toBeUndefined()
    expect(meta.tags).toEqual([])
    expect(meta.mode).toBeUndefined()
    expect(meta.prLinks).toEqual([])
    expect(meta.worktreeBranch).toBeUndefined()
    expect(meta.speculationTimeSavedMs).toBe(0)
  })
})
