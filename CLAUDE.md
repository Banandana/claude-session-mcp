# Session History MCP Server

MCP server for interfacing with Claude session history. First-class LLM-optimized access through functions designed for efficiency and minimal context consumption.

## Tech Stack & Constraints

- **Language**: TypeScript (strict mode)
- **Module system**: ESM only — no CommonJS, no `.js` extensions on imports
- **No transpiling**: Use `tsx` or similar for direct execution — no build step producing `.js` artifacts
- **SDK**: Official `@modelcontextprotocol/sdk` for MCP protocol implementation
- **DI**: `inversify` with `reflect-metadata` for dependency injection and annotation processing
- **Runtime**: Node.js LTS

## Architecture Rules

- **Rich indexing** — All data returned by MCP tools must be self-describing and immediately useful to the caller. Compute metrics, summaries, and labels at index time. Never return raw IDs where human-readable labels can be derived. The caller should never need a follow-up query to understand what a result represents.
- **1200 line max per file** — split before you hit the limit, not after
- **Componentized and layered** — clear separation of concerns across layers
- **DI-based services** — all services registered and resolved through inversify containers
- **Type/Interface/Contract separation** — types and interfaces live in dedicated files, not mixed with business logic
- **Business logic isolation** — pure logic separated from infrastructure, transport, and framework concerns
- **Testing at each level** — unit tests for logic, integration tests for services, e2e tests for MCP tool endpoints

## Code Style

- Modern TypeScript idioms — use `satisfies`, `const` assertions, template literal types where appropriate
- No `any` — use `unknown` and narrow, or define proper types
- Barrel exports via `index.ts` per module
- Prefer `interface` over `type` for object shapes that may be extended
- Use `readonly` by default on properties and arrays
- Named exports only — no default exports

## File Organization

```
src/
  types/           # Shared types, interfaces, contracts
  services/        # Business logic services (DI-managed)
  tools/           # MCP tool definitions and handlers
  resources/       # MCP resource definitions
  infrastructure/  # Database, file system, external integrations
  container/       # inversify container setup and module registration
  server.ts        # MCP server bootstrap
```

## Testing

- Test files colocated next to source: `foo.ts` -> `foo.test.ts`
- Use `vitest` for test runner
- Mock only at DI boundaries — inject test doubles through the container
- No mocking file system or database in integration tests unless explicitly discussed

## Import Conventions

- No `.js` extensions on TypeScript imports
- Use path aliases if configured (e.g., `@/services/...`)
- Group imports: node builtins, external packages, internal modules (separated by blank lines)

## Development

```bash
npm run dev          # Hot-reload MCP server via tsx --watch
npm run start        # Run MCP server
npm test             # Run all tests
npm run test:watch   # Watch mode tests
```

### MCP Configuration

Add to `~/.claude/settings.local.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "session-history": {
      "command": "npx",
      "args": ["tsx", "/data/claude-session-mcp/src/server.ts"]
    }
  }
}
```

### Stop-hook auto-indexing (optional)

