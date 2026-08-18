#!/usr/bin/env tsx
/**
 * Read-only smoke run against whatever real agent stores exist on this
 * machine. Fixtures prove the parsers handle the shapes we wrote down; this
 * proves they handle the shapes actually on disk.
 *
 * It asserts counts and structure, never content — no transcript text is
 * printed, so the output is safe to paste into a report.
 *
 * Nothing here writes: adapters only read, and the index database is never
 * opened. Run it any time a format might have drifted:
 *
 *   npx tsx scripts/smoke-real-sources.ts
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeCodeAdapter } from '../src/adapters/claude-code'
import { PiCodeAdapter } from '../src/adapters/pi-code'
import { CodexAdapter } from '../src/adapters/codex'
import { OpencodeAdapter, defaultOpencodeDbPath } from '../src/adapters/opencode'
import type { SessionAdapter } from '../src/types'

interface SourceReport {
  readonly source: string
  readonly store: string
  projects: number
  sessions: number
  sampledSession: string | null
  messages: number
  toolUseBlocks: number
  toolResultBlocks: number
  thinkingBlocks: number
  errorTurns: number
  correctionTurns: number
  withTokenUsage: number
  fileChanges: number
  subagents: number
  watermark: number | null
  error: string | null
}

const MAX_MESSAGES = 5000

async function probe(adapter: SessionAdapter, store: string): Promise<SourceReport> {
  const r: SourceReport = {
    source: adapter.source, store,
    projects: 0, sessions: 0, sampledSession: null,
    messages: 0, toolUseBlocks: 0, toolResultBlocks: 0, thinkingBlocks: 0,
    errorTurns: 0, correctionTurns: 0, withTokenUsage: 0,
    fileChanges: 0, subagents: 0, watermark: null, error: null,
  }

  try {
    for await (const _p of adapter.discoverProjects()) r.projects++

    // Sample the most recently started session so the probe exercises the
    // current format rather than the oldest one on disk.
    let newest: { id: string; startedAt: string } | null = null
    for await (const s of adapter.discoverSessions()) {
      r.sessions++
      if (!newest || s.startedAt > newest.startedAt) newest = { id: s.id, startedAt: s.startedAt }
    }
    if (!newest) return r

    r.sampledSession = newest.id
    r.watermark = (await adapter.getSessionWatermark(newest.id)) ?? null

    for await (const m of adapter.getMessages(newest.id)) {
      if (++r.messages > MAX_MESSAGES) break
      if (m.isError) r.errorTurns++
      if (m.isCorrection) r.correctionTurns++
      if (m.tokenUsage && (m.tokenUsage.input_tokens > 0 || m.tokenUsage.output_tokens > 0)) r.withTokenUsage++
      for (const b of m.contentBlocks) {
        if (b.type === 'tool_use') r.toolUseBlocks++
        else if (b.type === 'tool_result') r.toolResultBlocks++
        else if (b.type === 'thinking') r.thinkingBlocks++
      }
    }
    for await (const _c of adapter.getFileChanges(newest.id)) r.fileChanges++
    for await (const _a of adapter.getSubagents(newest.id)) r.subagents++
  } catch (err) {
    r.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
  return r
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n)
}

async function main(): Promise<void> {
  const claudeDir = join(homedir(), '.claude')
  const piDir = process.env['PI_AGENT_DIR'] ?? join(homedir(), '.pi', 'agent')
  const codexDir = process.env['CODEX_DIR'] ?? join(homedir(), '.codex')
  const opencodeDb = process.env['OPENCODE_DB'] ?? defaultOpencodeDbPath()

  const reports = [
    await probe(new ClaudeCodeAdapter(claudeDir), claudeDir),
    await probe(new PiCodeAdapter(piDir), piDir),
    await probe(new CodexAdapter(codexDir), codexDir),
    await probe(new OpencodeAdapter(opencodeDb), opencodeDb),
  ]

  console.log(
    pad('source', 13) + pad('proj', 6) + pad('sess', 7) + pad('msgs', 7) +
    pad('use', 6) + pad('res', 6) + pad('think', 7) + pad('err', 6) +
    pad('corr', 6) + pad('usage', 7) + pad('files', 7) + pad('subs', 6) + 'watermark',
  )
  console.log('-'.repeat(96))
  for (const r of reports) {
    console.log(
      pad(r.source, 13) + pad(r.projects, 6) + pad(r.sessions, 7) + pad(r.messages, 7) +
      pad(r.toolUseBlocks, 6) + pad(r.toolResultBlocks, 6) + pad(r.thinkingBlocks, 7) +
      pad(r.errorTurns, 6) + pad(r.correctionTurns, 6) + pad(r.withTokenUsage, 7) +
      pad(r.fileChanges, 7) + pad(r.subagents, 6) + (r.watermark ?? '-'),
    )
    if (r.error) console.log(`  ${r.source}: ERROR ${r.error}`)
  }

  const dead = reports.filter(r => r.sessions > 0 && r.messages === 0)
  if (dead.length > 0) {
    console.log('\nsources that found sessions but parsed no messages: ' + dead.map(d => d.source).join(', '))
    process.exitCode = 1
  }
  const failed = reports.filter(r => r.error !== null)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
