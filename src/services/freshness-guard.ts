import type Database from 'better-sqlite3'
import type { AdapterRegistry } from './adapter-registry'
import type { IndexManager } from './index-manager'
import type { LocalLlmClient } from './local-llm-client'
import type { IndexState, NormalizedMessage, SessionMeta } from '../types'
import type { TurnIndexer } from './turn-indexer'
import type { EmbeddingIndexer } from './embedding-indexer'
import { generateTopic } from './topic-generator'

function formatToolCounts(json: string): string {
  try {
    const counts = JSON.parse(json) as Record<string, number>
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', ')
  } catch { return '' }
}

function formatFilesChanged(json: string): string {
  try {
    const files = JSON.parse(json) as Array<{ path: string; op: string }>
    return files.slice(0, 5).map(f => `${f.path} (${f.op})`).join(', ')
  } catch { return '' }
}

const FRESHNESS_DEBOUNCE_MS = 2000

export class FreshnessGuard {
  private readonly db: Database.Database
  private lastFreshAt = 0
  private lastResult: {
    syncDurationMs: number
    indexedAt: string
    sessionCount: number
    staleSessions: number
  } | null = null
  private inflight: Promise<{
    syncDurationMs: number
    indexedAt: string
    sessionCount: number
    staleSessions: number
  }> | null = null

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly indexManager: IndexManager,
    private readonly claudeDir: string,
    db: Database.Database,
    private readonly llmClient?: LocalLlmClient,
    private readonly turnIndexer?: TurnIndexer,
    private readonly embeddingIndexer?: EmbeddingIndexer | null,
  ) {
    this.db = db
  }

  async ensureFresh(): Promise<{
    syncDurationMs: number
    indexedAt: string
    sessionCount: number
    staleSessions: number
  }> {
    // Debounce: serve cached result for bursts of calls within the window.
    if (this.lastResult && Date.now() - this.lastFreshAt < FRESHNESS_DEBOUNCE_MS) {
      return this.lastResult
    }
    // Coalesce: if a sync is already running, await it instead of starting a second.
    if (this.inflight) return this.inflight

    this.inflight = this.runEnsureFresh()
    try {
      const r = await this.inflight
      this.lastResult = r
      this.lastFreshAt = Date.now()
      return r
    } finally {
      this.inflight = null
    }
  }

  private async runEnsureFresh(): Promise<{
    syncDurationMs: number
    indexedAt: string
    sessionCount: number
    staleSessions: number
  }> {
    const start = Date.now()

    // 1. Ensure schema exists
    this.indexManager.ensureSchema()

    // 2. Build IndexState from current database (single query, not N+1)
    const watermarks = this.indexManager.getAllSessionWatermarks()
    const known: IndexState = {
      sessionWatermarks: watermarks,
      lastSyncAt: new Date().toISOString(),
    }

    // 2b. Supply DB-backed ownership hints so the registry can resolve a
    // session's owning adapter straight from `sessions.source` instead of
    // probing every adapter's disk layout per session (finding B11).
    this.registry.setOwnerHints(this.loadOwnerHints())

    // 3. Check freshness via adapter registry
    const result = await this.registry.checkFreshness(known)

    // 4. If stale, sync changes
    if (result.isStale) {
      await this.syncNewSessions(result.newSessions)
      await this.syncChangedSessions(result.changedSessions)
      this.removeDeletedSessions(result.removedSessions)
    }

    // 4b. Backfill missing session-level metadata for old rows (bounded per cycle).
    // Catches sessions indexed before MetadataParser learned to extract gitBranch.
    void this.backfillMissingBranch().catch(() => { /* backfill failure is non-critical */ })

    // 5. Fire-and-forget LLM summarization — must not block sync
    void this.generateSummaries().catch(() => { /* summarization failure is non-critical */ })

    // 5b. Fire-and-forget embedding indexing — only runs if an embedding
    // backend was configured via EMBEDDING_MODEL.
    if (this.embeddingIndexer) {
      void this.embeddingIndexer
        .indexPending()
        .catch(() => { /* embedding failure is non-critical */ })
    }

    // 6. Return metadata
    const sessionCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number }).cnt
    return {
      syncDurationMs: Date.now() - start,
      indexedAt: new Date().toISOString(),
      sessionCount,
      staleSessions: 0,
    }
  }

  private async backfillMissingBranch(): Promise<void> {
    const rows = this.db.prepare(`
      SELECT id, project_slug FROM sessions
      WHERE metadata_backfilled_at IS NULL
      LIMIT 50
    `).all() as Array<{ id: string; project_slug: string | null }>

    for (const row of rows) {
      try {
        await this.syncSessionMetadata(row.id, row.project_slug)
      } catch {
        // skip — try again next cycle
      }
    }
  }

  private async generateSummaries(): Promise<void> {
    if (!this.llmClient) return
    const available = await this.llmClient.isAvailable()
    if (!available) return

    // Find sessions needing summaries (max 5 per cycle)
    const rows = this.db.prepare(`
      SELECT id FROM sessions
      WHERE topic IS NOT NULL AND summary IS NULL
      LIMIT 5
    `).all() as Array<{ id: string }>

    for (const row of rows) {
      try {
        // Build context from stored metrics
        const session = this.db.prepare(
          'SELECT duration_minutes, total_turns, total_tokens, error_count, correction_count, tool_counts, files_changed FROM sessions WHERE id = ?'
        ).get(row.id) as Record<string, unknown>

        // Format metrics for LLM
        const metricsBlock = [
          `Session: ${session['duration_minutes'] ?? 0} min, ${session['total_turns'] ?? 0} turns, ${session['total_tokens'] ?? 0} tokens`,
          `Errors: ${session['error_count'] ?? 0}, Corrections: ${session['correction_count'] ?? 0}`,
          session['tool_counts'] ? `Tools: ${formatToolCounts(session['tool_counts'] as string)}` : null,
          session['files_changed'] ? `Files: ${formatFilesChanged(session['files_changed'] as string)}` : null,
        ].filter(Boolean).join('\n')

        const prompt = `${metricsBlock}\n\nSummarize this coding session in 2-3 sentences. Focus on what was accomplished and the outcome.`

        const summary = await this.llmClient.summarize(prompt)
        if (summary) {
          this.db.prepare('UPDATE sessions SET summary = ?, summary_generated_at = ? WHERE id = ?')
            .run(summary, new Date().toISOString(), row.id)
        }
      } catch {
        // Skip failed sessions — retry next cycle
      }
    }
  }

  private async syncNewSessions(sessionIds: readonly string[]): Promise<void> {
    // Discover session metadata for each new session
    const sessionIdSet = new Set(sessionIds)
    const sessionMetaMap = new Map<string, SessionMeta>()
    for await (const session of this.registry.discoverSessions()) {
      if (sessionIdSet.has(session.id)) {
        sessionMetaMap.set(session.id, session)
      }
      // Stop early once we've found all needed sessions
      if (sessionMetaMap.size === sessionIdSet.size) break
    }

    const insertSession = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, source, project_slug, project_id, cwd, branch, started_at, model, total_tokens, total_turns, summary_text, byte_offset, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertMessage = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, type, timestamp, model, token_count, has_tool_use, tool_names, is_error, is_correction, content_preview, cache_creation_tokens, cache_read_tokens, has_thinking, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertFts = this.db.prepare(`
      INSERT INTO messages_fts (rowid, search_text) VALUES (?, ?)
    `)

    for (const sessionId of sessionIds) {
      const meta = sessionMetaMap.get(sessionId)

      // Collect all async data before the transaction
      const messages: NormalizedMessage[] = []
      for await (const msg of this.registry.getMessages(sessionId)) {
        messages.push(msg)
      }

      const fileChanges: Array<{ messageId?: string | undefined; filePath: string; operation: string; timestamp: string }> = []
      for await (const change of this.registry.getFileChanges(sessionId)) {
        fileChanges.push(change)
      }

      const subagents: Array<{ id: string; agentType?: string | undefined; description?: string | undefined; totalTokens?: number | undefined; totalTools?: number | undefined; durationMs?: number | undefined; model?: string | undefined }> = []
      for await (const agent of this.registry.getSubagents(sessionId)) {
        subagents.push(agent)
      }

      // Run all DB writes in a single transaction
      this.db.transaction(() => {
        // Canonical project identity (migration V7) — resolved from cwd,
        // additive alongside project_slug (other tool queries still use
        // project_slug, so it's kept as-is).
        let projectId: string | null = null
        if (meta && meta.cwd) {
          projectId = this.resolveProjectId(meta.cwd, meta.source, meta.projectSlug)
        }

        // Insert session record
        insertSession.run(
          sessionId,
          meta?.source ?? 'claude-code',
          meta?.projectSlug ?? null,
          projectId,
          meta?.cwd ?? null,
          meta?.branch ?? null,
          meta?.startedAt ?? null,
          meta?.model ?? null,
          meta?.totalTokens ?? 0,
          meta?.totalTurns ?? 0,
          meta?.summaryText ?? null,
          0,
          new Date().toISOString(),
        )

        for (const msg of messages) {
          const contentPreview = this.extractContentPreview(msg)
          const searchText = this.extractSearchText(msg)
          const tokenCount = msg.tokenUsage
            ? msg.tokenUsage.input_tokens + msg.tokenUsage.output_tokens
            : 0
          const hasToolUse = msg.toolNames && msg.toolNames.length > 0 ? 1 : 0
          const toolNames = msg.toolNames ? msg.toolNames.join(',') : null

          const result = insertMessage.run(
            msg.id,
            sessionId,
            msg.role,
            msg.role,
            msg.timestamp,
            msg.model ?? null,
            tokenCount,
            hasToolUse,
            toolNames,
            msg.isError ? 1 : 0,
            msg.isCorrection ? 1 : 0,
            contentPreview,
            msg.tokenUsage?.cache_creation_input_tokens ?? 0,
            msg.tokenUsage?.cache_read_input_tokens ?? 0,
            msg.hasThinking ? 1 : 0,
            searchText,
          )

          // Insert full search text into FTS
          if (searchText && result.lastInsertRowid) {
            insertFts.run(result.lastInsertRowid, searchText)
          }
        }

        // Aggregate token counts from messages back to session
        const tokenRow = this.db.prepare(
          'SELECT SUM(token_count) as total FROM messages WHERE session_id = ?'
        ).get(sessionId) as { total: number | null } | undefined
        if (tokenRow?.total) {
          this.db.prepare('UPDATE sessions SET total_tokens = ?, total_turns = ? WHERE id = ?')
            .run(tokenRow.total, messages.length, sessionId)
        }

        // Index file changes
        const insertFileChange = this.db.prepare(`
          INSERT OR IGNORE INTO file_changes (session_id, message_id, file_path, operation, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `)
        for (const change of fileChanges) {
          insertFileChange.run(
            sessionId,
            change.messageId ?? null,
            change.filePath,
            change.operation,
            change.timestamp,
          )
        }

        // Index subagents
        const insertSubagent = this.db.prepare(`
          INSERT OR IGNORE INTO subagents (id, session_id, agent_type, description, total_tokens, total_tools, duration_ms, model)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const agent of subagents) {
          insertSubagent.run(
            agent.id,
            sessionId,
            agent.agentType ?? null,
            agent.description ?? null,
            agent.totalTokens ?? null,
            agent.totalTools ?? null,
            agent.durationMs ?? null,
            agent.model ?? null,
          )
        }

        // Compute and store session metrics + metadata
        this.computeSessionMetrics(sessionId, messages)
      })()

      // Metadata sync is async (fetches cost data) — must be outside transaction
      await this.syncSessionMetadata(sessionId, meta?.projectSlug)

      // Index turn events for structured queries
      this.turnIndexer?.indexSession(sessionId, messages)
    }

    // Update offsets with real file sizes
    await this.updateWatermarks(sessionIds)
  }

  private async syncChangedSessions(sessionIds: readonly string[]): Promise<void> {
    const insertMessage = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, type, timestamp, model, token_count, has_tool_use, tool_names, is_error, is_correction, content_preview, cache_creation_tokens, cache_read_tokens, has_thinking, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const selectExistingRowids = this.db.prepare(
      'SELECT rowid FROM messages WHERE session_id = ?'
    )
    const deleteFtsEntry = this.db.prepare(
      'DELETE FROM messages_fts WHERE rowid = ?'
    )

    for (const sessionId of sessionIds) {
      // Delete stale FTS entries before re-inserting messages
      const existingRowids = selectExistingRowids.all(sessionId) as Array<{ rowid: number }>
      for (const { rowid } of existingRowids) {
        deleteFtsEntry.run(rowid)
      }

      const messages: NormalizedMessage[] = []
      for await (const msg of this.registry.getMessages(sessionId)) {
        messages.push(msg)
      }

      for (const msg of messages) {
        const contentPreview = this.extractContentPreview(msg)
        const searchText = this.extractSearchText(msg)
        const tokenCount = msg.tokenUsage
          ? msg.tokenUsage.input_tokens + msg.tokenUsage.output_tokens
          : 0
        const hasToolUse = msg.toolNames && msg.toolNames.length > 0 ? 1 : 0
        const toolNames = msg.toolNames ? msg.toolNames.join(',') : null

        insertMessage.run(
          msg.id,
          sessionId,
          msg.role,
          msg.role,
          msg.timestamp,
          msg.model ?? null,
          tokenCount,
          hasToolUse,
          toolNames,
          msg.isError ? 1 : 0,
          msg.isCorrection ? 1 : 0,
          contentPreview,
          msg.tokenUsage?.cache_creation_input_tokens ?? 0,
          msg.tokenUsage?.cache_read_input_tokens ?? 0,
          msg.hasThinking ? 1 : 0,
          searchText,
        )

        if (searchText) {
          const row = this.db.prepare('SELECT rowid FROM messages WHERE id = ?').get(msg.id) as { rowid: number } | undefined
          if (row) {
            this.db.prepare('INSERT OR REPLACE INTO messages_fts (rowid, search_text) VALUES (?, ?)').run(row.rowid, searchText)
          }
        }
      }

      // Aggregate token counts
      const tokenRow = this.db.prepare(
        'SELECT SUM(token_count) as total FROM messages WHERE session_id = ?'
      ).get(sessionId) as { total: number | null } | undefined
      if (tokenRow?.total) {
        this.db.prepare('UPDATE sessions SET total_tokens = ?, total_turns = ? WHERE id = ?')
          .run(tokenRow.total, messages.length, sessionId)
      }

      // Re-index file changes
      this.db.prepare('DELETE FROM file_changes WHERE session_id = ?').run(sessionId)
      const insertFileChange = this.db.prepare(`
        INSERT OR IGNORE INTO file_changes (session_id, message_id, file_path, operation, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `)
      for await (const change of this.registry.getFileChanges(sessionId)) {
        insertFileChange.run(
          sessionId,
          change.messageId ?? null,
          change.filePath,
          change.operation,
          change.timestamp,
        )
      }

      // Re-index subagents
      this.db.prepare('DELETE FROM subagents WHERE session_id = ?').run(sessionId)
      const insertSubagent = this.db.prepare(`
        INSERT OR IGNORE INTO subagents (id, session_id, agent_type, description, total_tokens, total_tools, duration_ms, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for await (const agent of this.registry.getSubagents(sessionId)) {
        insertSubagent.run(
          agent.id,
          sessionId,
          agent.agentType ?? null,
          agent.description ?? null,
          agent.totalTokens ?? null,
          agent.totalTools ?? null,
          agent.durationMs ?? null,
          agent.model ?? null,
        )
      }

      // Compute and store session metrics + metadata
      this.computeSessionMetrics(sessionId, messages)
      const projectSlug = this.db.prepare('SELECT project_slug FROM sessions WHERE id = ?').get(sessionId) as { project_slug: string | null } | undefined
      await this.syncSessionMetadata(sessionId, projectSlug?.project_slug ?? undefined)

      // Index turn events for structured queries
      this.turnIndexer?.indexSession(sessionId, messages)
    }

    await this.updateWatermarks(sessionIds)
  }

  private removeDeletedSessions(sessionIds: readonly string[]): void {
    const deleteMessages = this.db.prepare('DELETE FROM messages WHERE session_id = ?')
    const deleteSession = this.db.prepare('DELETE FROM sessions WHERE id = ?')
    const deleteFileChanges = this.db.prepare('DELETE FROM file_changes WHERE session_id = ?')
    const deleteSubagents = this.db.prepare('DELETE FROM subagents WHERE session_id = ?')
    const deletePrLinks = this.db.prepare('DELETE FROM pr_links WHERE session_id = ?')
    const deleteCollapses = this.db.prepare('DELETE FROM context_collapses WHERE session_id = ?')
    const deleteTurnEvents = this.db.prepare('DELETE FROM turn_events WHERE session_id = ?')

    const deleteFtsEntry = this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
    const selectMessageRowids = this.db.prepare(
      'SELECT rowid FROM messages WHERE session_id = ?'
    )

    for (const sessionId of sessionIds) {
      this.db.transaction(() => {
        // Delete FTS entries for messages in this session
        const messageRows = selectMessageRowids.all(sessionId) as { rowid: number }[]
        for (const row of messageRows) {
          deleteFtsEntry.run(row.rowid)
        }

        deleteMessages.run(sessionId)
        deleteFileChanges.run(sessionId)
        deleteSubagents.run(sessionId)
        deletePrLinks.run(sessionId)
        deleteCollapses.run(sessionId)
        deleteTurnEvents.run(sessionId)
        deleteSession.run(sessionId)
      })()
    }
  }

  private computeSessionMetrics(sessionId: string, messages?: readonly NormalizedMessage[]): void {
    // A source whose format has no failure channel must not report 0 errors —
    // that reads as "this agent never fails" in cross-source comparisons.
    // NULL says "not observable here", which is the truth. See
    // ErrorSignalSupport in types/adapter.ts.
    const sourceRow = this.db.prepare(
      'SELECT source FROM sessions WHERE id = ?'
    ).get(sessionId) as { source: string | null } | undefined
    const errorsObservable = sourceRow?.source
      ? this.registry.errorSignalForSource(sourceRow.source) === 'explicit'
      : true
    // Get started_at (+ the fields needed to resolve project_id) from session row
    const sessionRow = this.db.prepare(
      'SELECT started_at, source, project_slug, cwd, project_id FROM sessions WHERE id = ?'
    ).get(sessionId) as { started_at: string | null; source: string; project_slug: string | null; cwd: string | null; project_id: string | null } | undefined
    const startedAt = sessionRow?.started_at ?? null

    // Populate project_id (migration V7) whenever it's still unset — covers
    // syncChangedSessions, which doesn't have a fresh SessionMeta to hand
    // to the insert path the way syncNewSessions does.
    if (sessionRow && sessionRow.cwd && !sessionRow.project_id) {
      const projectId = this.resolveProjectId(sessionRow.cwd, sessionRow.source, sessionRow.project_slug ?? '')
      this.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId, sessionId)
    }

    // Message counts
    const msgStats = this.db.prepare(`
      SELECT
        COUNT(*) as message_count,
        MAX(timestamp) as max_timestamp,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN is_correction = 1 THEN 1 ELSE 0 END) as correction_count,
        SUM(cache_creation_tokens) as total_cache_creation,
        SUM(cache_read_tokens) as total_cache_read,
        MAX(has_thinking) as any_thinking
      FROM messages WHERE session_id = ?
    `).get(sessionId) as {
      message_count: number
      max_timestamp: string | null
      error_count: number
      correction_count: number
      total_cache_creation: number | null
      total_cache_read: number | null
      any_thinking: number | null
    }

    const messageCount = msgStats.message_count
    const endedAt = messageCount > 0 ? msgStats.max_timestamp : startedAt
    const durationMinutes = messageCount > 0 && startedAt && endedAt
      ? Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000)
      : 0

    // Subagent count
    const saRow = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM subagents WHERE session_id = ?'
    ).get(sessionId) as { cnt: number }

    // Tool counts
    const toolRows = this.db.prepare(
      'SELECT tool_names FROM messages WHERE session_id = ? AND tool_names IS NOT NULL AND tool_names != \'\''
    ).all(sessionId) as { tool_names: string }[]

    const toolCounts: Record<string, number> = {}
    for (const row of toolRows) {
      for (const name of row.tool_names.split(',')) {
        const trimmed = name.trim()
        if (trimmed) {
          toolCounts[trimmed] = (toolCounts[trimmed] ?? 0) + 1
        }
      }
    }

    // Files changed
    const fcRows = this.db.prepare(
      'SELECT DISTINCT file_path, operation FROM file_changes WHERE session_id = ?'
    ).all(sessionId) as { file_path: string; operation: string }[]

    const filesChanged = fcRows.map(r => ({ path: r.file_path, op: r.operation }))

    // Topic generation
    const userMsgRows = this.db.prepare(
      "SELECT content_preview FROM messages WHERE session_id = ? AND role = 'user' AND content_preview != '' AND has_tool_use = 0 ORDER BY timestamp ASC LIMIT 5"
    ).all(sessionId) as Array<{ content_preview: string | null }>

    const candidates = userMsgRows
      .map(r => r.content_preview)
      .filter((t): t is string => t != null)

    const topic = generateTopic({
      userMessages: candidates,
      toolCounts,
      errorCount: msgStats.error_count,
    })

    // Distinct models used — from messages or from in-memory list
    const modelsUsed = messages
      ? [...new Set(messages.filter(m => m.model).map(m => m.model!))]
      : (() => {
          const rows = this.db.prepare(
            "SELECT DISTINCT model FROM messages WHERE session_id = ? AND model IS NOT NULL"
          ).all(sessionId) as { model: string }[]
          return rows.map(r => r.model)
        })()

    // Entrypoint — from first message that has one
    const entrypoint = messages
      ? messages.find(m => m.entrypoint)?.entrypoint
      : undefined

    // Update session row
    this.db.prepare(`
      UPDATE sessions SET
        ended_at = ?,
        duration_minutes = ?,
        message_count = ?,
        error_count = ?,
        correction_count = ?,
        subagent_count = ?,
        tool_counts = ?,
        files_changed = ?,
        topic = ?,
        total_cache_creation_tokens = ?,
        total_cache_read_tokens = ?,
        has_thinking = ?,
        models_used = ?,
        entrypoint = COALESCE(?, entrypoint)
      WHERE id = ?
    `).run(
      endedAt,
      durationMinutes,
      messageCount,
      errorsObservable ? msgStats.error_count : null,
      msgStats.correction_count,
      saRow.cnt,
      JSON.stringify(toolCounts),
      JSON.stringify(filesChanged),
      topic,
      msgStats.total_cache_creation ?? 0,
      msgStats.total_cache_read ?? 0,
      msgStats.any_thinking ?? 0,
      JSON.stringify(modelsUsed),
      entrypoint ?? null,
      sessionId,
    )
  }

  /**
   * Syncs session-level metadata (titles, tags, PR links, mode, worktree, etc.)
   * from JSONL metadata entries that the conversation parser skips.
   */
  private async syncSessionMetadata(sessionId: string, projectSlug?: string | null): Promise<void> {
    try {
      const metadata = await this.registry.getSessionMetadata(sessionId)
      if (!metadata) return

      // Update session columns. Use COALESCE for every nullable text field so a
      // missing value from this round never wipes a previously-stored one. For
      // `tags`, only overwrite when the adapter reports non-empty tags.
      const newTagsJson = metadata.tags.length > 0 ? JSON.stringify(metadata.tags) : null
      this.db.prepare(`
        UPDATE sessions SET
          custom_title = COALESCE(?, custom_title),
          ai_title = COALESCE(?, ai_title),
          tags = COALESCE(?, tags),
          mode = COALESCE(?, mode),
          worktree_branch = COALESCE(?, worktree_branch),
          speculation_time_saved_ms = COALESCE(?, speculation_time_saved_ms),
          branch = COALESCE(?, branch)
        WHERE id = ?
      `).run(
        metadata.customTitle ?? null,
        metadata.aiTitle ?? null,
        newTagsJson,
        metadata.mode ?? null,
        metadata.worktreeBranch ?? null,
        metadata.speculationTimeSavedMs > 0 ? metadata.speculationTimeSavedMs : null,
        metadata.gitBranch ?? null,
        sessionId,
      )

      // Sync PR links
      if (metadata.prLinks.length > 0) {
        this.db.prepare('DELETE FROM pr_links WHERE session_id = ?').run(sessionId)
        const insertPr = this.db.prepare(`
          INSERT INTO pr_links (session_id, pr_number, pr_url, pr_repository, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `)
        for (const pr of metadata.prLinks) {
          insertPr.run(sessionId, pr.prNumber, pr.prUrl, pr.prRepository, pr.timestamp)
        }
      }

      // Sync context collapses
      if (metadata.collapses.length > 0) {
        this.db.prepare('DELETE FROM context_collapses WHERE session_id = ?').run(sessionId)
        const insertCollapse = this.db.prepare(`
          INSERT INTO context_collapses (session_id, collapse_id, summary, first_archived_uuid, last_archived_uuid)
          VALUES (?, ?, ?, ?, ?)
        `)
        for (const c of metadata.collapses) {
          insertCollapse.run(sessionId, c.collapseId, c.summary, c.firstArchivedUuid, c.lastArchivedUuid)
        }
      }

      // Try to get cost data
      if (projectSlug) {
        const cost = await this.registry.getSessionCost(projectSlug, sessionId)
        if (cost !== undefined) {
          this.db.prepare('UPDATE sessions SET cost_usd = ? WHERE id = ?').run(cost, sessionId)
        }
      }
    } finally {
      // Always stamp the watermark so backfillMissingBranch makes progress
      // even when metadata is missing or unparseable. Without this stamp the
      // 50-row LIMIT pulls the same sessions every cycle forever.
      this.db.prepare('UPDATE sessions SET metadata_backfilled_at = ? WHERE id = ?')
        .run(new Date().toISOString(), sessionId)
    }
  }

  /** Short display preview — used in search results and topic generation. */
  private extractContentPreview(msg: NormalizedMessage): string {
    for (const block of msg.contentBlocks) {
      if (block.type === 'text' && block.text) {
        return block.text.slice(0, 500)
      }
    }
    // Fallback: show tool name if no text
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_use' && block.name) {
        return `[${block.name}]`
      }
    }
    return ''
  }

  /**
   * Full searchable text — all text blocks, tool names with inputs,
   * tool results with generous limits. This is what FTS indexes.
   */
  private extractSearchText(msg: NormalizedMessage): string {
    const parts: string[] = []

    for (const block of msg.contentBlocks) {
      if (block.type === 'text' && block.text) {
        // Full text blocks, no truncation
        parts.push(block.text)
      } else if (block.type === 'tool_use' && block.name) {
        // Tool name + full input params (capped at 2K per tool call)
        if (block.input && typeof block.input === 'object') {
          const inputStr = JSON.stringify(block.input)
          parts.push(`${block.name}: ${inputStr.slice(0, 2000)}`)
        } else {
          parts.push(block.name)
        }
      } else if (block.type === 'tool_result' && block.content) {
        // Tool results — generous limit (5K per result) to catch error messages,
        // file contents, command output. Most search-relevant content lives here.
        const content = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content)
        if (content.length > 0) {
          parts.push(content.slice(0, 5000))
        }
      }
      // Skip thinking blocks — not useful for search
    }

    return parts.join('\n')
  }

  private async updateWatermarks(sessionIds: readonly string[]): Promise<void> {
    // Delegate to the registry — each adapter owns its on-disk layout.
    // (Claude-code: ~/.claude/projects/<slug>/<id>.jsonl. Pi-code: ~/.pi/agent/sessions/...).
    // Without this, pi-code sessions stay at watermark 0 and get re-indexed every cycle.
    for (const sessionId of sessionIds) {
      const watermark = await this.registry.getSessionWatermark(sessionId)
      if (watermark !== undefined) {
        this.indexManager.updateSessionWatermark(sessionId, watermark)
      }
    }
  }

  /** One `SELECT id, source FROM sessions` per cycle — see finding B11. */
  private loadOwnerHints(): Map<string, string> {
    const rows = this.db.prepare('SELECT id, source FROM sessions').all() as Array<{ id: string; source: string }>
    const hints = new Map<string, string>()
    for (const row of rows) hints.set(row.id, row.source)
    return hints
  }

  /**
   * Resolves (and lazily creates) the canonical project row for a
   * session's real filesystem cwd, and records the (source, slug) ->
   * project_id alias (migration V7 — canonical project identity).
   *
   * The canonical id IS the normalized path: stable across sources, since
   * a claude slug (-home-kitty-foo), a pi slug (--home-kitty-foo--), an
   * opencode sha1, and a bare Codex cwd can all describe the same
   * directory and should collapse to the same project.
   */
  private resolveProjectId(cwd: string, source: string, sourceSlug: string): string {
    const projectId = cwd.length > 1 && cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
    this.db.prepare(
      'INSERT OR IGNORE INTO projects (id, path, first_seen_at) VALUES (?, ?, ?)'
    ).run(projectId, projectId, new Date().toISOString())
    if (sourceSlug) {
      this.db.prepare(
        'INSERT OR IGNORE INTO project_aliases (source, source_slug, project_id) VALUES (?, ?, ?)'
      ).run(source, sourceSlug, projectId)
    }
    return projectId
  }
}
