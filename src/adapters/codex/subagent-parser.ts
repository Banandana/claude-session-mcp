import type { SubagentMeta } from '../../types'
import { streamJsonlLines } from '../../infrastructure/file-system'
import type { CodexSessionDiscovery } from './session-discovery'
import { firstTextFromContent } from './content-utils'

interface CodexTopLine {
  readonly timestamp?: string
  readonly type?: string
  readonly payload?: unknown
}

interface CodexTurnContextPayload {
  readonly model?: string
}

interface CodexResponseItemPayload {
  readonly type?: string
  readonly role?: string
  readonly content?: unknown
}

interface CodexTokenCountPayload {
  readonly type?: string
  readonly info?: {
    readonly total_token_usage?: {
      readonly total_tokens?: number
    }
  }
}

interface ChildStats {
  readonly firstUserText: string | undefined
  readonly totalTokens: number | undefined
  readonly model: string | undefined
  readonly durationMs: number | undefined
}

async function computeChildStats(path: string): Promise<ChildStats> {
  let firstUserText: string | undefined
  let totalTokens: number | undefined
  let model: string | undefined
  let firstTimestamp: string | undefined
  let lastTimestamp: string | undefined

  for await (const { line } of streamJsonlLines(path)) {
    let parsed: CodexTopLine
    try {
      parsed = JSON.parse(line) as CodexTopLine
    } catch {
      continue
    }

    if (typeof parsed.timestamp === 'string') {
      if (!firstTimestamp) firstTimestamp = parsed.timestamp
      lastTimestamp = parsed.timestamp
    }

    if (parsed.type === 'turn_context' && !model) {
      const m = (parsed.payload as CodexTurnContextPayload | undefined)?.model
      if (typeof m === 'string') model = m
      continue
    }

    if (parsed.type === 'response_item') {
      const p = parsed.payload as CodexResponseItemPayload | undefined
      if (p?.type === 'message' && p.role === 'user' && !firstUserText) {
        firstUserText = firstTextFromContent(p.content)
      }
      continue
    }

    if (parsed.type === 'event_msg') {
      const p = parsed.payload as CodexTokenCountPayload | undefined
      if (p?.type === 'token_count') {
        const total = p.info?.total_token_usage?.total_tokens
        if (typeof total === 'number') totalTokens = total
      }
      continue
    }
  }

  const durationMs =
    firstTimestamp && lastTimestamp
      ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
      : undefined

  return { firstUserText, totalTokens, model, durationMs }
}

/**
 * Codex sub-agent threads are separate rollout files (child sessions detected via `session_meta.payload.thread_source === "subagent"`, spawn record on `payload.source`),
 * not a `agent-*.jsonl` sidecar like claude-code. One SubagentMeta per
 * child rollout of the given parent session id.
 */
export class CodexSubagentParser {
  constructor(private readonly discovery: CodexSessionDiscovery) {}

  async *getSubagents(parentSessionId: string): AsyncIterable<SubagentMeta> {
    for await (const { path, header } of this.discovery.findChildRollouts(parentSessionId)) {
      const stats = await computeChildStats(path)

      yield {
        id: header.sessionId,
        sessionId: header.sessionId,
        agentType: header.threadSpawn?.agentPath ?? header.threadSpawn?.agentNickname,
        description: stats.firstUserText,
        totalTokens: stats.totalTokens,
        durationMs: stats.durationMs,
        model: stats.model,
      }
    }
  }
}
