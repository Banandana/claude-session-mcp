import { join } from 'node:path'
import type { MemoryEntry } from '../../types'
import { fileExists, listFiles, readTextFile } from '../../infrastructure/file-system'

/**
 * Codex has no frontmatter memory store (`memories_1.sqlite` holds job rows,
 * not entries). The analogue is a global `AGENTS.md` plus `~/.codex/rules/`
 * — both surfaced under this synthetic slug, mirroring pi's `pi-global`.
 */
export const CODEX_MEMORY_SLUG = 'codex-global'

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
const FIELD_RE = /^(\w+):\s*(.+)$/
const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference'])

interface ParsedFrontmatter {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly type?: string | undefined
  readonly body: string
}

function parseFrontmatter(content: string): ParsedFrontmatter | undefined {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return undefined

  const fields: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const fieldMatch = FIELD_RE.exec(line.trim())
    if (fieldMatch?.[1] && fieldMatch[2]) fields[fieldMatch[1]] = fieldMatch[2].trim()
  }

  return {
    name: fields['name'],
    description: fields['description'],
    type: fields['type'],
    body: (match[2] ?? '').trim(),
  }
}

function firstLine(content: string): string {
  const line = content.trim().split('\n')[0] ?? ''
  return line.length > 100 ? line.slice(0, 97) + '...' : line
}

/** Builds a MemoryEntry from file content, preferring real frontmatter and
 * falling back to a synthesized `type: 'project'` entry when — as is the
 * case for Codex's plain-markdown AGENTS.md/rules files — no frontmatter
 * shape is present. Never invents frontmatter fields that aren't there. */
function toMemoryEntry(fileName: string, name: string, content: string): MemoryEntry | undefined {
  const trimmed = content.trim()
  if (trimmed.length === 0) return undefined

  const fm = parseFrontmatter(content)
  if (fm?.name && fm.description && fm.type && VALID_TYPES.has(fm.type)) {
    return {
      projectSlug: CODEX_MEMORY_SLUG,
      fileName,
      name: fm.name,
      description: fm.description,
      type: fm.type as MemoryEntry['type'],
      content: fm.body,
    }
  }

  return {
    projectSlug: CODEX_MEMORY_SLUG,
    fileName,
    name,
    description: firstLine(trimmed) || `Codex instructions from ${fileName}`,
    type: 'project',
    content: trimmed,
  }
}

export class CodexMemoryReader {
  constructor(private readonly codexDir: string) {}

  async *readMemory(projectSlug?: string): AsyncIterable<MemoryEntry> {
    if (projectSlug && projectSlug !== CODEX_MEMORY_SLUG) return

    yield* this.readAgentsFile()
    yield* this.readRules()
  }

  private async *readAgentsFile(): AsyncIterable<MemoryEntry> {
    const path = join(this.codexDir, 'AGENTS.md')
    if (!(await fileExists(path))) return

    let content: string
    try {
      content = await readTextFile(path)
    } catch {
      return
    }

    const entry = toMemoryEntry('AGENTS.md', 'AGENTS', content)
    if (entry) yield entry
  }

  private async *readRules(): AsyncIterable<MemoryEntry> {
    const rulesDir = join(this.codexDir, 'rules')
    if (!(await fileExists(rulesDir))) return

    const files = await listFiles(rulesDir, '.md')
    for (const fileName of files) {
      let content: string
      try {
        content = await readTextFile(join(rulesDir, fileName))
      } catch {
        continue
      }

      const entry = toMemoryEntry(fileName, fileName.replace(/\.md$/, ''), content)
      if (entry) yield entry
    }
  }
}
