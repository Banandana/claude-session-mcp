import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerListProjects } from './list-projects'
import { registerGetProject } from './get-project'
import { registerListSessions } from './list-sessions'
import { registerGetSession } from './get-session'
import { registerGetConversation } from './get-conversation'
import { registerSearch } from './search'
import { registerGetChanges } from './get-changes'
import { registerGetMemory } from './get-memory'
import { registerAnalyze } from './analyze'
import { registerGetTurns } from './get-turns'
import { registerQueryTurns } from './query-turns'
import { registerContextAudit } from './context-audit'
import { registerSemanticSearch } from './semantic-search'

export function registerTools(server: McpServer): void {
  registerListProjects(server)
  registerGetProject(server)
  registerListSessions(server)
  registerGetSession(server)
  registerGetConversation(server)
  registerSearch(server)
  registerGetChanges(server)
  registerGetMemory(server)
  registerAnalyze(server)
  registerGetTurns(server)
  registerQueryTurns(server)
  registerContextAudit(server)
  registerSemanticSearch(server)
}
