import { describe, it, expect } from 'vitest'
import { PhaseClusterer, categorizeToolName } from './phase-clusterer'
import type { NormalizedMessage } from '../types'

function makeMessage(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    role: overrides.role ?? 'assistant',
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00Z',
    contentBlocks: overrides.contentBlocks ?? [{ type: 'text', text: 'hello' }],
    isError: overrides.isError ?? false,
    isCorrection: overrides.isCorrection ?? false,
    hasThinking: false,
    uuid: overrides.id,
    toolNames: overrides.toolNames,
  }
}

describe('PhaseClusterer', () => {
  const clusterer = new PhaseClusterer()

  it('returns one phase per turn for sessions under 10 turns', () => {
    const messages = [
      makeMessage({ id: '1', role: 'user' }),
      makeMessage({ id: '2', role: 'assistant', toolNames: ['Read'] }),
    ]

    const phases = clusterer.cluster(messages)

    expect(phases).toHaveLength(2)
    expect(phases[0].turnRange).toEqual({ from: 0, to: 0 })
    expect(phases[1].turnRange).toEqual({ from: 1, to: 1 })
  })

  it('groups consecutive turns of same category', () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      makeMessage({
        id: `msg-${i}`,
        role: 'assistant',
        toolNames: i < 5 ? ['Read', 'Grep'] : i < 10 ? ['Edit', 'Write'] : ['Bash'],
        contentBlocks: [{ type: 'tool_use', name: i < 5 ? 'Read' : i < 10 ? 'Edit' : 'Bash' }],
      })
    )

    const phases = clusterer.cluster(messages)

    expect(phases.length).toBeGreaterThanOrEqual(3)
    expect(phases[0].description).toContain('Explore')
    expect(phases[1].description).toContain('Modify')
    expect(phases[2].description).toContain('Execute')
  })

  it('error turns take priority over tool category', () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMessage({
        id: `msg-${i}`,
        role: 'assistant',
        toolNames: ['Bash'],
        isError: i >= 5 && i <= 7,
        contentBlocks: [{ type: 'tool_use', name: 'Bash' }],
      })
    )

    const phases = clusterer.cluster(messages)
    const errorPhase = phases.find(p => p.description.includes('Error'))

    expect(errorPhase).toBeDefined()
    expect(errorPhase!.errorCount).toBeGreaterThan(0)
  })

  it('absorbs single-turn phases surrounded by same category', () => {
    // 5 Explore, 1 Modify, 5+1 Explore — the lone Modify should be absorbed
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMessage({
        id: `msg-${i}`,
        role: 'assistant',
        toolNames: i === 5 ? ['Edit'] : ['Read'],
        contentBlocks: [{ type: 'tool_use', name: i === 5 ? 'Edit' : 'Read' }],
      })
    )

    const phases = clusterer.cluster(messages)
    const modifyPhases = phases.filter(p => p.description.includes('Modify'))
    expect(modifyPhases).toHaveLength(0)

    // Should produce a single Explore phase covering all 12 turns
    expect(phases).toHaveLength(1)
    expect(phases[0].turnRange).toEqual({ from: 0, to: 11 })
    expect(phases[0].turnCount).toBe(12)
    expect(phases[0].toolNames).toContain('Read')
    expect(phases[0].toolNames).toContain('Edit')
  })

  it('includes tool names and error counts per phase', () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMessage({
        id: `msg-${i}`,
        role: 'assistant',
        toolNames: ['Read', 'Grep'],
        isError: i === 3,
        contentBlocks: [{ type: 'tool_use', name: 'Read' }],
      })
    )

    const phases = clusterer.cluster(messages)

    const hasToolInfo = phases.some(p => p.toolNames.includes('Read'))
    expect(hasToolInfo).toBe(true)
  })

  describe('per-source tool taxonomy', () => {
    it('categorizes claude-code tool names exactly as before', () => {
      expect(categorizeToolName('Read')).toBe('Explore')
      expect(categorizeToolName('Glob')).toBe('Explore')
      expect(categorizeToolName('Grep')).toBe('Explore')
      expect(categorizeToolName('LS')).toBe('Explore')
      expect(categorizeToolName('Edit')).toBe('Modify')
      expect(categorizeToolName('Write')).toBe('Modify')
      expect(categorizeToolName('NotebookEdit')).toBe('Modify')
      expect(categorizeToolName('Bash')).toBe('Execute')
    })

    it('is case-insensitive, so opencode lowercase-native names resolve through the same keys', () => {
      expect(categorizeToolName('read')).toBe('Explore')
      expect(categorizeToolName('edit')).toBe('Modify')
      expect(categorizeToolName('write')).toBe('Modify')
      expect(categorizeToolName('grep')).toBe('Explore')
      expect(categorizeToolName('glob')).toBe('Explore')
      expect(categorizeToolName('bash')).toBe('Execute')
    })

    it('categorizes opencode-only tool names', () => {
      expect(categorizeToolName('webfetch')).toBe('Explore')
      expect(categorizeToolName('todowrite')).toBe('Modify')
      expect(categorizeToolName('task')).toBe('Execute')
    })

    it('categorizes Codex tool names', () => {
      expect(categorizeToolName('exec')).toBe('Execute')
      expect(categorizeToolName('shell')).toBe('Execute')
      expect(categorizeToolName('apply_patch')).toBe('Modify')
      expect(categorizeToolName('update_plan')).toBe('Modify')
      expect(categorizeToolName('wait')).toBe('Execute')
    })

    it('returns undefined for unmapped tool names', () => {
      expect(categorizeToolName('Agent')).toBeUndefined()
      expect(categorizeToolName('SomeFutureTool')).toBeUndefined()
    })

    it('clusters a non-claude (opencode-shaped) session using the taxonomy', () => {
      const messages = Array.from({ length: 15 }, (_, i) =>
        makeMessage({
          id: `oc-${i}`,
          role: 'assistant',
          toolNames: i < 5 ? ['grep', 'glob'] : i < 10 ? ['edit', 'write'] : ['bash'],
          contentBlocks: [{ type: 'tool_use', name: i < 5 ? 'grep' : i < 10 ? 'edit' : 'bash' }],
        })
      )

      const phases = clusterer.cluster(messages)

      expect(phases.length).toBeGreaterThanOrEqual(3)
      expect(phases[0]?.description).toContain('Explore')
      expect(phases[1]?.description).toContain('Modify')
      expect(phases[2]?.description).toContain('Execute')
    })
  })
})