To keep the index warm without waiting for the next MCP tool call, wire
`src/cli/sync.ts` as a Stop hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "npx tsx /data/claude-session-mcp/src/cli/sync.ts"
      }]
    }]
  }
}
```

The CLI is idempotent and fast (~100ms) when nothing changed. It reuses the
same `FreshnessGuard` pipeline as MCP tool calls.

### Available Tools (13)

| Tool | Purpose |
|------|---------|
| `list_projects` | All known projects with metadata |
| `get_project` | Project detail — CLAUDE.md, settings, memory, stats |
| `list_sessions` | Sessions filtered by project/date/branch/tokens/cost/cache/toolNames — includes title, cost, mode, tags, models used |
| `get_session` | Session detail — metadata, turns, files, subagents, PR links, cache stats, context collapses, token curve (opt-in via `sections`, positions resolved from stored collapse anchors) |
| `get_conversation` | Session overview — phase-clustered activity timeline with cost and cache data |
| `query_turns` | Search turns by tool name, error status, text pattern, time range (supports `compact` mode) |
| `get_turns` | Full content for specific turns — tool inputs, outputs, text, thinking blocks (opt-in), per-turn model and cache tokens |
| `search` | FTS5 full-text search across all sessions — indexes full message content, hyphen-safe, returns role/toolNames/turnIndex |
| `semantic_search` | Vector KNN search via sqlite-vec — finds paraphrased matches FTS misses. Requires EMBEDDING_MODEL env var |
| `get_changes` | File operations tracked across sessions |
| `get_memory` | Cross-project memory access |
| `analyze` | Pattern discovery — errors, corrections, tool failures, cache efficiency, model usage |
| `context_audit` | Context usage auditing — cost breakdown, cache analysis, collapse tracking |

### Semantic Search Configuration

`semantic_search` is opt-in. Set these on the MCP server environment:

- `EMBEDDING_MODEL` (required) — e.g., `BAAI/bge-m3`
- `EMBEDDING_URL` (optional) — defaults to the chat base URL
- `EMBEDDING_DIM` (optional) — defaults to 1024; must match the model

Indexing runs fire-and-forget after each `ensureFresh()` cycle, bounded to 500
messages per cycle. The `message_embeddings` vec0 table is created lazily on
first use and will automatically drop+rebuild on dimension mismatch.

## Git Rules

- **Never add Co-Authored-By lines** — no Claude co-author tags on commits

## Conversation Navigation (2026-04-01)

Replaced monolithic `get_conversation` with a three-tool navigation flow:

- **`get_conversation`** — Phase-clustered overview. Groups turns by activity category (Error > Modify > Execute > Explore > Discuss). `maxTokens` merges phases and truncates lists to fit budget.
- **`query_turns`** — Structured search within a session (JSONL) or across sessions (DB). Filters: `toolNames`, `isError`, `isCorrection`, `roles`, `textPattern` (single-session only), `timeRange`, `turnRange`. Cross-session queries use `turn_events` DB table with lazy backfill.
- **`get_turns`** — Full content expansion by turn ID or index range (max 50). 4-stage truncation when `maxTokens` set: tool_result content → tool_use input → text blocks → drop middle turns.

Supporting infrastructure:
- `turn_events` table (V2 migration) — per-turn structured data indexed during sync
- `TurnIndexer` service — populates turn_events, integrated into FreshnessGuard sync pipeline
- `PhaseClusterer` service — groups consecutive turns by activity category with singleton absorption
- Removed: `conversation-distiller.ts`, `Focus` type, `filterByWindow`

## Session Metadata Ingestion (2026-04-02)

Full gap closure between Claude Code output and session-mcp ingestion. New `MetadataParser` extracts JSONL entry types the conversation parser skips:

- **Session titles**: `custom-title`, `ai-title` → prefer over auto-generated topics
- **Tags**: user-applied searchable labels
- **PR links**: `pr-link` → new `pr_links` table, connects sessions to shipped work
- **Mode**: `coordinator` / `normal` for multi-agent sessions
- **Context collapses**: `marble-origami-commit` → new `context_collapses` table
- **Worktree state**, **speculation timing**, **task summaries**

Per-message enrichment:
- **Cache tokens**: `cache_creation_input_tokens`, `cache_read_input_tokens` stored per message and aggregated per session
- **Model tracking**: `models_used` JSON array on sessions (sessions can use multiple models)
- **Thinking presence**: `has_thinking` flag, opt-in retrieval via `includeThinking` param on `get_turns`
- **Entry point**: `cli`, `sdk-ts`, `sdk-py`, etc.
- **Git branch / CWD**: extracted per-message (stored session-level)

Schema: V3 migration (12 new session columns, 3 message columns, 2 new tables)

## Full-Text Search (2026-04-02)

FTS indexes full message content, not truncated previews:
- Text blocks: no truncation
- Tool inputs: full JSON up to 2K per call (file paths, commands, patterns searchable)
- Tool results: up to 5K per result (error messages, command output, file contents)
- `content_preview` (500 chars) kept for display; `search_text` (full) used for FTS
- Search results include `matchSnippet` with `»highlighted«` context
- Schema: V4 migration (adds `search_text` column, rebuilds FTS table, forces re-index)

## LLM Client Architecture

Single backend: `OpenAiLlmClient` — OpenAI-compatible HTTP against `LOCAL_LLM_URL` (default `http://localhost:30000/v1`, currently Qwen3.5-122B-A10B-AWQ on SGLang with 524K context). Used for background summarization (FreshnessGuard). The Anthropic remote backend was removed. `deep_analyze` (whole-session LLM analysis) and `get_session`'s `intent` param (intent-triggered LLM relevance check) were removed 2026-08-18 — sending a full transcript to a shared local inference server is worse than the caller doing its own `get_conversation` + `get_turns` drill-down.

