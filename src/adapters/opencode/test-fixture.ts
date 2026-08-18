import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const FIXTURE_SQL_PATH = join(__dirname, '../../../fixtures/opencode/fixture.sql')

/**
 * Builds a throwaway SQLite file from `fixtures/opencode/fixture.sql` and
 * returns its path. Every opencode adapter test points at this instead of
 * the real `~/.local/share/opencode/opencode.db` — tests must never touch
 * that file. Not itself a `*.test.ts` file, so vitest won't try to run it
 * as a suite.
 */
export function buildFixtureDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-adapter-test-'))
  const dbPath = join(dir, 'opencode.db')
  const db = new Database(dbPath)
  db.exec(readFileSync(FIXTURE_SQL_PATH, 'utf-8'))
  db.close()
  return dbPath
}

export interface SpillFixture {
  readonly dbPath: string
  readonly sessionId: string
  /** Tool part whose `state.metadata.outputPath` resolves to a real file. */
  readonly resolvedCallId: string
  readonly resolvedOutputPath: string
  readonly resolvedFullText: string
  readonly resolvedInlineText: string
  /** Tool part whose `state.metadata.outputPath` names a file that was never written. */
  readonly missingCallId: string
  readonly missingOutputPath: string
  readonly missingInlineText: string
}

/**
 * Extends buildFixtureDb() with a second, isolated session carrying two
 * `tool` parts that exercise the verified opencode spill-file wire format
 * (`state.metadata.truncated===true` + absolute `state.metadata.outputPath`)
 * — one where the file genuinely exists, one where it doesn't. Kept in a
 * session of its own (`ses_spill...`) so it never disturbs the block-order/
 * count assertions the other tests make against the shared fixture's
 * `ses_parent...`/`ses_child...` sessions. `fixtures/opencode/fixture.sql`
 * itself is left untouched — shared with another agent's work.
 */
export function buildFixtureDbWithSpillCases(): SpillFixture {
  const dbPath = buildFixtureDb()

  const spillDir = mkdtempSync(join(tmpdir(), 'opencode-spill-test-'))
  const resolvedOutputPath = join(spillDir, 'tool-output-full.txt')
  const resolvedFullText = 'FULL SPILLED OUTPUT LINE\n'.repeat(2000)
  writeFileSync(resolvedOutputPath, resolvedFullText, 'utf-8')

  // Never written — exercises the missing-spill-file fallback.
  const missingOutputPath = join(spillDir, 'never-written-output.txt')

  const sessionId = 'ses_spill00000000000000003'
  const resolvedCallId = 'call_spill_resolved_1'
  const missingCallId = 'call_spill_missing_1'
  const resolvedInlineText = `...output truncated...\n\nFull output saved to: ${resolvedOutputPath}`
  const missingInlineText = `...output truncated...\n\nFull output saved to: ${missingOutputPath}`

  const db = new Database(dbPath)
  db.prepare(
    `INSERT INTO session (
       id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url,
       summary_additions, summary_deletions, summary_files, summary_diffs, metadata,
       cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
       revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived
     ) VALUES (?, 'proj_alpha_sha1', NULL, NULL, 'spill-case', '/home/test/project-alpha', '', 'Spill-file regression', '1.18.16', NULL,
       NULL, NULL, NULL, NULL, NULL,
       0, 0, 0, 0, 0, 0,
       NULL, NULL, 'build', NULL, ?, ?, NULL, NULL)`,
  ).run(sessionId, 1787001000000, 1787001100000)

  const messageId = 'msg_spill_0000000000000001'
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    messageId,
    sessionId,
    1787001010000,
    1787001020000,
    JSON.stringify({
      role: 'assistant',
      modelID: 'zai-glm-4.7',
      providerID: 'cerebras',
      time: { created: 1787001010000, completed: 1787001020000 },
    }),
  )

  const insertPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  )

  insertPart.run(
    'prt_spill_0000000000000001',
    messageId,
    sessionId,
    1787001011000,
    1787001012000,
    JSON.stringify({
      type: 'tool',
      tool: 'bash',
      callID: resolvedCallId,
      state: {
        status: 'completed',
        input: { command: 'produce-a-lot-of-output' },
        output: resolvedInlineText,
        metadata: { output: resolvedInlineText, exit: 0, truncated: true, outputPath: resolvedOutputPath },
      },
    }),
  )

  insertPart.run(
    'prt_spill_0000000000000002',
    messageId,
    sessionId,
    1787001013000,
    1787001014000,
    JSON.stringify({
      type: 'tool',
      tool: 'webfetch',
      callID: missingCallId,
      state: {
        status: 'completed',
        input: { url: 'https://example.test/huge-page' },
        output: missingInlineText,
        // webfetch mirrors no full text into metadata.output — outputPath only.
        metadata: { truncated: true, outputPath: missingOutputPath },
      },
    }),
  )

  db.close()

  return {
    dbPath,
    sessionId,
    resolvedCallId,
    resolvedOutputPath,
    resolvedFullText,
    resolvedInlineText,
    missingCallId,
    missingOutputPath,
    missingInlineText,
  }
}
