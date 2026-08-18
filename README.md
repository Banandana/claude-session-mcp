# Session History MCP

> **Note:** This project is not guaranteed to be maintained. Use at your own discretion.

An MCP server that gives Claude introspective access to its own session history.

## What This Is

Claude Code writes a detailed transcript of every conversation — every tool call, every edit, every error, every correction — as append-only JSONL files. This data is rich, structured, and completely invisible to Claude in future sessions. It can't learn from what went wrong yesterday. It can't see patterns across projects. It doesn't know which tools fail most, which files get rewritten repeatedly, or which kinds of tasks spiral into correction loops.

This server makes that data accessible. It indexes Claude Code's session transcripts into a queryable database and exposes them through MCP tools that Claude can call mid-conversation. The result: Claude can examine its own track record, spot patterns in its behavior, and apply lessons from past sessions to current work.

## Why

The premise is simple: an agent that can observe its own history is a better agent.

Without session history access, every conversation starts from zero. Claude has no memory of the debugging session that took 400 turns because of a misunderstood API. No awareness that a particular MCP tool fails 30% of the time. No record that the user prefers bundled PRs over split ones, beyond what's manually written into memory files.

With it, Claude can:

- **Learn from failures** — surface sessions with high error rates, see what went wrong, avoid repeating it
- **Track patterns** — which files get edited most, which tools cause the most errors, which projects have the most correction cycles
- **Understand context** — when a user says "do it like last time," Claude can actually look at last time
- **Self-improve** — identify its own behavioral patterns and adjust

This is the feedback loop that makes autonomous agents viable long-term. Not just doing tasks, but getting observably better at doing tasks.

## What It Does Best

**Cross-session pattern discovery.** The `analyze` tool surfaces aggregate patterns — error-prone sessions, frequently failing tools, hot files, costly sessions — across all projects. This is data no single session could produce.

**Structured conversation navigation.** Rather than dumping raw transcripts, conversations are exposed through a three-layer drill-down: phase-clustered overview (`get_conversation`) → filtered turn search (`query_turns`) → full content expansion (`get_turns`). This keeps context usage minimal — Claude reads only what it needs.

**Full-text search across all history.** The `search` tool runs FTS5 queries across every indexed session. Find when something was discussed, what was decided, what was tried.

**Project-level intelligence.** `get_project` and `list_sessions` provide project-scoped views — CLAUDE.md contents, memory entries, session timelines, branch activity — giving Claude a bird's-eye view before diving into specifics.

## Philosophy

**Designed for LLM consumption, not human browsing.** Every tool returns structured, token-efficient data. Phase clustering compresses a 200-turn session into 5-8 phases. Token budgets truncate content intelligently. The caller never gets more than it asked for.

**Index once, query fast.** Session transcripts are parsed and indexed into SQLite on first access. Subsequent queries hit the index. Re-indexing is incremental — only new/changed sessions are re-processed.

**Read-only by design.** This server observes history. It doesn't modify transcripts, inject data, or alter session state. The source of truth is always Claude Code's raw JSONL files.

**Adapter-based architecture.** The core is source-agnostic. Four coding-agent transcript formats are indexed today — `claude-code`, `pi-code`, `codex`, `opencode` — through the same tools, the same freshness pipeline, and automatic import for all of them. Every session row carries a `source` column; every project is identified by its canonical real filesystem path, not by any one adapter's slug encoding, so the same repository worked on by several agents shows up as one project. See [Sources](#sources) below for exactly which fields each adapter populates.

## Tools

13 tools, covering lookup, navigation, search, and cross-session analysis:

| Tool | What it does |
|------|-------------|
| `list_projects` | All known projects with session counts, memory presence, branch activity — one entry per canonical path, merged across sources with a per-source breakdown |
| `get_project` | Project deep-dive — CLAUDE.md, settings, memory entries, session list spanning every source that has touched the project |
| `list_sessions` | Sessions filtered by project, date, branch, source, with sorting |
| `get_session` | Session metadata at three detail levels: summary, metadata (tools/files/subagents), full (context collapses, opt-in token curve) |
| `get_conversation` | Phase-clustered session overview — groups turns by activity (Explore → Modify → Execute → Error) |
| `query_turns` | Search turns by tool name, error/correction status, text pattern, time range; cross-session queries also filter by source |
| `get_turns` | Full content expansion for specific turns — tool inputs, outputs, text, token usage |
| `search` | Full-text search across all indexed sessions, filterable by source |
| `semantic_search` | Vector KNN search via sqlite-vec — finds paraphrased matches FTS misses (opt-in, requires `EMBEDDING_MODEL`) |
| `get_changes` | File operations tracked across sessions — which files were created/edited when |
| `get_memory` | Cross-project memory access — user preferences, feedback, project notes |
| `analyze` | Aggregate pattern discovery — errors, corrections, tool failures, costly sessions, hot files — filterable by source |
| `context_audit` | Context usage auditing — cost breakdown, cache analysis, collapse tracking |