## Efficiency Fixes (2026-04-02)

- **FTS indexing**: Uses `lastInsertRowid` from INSERT instead of N+1 SELECT queries per message
- **Session discovery**: Set-based lookup with early exit once all needed sessions found
- **FTS updates**: `INSERT OR REPLACE` instead of DELETE + INSERT
- **Byte offset**: Removed double-update hack (no more `MAX_SAFE_INTEGER` placeholder)
- **Migration safety**: Wrapped in transactions — version only bumps on success; `addColumnIfMissing` handles race conditions via try-catch
- **query_turns dedup**: Extracted `parseToolNames()` and `summarizeFromDbRow()` helpers to eliminate duplicated summary logic in cross-session queries
- **Type safety**: `TurnReference.role` and `ExpandedTurn.role` typed as `MessageRole` instead of `string`
- **Summarization**: Fire-and-forget promise now has `.catch()` to prevent unhandled rejections

## Context Usage Auditing (2026-04-06, trimmed 2026-08-18)

`context_audit` tool with 3 metrics for first-class context usage analysis:

- **cost_breakdown**: Total/avg cost, min/max sessions, temporal trends
- **cache_analysis**: Cache hit ratios, creation vs read trends
- **collapse_analysis**: Context collapse frequency and details

Removed 2026-08-18: `token_attribution` (structurally broken — it sums
`messages.token_count` over `role='user'` rows, but user/tool-result lines in
these transcripts carry no `usage` block at all — verified 0 of 3917 user
lines have usage vs 6298 of 6298 assistant lines — so it returned zero for
every session, and isn't repairable without a new indexed column),
`context_utilization` and `session_profile` (near-duplicates of
`list_sessions` and `get_session`).

All metrics support `detail=summary|full`, temporal `groupBy`, and filters (project, date range, token range, cost range, cache hit ratio, model).

`list_sessions` enhanced with: `minTokens`, `maxTokens`, `minCost`, `maxCost`, `minCacheHitRatio`, `maxCacheHitRatio` filters; `cost` and `cache_efficiency` sort options; `cacheTokens` and `contextCollapseCount` in medium output.

`get_session` enhanced with: `cacheTokens.hitRatio` and `tokenAccumulation` at metadata level; `contextCollapses` array and `tokenCurve` at full level.

Phase 1 limitation: `token_count` = input+output combined; true context utilization % deferred to Phase 2 when `input_tokens`/`output_tokens` are stored separately.

## Tool-Invocation Log (2026-04-27, trimmed 2026-08-18)

V5 migration added `tool_invocations` — raw firehose, one row per MCP call.
Stores `tool_name`, `params_json`, `params_hash`, `called_at`, `duration_ms`,
`result_status` ('ok'|'error'), `result_size`, `caller_session`,
`project_path`. No result content stored, only byte size.

Recording is automatic via `instrumentDispatch()` in `server.ts` — wraps
`server.tool` so every handler is timed and logged. Logging failures are
swallowed (stderr only) so telemetry can never break a real call.

Removed 2026-08-18: the `audit_watermarks` materialized view, its
`services/param-normalizers/` normalizers, the `get_audit_history` tool, and
`get_project`'s `recentAudits` block — the "when did I last audit X" feature
built on top of the raw firehose. `tool_invocations` itself is kept as cheap,
unopinionated call telemetry; `ToolInvocationLogger` now only inserts into it.

## Recently Fixed (2026-03-31)

All issues from `docs/handoff-fix-analyze-and-conversation-quality.md` are resolved:

- **P0 `corrections`**: Heuristic detection via negation patterns, correction keywords, ALL CAPS. Tool results excluded.
- **P0 `tool_failures`**: Tool names propagated from `tool_use` to `tool_result` error messages via `tool_use_id` resolution. SQL simplified.
- **P1 Session summaries**: `get_session` with `detail=metadata` now returns `computedSummary` with firstUserMessage, lastUserMessage, errorCount, correctionCount, toolsUsed, durationMinutes, subagentCount.
- **P2 Error window**: Thinking blocks stripped, tool_use input collapsed to key params, tool_result error text extracted.
- **P3 Subagent metadata**: `subagent-parser.ts` now parses `agent-*.jsonl` for totalTokens, totalTools, durationMs, model.
