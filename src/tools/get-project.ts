import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { ProjectResolver } from '../services/project-resolver'
import type { ResponseFormatter } from '../services/response-formatter'
import type { ProjectMeta, MemoryEntry, ProjectSettings } from '../types'
import { ConfigReader } from '../adapters/claude-code/config-reader'

export function registerGetProject(server: McpServer): void {
  server.tool(
    'get_project',
    'Get details for a specific project by slug or filesystem path. With detail=full, includes CLAUDE.md content, settings, and memory entries.',
    {
      project: z.string().optional().describe('Project slug'),
      path: z.string().optional().describe('Filesystem path to project or subdirectory'),
      detail: z.enum(['summary', 'full']).optional().describe('Detail level'),
    },
    async (params) => {
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)
      const registry = container.get<AdapterRegistry>(TOKENS.AdapterRegistry)
      const projectResolver = container.get<ProjectResolver>(TOKENS.ProjectResolver)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)

      const freshness = await freshnessGuard.ensureFresh()

      const slug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      if (!slug) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Could not resolve project. Provide a valid project slug or path.' }, null, 2) }],
        }
      }

      // Find matching project
      let foundProject: ProjectMeta | undefined
      for await (const p of registry.discoverProjects()) {
        if (p.slug === slug) {
          foundProject = p
          break
        }
      }

      if (!foundProject) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Project not found: ${slug}` }, null, 2) }],
        }
      }

      const detail = params.detail ?? 'summary'

      if (detail === 'full') {
        // CLAUDE.md and settings are claude-code-specific concepts; pi projects
        // expose neither, so we only invoke ConfigReader for claude-sourced projects.
        let claudeMd: string | undefined
        let settings: ProjectSettings | undefined
        if (foundProject.source === 'claude-code') {
          const claudeDir = container.get<string>(TOKENS.ClaudeDataDir)
          const configReader = new ConfigReader(claudeDir)
          claudeMd = await configReader.readProjectClaudeMd(foundProject.path)
          settings = await configReader.readSettings()
        }

        // Memory: route through registry so each adapter surfaces its own
        // memory format (claude's `~/.claude/memory`, pi's `~/.pi/agent/memory`).
        const memoryEntries: MemoryEntry[] = []
        for await (const entry of registry.getMemory(slug)) {
          memoryEntries.push(entry)
        }

        // Get session list for the project
        const sessions: Array<{ id: string; startedAt: string; model?: string | undefined }> = []
        for await (const s of registry.discoverSessions(slug)) {
          sessions.push({ id: s.id, startedAt: s.startedAt, model: s.model })
        }

        const fullResult = {
          ...foundProject,
          claudeMd,
          settings,
          memoryEntries,
          sessions,
        }

        const meta = formatter.formatMeta(freshness)
        const response = formatter.format(fullResult, meta)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        }
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(foundProject, meta)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
