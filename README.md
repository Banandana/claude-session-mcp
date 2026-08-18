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

**Adapter-based architecture.** The core is source-agnostic. Claude Code is the first (and currently only) adapter, but the system is designed to index session data from any source that produces structured transcripts.

## Tools

13 tools, covering lookup, navigation, search, and cross-session analysis:

| Tool | What it does |
|------|-------------|
| `list_projects` | All known projects with session counts, memory presence, branch activity |
| `get_project` | Project deep-dive — CLAUDE.md, settings, memory entries, session list |
| `list_sessions` | Sessions filtered by project, date, branch, with sorting |
| `get_session` | Session metadata at three detail levels: summary, metadata (tools/files/subagents), full (context collapses, opt-in token curve) |
| `get_conversation` | Phase-clustered session overview — groups turns by activity (Explore → Modify → Execute → Error) |
| `query_turns` | Search turns by tool name, error/correction status, text pattern, time range |
| `get_turns` | Full content expansion for specific turns — tool inputs, outputs, text, token usage |
| `search` | Full-text search across all indexed sessions |
| `semantic_search` | Vector KNN search via sqlite-vec — finds paraphrased matches FTS misses (opt-in, requires `EMBEDDING_MODEL`) |
| `get_changes` | File operations tracked across sessions — which files were created/edited when |
| `get_memory` | Cross-project memory access — user preferences, feedback, project notes |
| `analyze` | Aggregate pattern discovery — errors, corrections, tool failures, costly sessions, hot files |
| `context_audit` | Context usage auditing — cost breakdown, cache analysis, collapse tracking |

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
