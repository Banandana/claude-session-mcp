import type { NormalizedMessage, ContentBlock } from '../types'
import type { Phase } from '../types/conversation'

export type { Phase }

type Category = 'Error' | 'Modify' | 'Execute' | 'Explore' | 'Discuss'

/** The three tool buckets phase clustering groups turns into (Discuss/Error are decided independently of tool name). */
export type ToolCategory = 'Explore' | 'Modify' | 'Execute'

/**
 * Source-agnostic tool taxonomy (finding: per-source tool taxonomy).
 *
 * Keys are lowercase — lookup is case-insensitive so each source's native
 * casing works without a per-source branch. claude-code's mapping is
 * preserved exactly as it was before this taxonomy existed (Read/Glob/
 * Grep/LS → Explore, Edit/Write/NotebookEdit → Modify, Bash → Execute),
 * so existing behaviour and tests are unchanged. Because lookup is
 * case-insensitive, opencode's lowercase-native names (`read`, `edit`,
 * `write`, `grep`, `glob`, `bash`) already resolve through the same keys
 * — only names with no claude-code equivalent need their own entry.
 *
 * Unmapped names (Codex/opencode tools not listed here, claude's `Agent`,
 * anything future/unknown) fall through to the pre-existing default of
 * `Execute` in `categorize()` below — same as before this taxonomy existed.
 */
const TOOL_TAXONOMY: Readonly<Record<string, ToolCategory>> = {
  // claude-code (case preserved as lowercase keys; behaviour unchanged)
  read: 'Explore',
  glob: 'Explore',
  grep: 'Explore',
  ls: 'Explore',
  edit: 'Modify',
  write: 'Modify',
  notebookedit: 'Modify',
  bash: 'Execute',

  // opencode-only names (bash/read/edit/write/grep/glob already covered above)
  webfetch: 'Explore',
  todowrite: 'Modify',
  task: 'Execute',

  // Codex-only names
  exec: 'Execute',
  shell: 'Execute',
  apply_patch: 'Modify',
  update_plan: 'Modify',
  wait: 'Execute',
}

/** Case-insensitive taxonomy lookup. Returns undefined for unmapped names. */
export function categorizeToolName(name: string): ToolCategory | undefined {
  return TOOL_TAXONOMY[name.toLowerCase()]
}

function isExploreAgent(tools: readonly string[], blocks: readonly ContentBlock[]): boolean {
  if (!tools.includes('Agent')) return false
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.name === 'Agent') {
      const input = block.input as Record<string, unknown> | undefined
      if (input?.['subagent_type'] === 'Explore') return true
    }
  }
  return false
}

export class PhaseClusterer {
  cluster(messages: readonly NormalizedMessage[]): readonly Phase[] {
    if (messages.length < 10) {
      return messages.map((msg, i) => this.singleTurnPhase(msg, i))
    }

    const categories = messages.map(msg => this.categorize(msg))
    let phases = this.groupConsecutive(messages, categories)
    phases = this.absorbSingletons(phases, categories)

    return phases
  }

  private categorize(msg: NormalizedMessage): Category {
    if (msg.isError) return 'Error'

    const tools = msg.toolNames ?? []
    if (tools.length === 0) return 'Discuss'

    if (tools.some(t => categorizeToolName(t) === 'Modify')) return 'Modify'
    if (tools.some(t => categorizeToolName(t) === 'Execute')) return 'Execute'
    if (tools.some(t => categorizeToolName(t) === 'Explore')) return 'Explore'
    if (isExploreAgent(tools, msg.contentBlocks)) return 'Explore'

    // Agent calls or unknown tools default to Execute
    return 'Execute'
  }

  private singleTurnPhase(msg: NormalizedMessage, index: number): Phase {
    const category = this.categorize(msg)
    const tools = [...new Set(msg.toolNames ?? [])]

    return {
      turnRange: { from: index, to: index },
      description: this.describeCategory(category, tools),
      toolNames: tools,
      errorCount: msg.isError ? 1 : 0,
      turnCount: 1,
    }
  }

  private groupConsecutive(
    messages: readonly NormalizedMessage[],
    categories: readonly Category[],
  ): Phase[] {
    const phases: Phase[] = []
    let phaseStart = 0

    for (let i = 1; i <= messages.length; i++) {
      if (i === messages.length || categories[i] !== categories[phaseStart]) {
        const slice = messages.slice(phaseStart, i)
        const allTools = new Set<string>()
        let errors = 0

        for (const msg of slice) {
          for (const t of msg.toolNames ?? []) allTools.add(t)
          if (msg.isError) errors++
        }

        const tools = [...allTools]

        const startCategory = categories[phaseStart] ?? 'Discuss'
        phases.push({
          turnRange: { from: phaseStart, to: i - 1 },
          description: this.describeCategory(startCategory, tools),
          toolNames: tools,
          errorCount: errors,
          turnCount: slice.length,
        })

        phaseStart = i
      }
    }

    return phases
  }

  private absorbSingletons(phases: Phase[], categories: readonly Category[]): Phase[] {
    if (phases.length < 3) return phases

    const result: Phase[] = []

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]
      if (!phase) continue
      const prev = i > 0 ? phases[i - 1] : null
      const next = i < phases.length - 1 ? phases[i + 1] : null

      // Absorb single-turn phases surrounded by same category
      if (
        phase.turnCount === 1 &&
        prev && next &&
        categories[prev.turnRange.from] === categories[next.turnRange.from]
      ) {
        const merged = result[result.length - 1]
        if (merged) {
          const mergedTools = new Set([...merged.toolNames, ...phase.toolNames])
          result[result.length - 1] = {
            turnRange: { from: merged.turnRange.from, to: phase.turnRange.to },
            description: merged.description,
            toolNames: [...mergedTools],
            errorCount: merged.errorCount + phase.errorCount,
            turnCount: merged.turnCount + phase.turnCount,
          }
          continue
        }
      }

      // Try to merge with previous if same category (after absorption changed things)
      const last = result[result.length - 1]
      if (
        last &&
        categories[last.turnRange.from] === categories[phase.turnRange.from]
      ) {
        const mergedTools = new Set([...last.toolNames, ...phase.toolNames])
        result[result.length - 1] = {
          turnRange: { from: last.turnRange.from, to: phase.turnRange.to },
          description: last.description,
          toolNames: [...mergedTools],
          errorCount: last.errorCount + phase.errorCount,
          turnCount: last.turnCount + phase.turnCount,
        }
        continue
      }

      result.push(phase)
    }

    return result
  }

  private describeCategory(category: Category, tools: readonly string[]): string {
    const toolList = tools.length > 0 ? ` (${tools.slice(0, 4).join(', ')})` : ''

    switch (category) {
      case 'Error': return `Errors${toolList}`
      case 'Modify': return `Modify files${toolList}`
      case 'Execute': return `Executed commands${toolList}`
      case 'Explore': return `Explored codebase${toolList}`
      case 'Discuss': return 'Discussion'
    }
  }
}