## Sources

Every session row carries a `source` column. `list_sessions`, `search`, `analyze`, and the cross-session (project-scoped) branch of `query_turns` accept an optional `source` filter — a single value or an array, OR-matched, e.g. `"codex"` or `["claude-code", "opencode"]`. `list_projects` and `get_project` go further: they group sessions onto the project's canonical real filesystem path (via the `projects`/`project_aliases` tables) so one repository worked on by three agents shows up as one project with a per-source breakdown, instead of three unrelated entries in three different slug encodings.

### Field availability by source

Not every source's transcript format carries every field a tool can ask for. Rather than a silent `null`, the gap is documented here and called out in the `.describe()` of the tools it bites. Every row below describes what the adapters populate today, confirmed by indexing this machine's real stores (213 sessions across all four sources).

| Field | claude-code | pi-code | codex | opencode |
|---|---|---|---|---|
| **Tool-failure signal** (`error_count`, `isError`) | Yes — `tool_result.is_error` | Yes — `toolResult.isError` | **None — `error_count` is `NULL`, not 0.** Codex tool outputs carry only `type`/`id`/`call_id`/`output`, and every `patch_apply_end` observed reported `success: true`. A failure is visible only as prose inside the output text, and trusting that text is exactly what inflated error counts 175% (see below). A `0` here would read as "Codex never fails"; `NULL` reads as "not observable" | Yes — `state.status === 'error'` |
| Per-session cost (`cost_usd`) | Real, but only for the single most-recently-active session per project (a `.config.json` snapshot, not a ledger — older sessions read `NULL`) | Never — the adapter always reports no cost; Pi's own `usage.cost.total` per message is parsed but never aggregated to session level | Never — no cost data exists in Codex rollouts | Real, per session — mapped directly from opencode's `session.cost` column |
| PR links | Yes — `pr-link` JSONL entries → `pr_links` table | No | No (not in the mapping) | No (not in the mapping) |
| Context-collapse metadata | Yes — `marble-origami-commit` entries → `context_collapses` table | No | Yes — `compacted` / `event_msg:context_compacted` → `ContextCollapse` | Yes — `part type=compaction` → `ContextCollapse` |
| Per-message cache tokens | Yes | Yes — `cacheRead`/`cacheWrite` → `cache_creation_input_tokens`/`cache_read_input_tokens` | Yes — `event_msg:token_count` (`cached_input_tokens`/`cache_write_input_tokens`) | Yes — `part type=step-finish` `tokens{}` |
| Thinking-block presence (`hasThinking`) | Yes, with text | Yes, with text | Flag only — `reasoning` payloads are `encrypted_content`, so there is no readable text to return | Yes, with text — `part type=reasoning` |
| Subagents | Yes — `agent-*.jsonl` via `subagent-parser` | No — pi has no `agent-*.jsonl` files | Yes — child rollouts (`source.subagent.thread_spawn`) attach to their parent; 85 of this machine's 123 rollouts are children | Yes — child sessions (`session.parent_id`) attach to their parent |
| Model tracking (`models_used`) | Yes | Yes — `model_change` events | Yes — per-turn model from `turn_context` | Yes — `session.model` |

This means, for example: `analyze`'s `costly_sessions` metric ranks `codex` and `pi-code` sessions purely by token count (their `cost_usd` is always `NULL`), and `list_sessions`' `minCost`/`maxCost` filters silently exclude every `codex` and `pi-code` session. `context_audit`'s cost-based metrics carry the same `cost_usd` gap. Likewise, `analyze`'s error metrics and `query_turns`' `isError` filter cannot see Codex failures at all — not because Codex does not fail, but because its transcript format never records that it did.

**On error counts generally.** `isError` is set from a source's explicit failure flag and nothing else. It is deliberately NOT inferred from result text: a tool result reading `0 errors reported`, a `grep` for the word, or a command writing to `stderr` while exiting cleanly are all successes. Measured on one real session, the previous text-matching heuristic flagged 286 turns as errors where only 104 tool results actually carried `is_error` — a 175% inflation that fed every error metric in the product.

## Setup

Add to your MCP configuration (`~/.claude.json`):

```json
{
  "mcpServers": {
    "session-history": {
      "command": "npx",
      "args": ["tsx", "/path/to/session-history-mcp/src/server.ts"]
    }
  }
}
```

```bash
npm install    # Install dependencies
npm run dev    # Hot-reload development server
npm test       # Run tests
```
