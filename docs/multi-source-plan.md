# Multi-source plan — Codex + opencode as first-class sources

Status: in progress (branch `multi-source-adapters`, 2026-08-18)

Goal: `session-history-mcp` indexes **four** agent transcript sources —
Claude Code, pi, Codex, opencode — with the same tools, the same freshness
pipeline, and automatic import for all of them.

## Decisions taken

1. **Removals go ahead.** `deep_analyze`, `get_audit_history`,
   `claude_md_effectiveness`, and `get_session.intent` are deleted; the
   `audit_watermarks` / `param-normalizers` machinery goes with them.
   `context_audit` keeps 3 of 6 metrics. LLM summarization in
   `FreshnessGuard` becomes opt-in (`ENABLE_LLM_SUMMARIES=1`).
2. **Sub-agent threads attach to their parent** (`subagents` table) and are
   excluded from `discoverSessions`; their messages are indexed under the
   parent session so they stay searchable.
3. **The index database moves** to `~/.local/share/session-history-mcp/index.db`,
   overridable via `SESSION_HISTORY_DB`. No migration needed — no index
   database exists on any machine yet.

## On-disk formats

### Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`

One JSONL per thread. Session id = the UUID tail of the filename, confirmed
by `session_meta.payload.session_id`.

| Rollout line | Maps to |
|---|---|
| `session_meta` | `SessionMeta` — `session_id`, `cwd`, `timestamp`, `originator`→entrypoint, `cli_version`→version |
| `response_item`/`message` | `NormalizedMessage`; roles `user`/`assistant`/`developer` (→`system`); content `[{type:"input_text"\|"output_text", text}]` |
| `response_item`/`reasoning` | thinking block — `encrypted_content` only, so `hasThinking=true` with no text |
| `response_item`/`function_call`, `custom_tool_call` | `tool_use` — `name`, `arguments` (JSON string) or `input` (JS source), id = `call_id` |
| `response_item`/`function_call_output`, `custom_tool_call_output` | `tool_result` joined on `call_id`; output is an array of text parts |
| `event_msg`/`token_count` | `TokenUsage` from `info.last_token_usage`; `cached_input_tokens`→cache read, `cache_write_input_tokens`→cache creation |
| `event_msg`/`patch_apply_end` | `FileChange[]` from `changes{path:{type:add\|update\|delete}}` → create/edit/delete |
| `compacted`, `event_msg`/`context_compacted` | `ContextCollapse` |
| `turn_context` | per-turn `model`, `cwd` |
| `session_meta.payload.thread_source.subagent.thread_spawn` | `SubagentMeta` on the parent (`parent_thread_id`, `agent_path`, `agent_nickname`, `depth`) |

No cost data exists in Codex rollouts — leave `costUsd` undefined.

### opencode — `~/.local/share/opencode/opencode.db` (SQLite, read-only)

| Table / row | Maps to |
|---|---|
| `project` | `ProjectMeta` — `worktree` is the real path |
| `session` | `SessionMeta` — `directory`→cwd, `title`, `agent`, `model` (JSON), `cost`, `tokens_*`, `time_created/updated` (epoch ms), `parent_id` |
| `message.data` | envelope — `role`, `modelID`, `providerID`, `tokens{}`, `time{}`, `error{}` |
| `part` `type=text` | text block |
| `part` `type=reasoning` | thinking block |
| `part` `type=tool` | `tool_use` (`tool`, `callID`, `state.input`) + `tool_result` (`state.output`); **`state.status==='error'` is an explicit error flag** |
| `part` `type=patch` | `FileChange[]` from `files[]` |
| `part` `type=compaction` | `ContextCollapse` |
| `part` `type=step-finish` | per-step `tokens{}` + `cost` |

Large tool outputs spill to `~/.local/share/opencode/tool-output/<callID>`.

## Phases

1. **Unblock the seam** — shared heuristics, session-id gate, watermark
   generalization, DB-backed ownership, canonical project identity (V7),
   per-source tool taxonomy. Plus the removals and the P0–P2 bug fixes.
2. **CodexAdapter** — `src/adapters/codex/`.
3. **OpencodeAdapter** — `src/adapters/opencode/`, opened read-only.
4. **Automatic import** — incremental parse resume from the stored watermark.
   A systemd user timer over `src/cli/sync.ts` was written and then dropped:
   `ensureFresh()` runs on every tool call regardless, so a timer only helps
   for sessions that fall quiet between runs and does nothing for one still
   being written — which is the case that actually costs. Resume is the fix.
5. **Cross-source features** — `source` filters, merged `list_projects`.

## Rules for every change

- ESM only, no `.js` import extensions, no default exports.
- `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; no `any`.
- Tests colocated (`foo.ts` → `foo.test.ts`); `npm run typecheck` and
  `npm test` must both pass.
- Never write to another agent's data store. Codex and opencode files are
  read-only inputs; opencode's SQLite is opened `{ readonly: true }`.
- No `Co-Authored-By` lines on commits (repo rule).
