export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageType = 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot' | 'queue-operation'

export interface ContentBlock {
  readonly type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  readonly text?: string | undefined
  readonly id?: string | undefined
  readonly name?: string | undefined
  readonly input?: unknown | undefined
  readonly tool_use_id?: string | undefined
  readonly content?: unknown | undefined
  readonly thinking?: string | undefined
  readonly signature?: string | undefined
  /**
   * Explicit error flag for `tool_result` blocks (finding B17), populated
   * from the source's own signal (claude: `is_error`, pi: `isError`).
   * Lets a caller expanding a turn with multiple tool results tell WHICH
   * one failed. `undefined` for non-tool_result blocks, or when the source
   * gave no explicit signal.
   */
  readonly isError?: boolean | undefined
}

export interface TokenUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_creation_input_tokens?: number | undefined
  readonly cache_read_input_tokens?: number | undefined
}

export interface NormalizedMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: MessageRole
  readonly timestamp: string
  readonly contentBlocks: readonly ContentBlock[]
  readonly model?: string | undefined
  readonly tokenUsage?: TokenUsage | undefined
  readonly toolNames?: readonly string[] | undefined
  readonly isError: boolean
  readonly isCorrection: boolean
  readonly hasThinking: boolean
  readonly requestId?: string | undefined
  readonly parentUuid?: string | null | undefined
  readonly uuid: string
  readonly cwd?: string | undefined
  readonly gitBranch?: string | undefined
  readonly entrypoint?: string | undefined
}

export interface SessionMeta {
  readonly id: string
  readonly source: string
  readonly projectSlug: string
  readonly cwd: string
  readonly branch?: string | undefined
  readonly startedAt: string
  readonly endedAt?: string | undefined
  readonly durationMinutes?: number | undefined
  readonly model?: string | undefined
  readonly totalTokens?: number | undefined
  readonly totalTurns?: number | undefined
  readonly messageCount?: number | undefined
  readonly errorCount?: number | undefined
  readonly correctionCount?: number | undefined
  readonly subagentCount?: number | undefined
  readonly toolCounts?: Record<string, number> | undefined
  readonly filesChanged?: ReadonlyArray<{ readonly path: string; readonly op: string }> | undefined
  readonly topic?: string | undefined
  readonly summary?: string | undefined
  readonly summaryGeneratedAt?: string | undefined
  readonly summaryText?: string | undefined
  readonly version?: string | undefined
  readonly customTitle?: string | undefined
  readonly aiTitle?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly costUsd?: number | undefined
  readonly mode?: 'coordinator' | 'normal' | undefined
  readonly entrypoint?: string | undefined
}

export interface SessionMetadataEntry {
  readonly type: string
  readonly sessionId: string
  readonly timestamp?: string | undefined
  readonly data: Record<string, unknown>
}

export interface PrLink {
  readonly sessionId: string
  readonly prNumber: number
  readonly prUrl: string
  readonly prRepository: string
  readonly timestamp: string
}

export interface ContextCollapse {
  readonly sessionId: string
  readonly collapseId: string
  readonly summary: string
  readonly firstArchivedUuid: string
  readonly lastArchivedUuid: string
}

export interface SubagentMeta {
  readonly id: string
  readonly sessionId: string
  readonly agentType?: string | undefined
  readonly description?: string | undefined
  readonly totalTokens?: number | undefined
  readonly totalTools?: number | undefined
  readonly durationMs?: number | undefined
  readonly model?: string | undefined
}

export interface FileChange {
  readonly sessionId: string
  readonly messageId?: string | undefined
  readonly filePath: string
  /**
   * `delete` is emitted by sources that record removals explicitly (Codex's
   * `patch_apply_end.changes[path].type === 'delete'`). Sources that cannot
   * distinguish a removal never emit it — absence means "not observed", not
   * "did not happen".
   */
  readonly operation: 'read' | 'write' | 'edit' | 'create' | 'delete'
  readonly timestamp: string
}
