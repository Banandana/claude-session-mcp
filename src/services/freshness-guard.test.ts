import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from './index-manager'
import { AdapterRegistry } from './adapter-registry'
import { ClaudeCodeAdapter } from '../adapters/claude-code/index'
import { FreshnessGuard } from './freshness-guard'
import type { NormalizedMessage, FileChange, SubagentMeta, SessionMeta, IndexState, FreshnessResult, MemoryEntry, ProjectMeta } from '../types'

const FIXTURES = join(__dirname, '../../fixtures/claude-home')

// ─── Mock registry for unit-level metrics tests ────────────────────────────

function createMockRegistry(options: {
  sessions?: SessionMeta[]
  messages?: NormalizedMessage[]
  fileChanges?: FileChange[]
  subagents?: SubagentMeta[]
  freshnessResult?: FreshnessResult
}): AdapterRegistry {
  const {
    sessions = [],
    messages = [],
    fileChanges = [],
    subagents = [],
    freshnessResult,
  } = options

  const adapter = {
    source: 'mock',
    async *discoverProjects(): AsyncIterable<ProjectMeta> {},
    async *discoverSessions(): AsyncIterable<SessionMeta> {
      for (const s of sessions) yield s
    },
    async *getMessages(): AsyncIterable<NormalizedMessage> {
      for (const m of messages) yield m
    },
    async *getFileChanges(): AsyncIterable<FileChange> {
      for (const f of fileChanges) yield f
    },
    async *getSubagents(): AsyncIterable<SubagentMeta> {
      for (const a of subagents) yield a
    },
    async *getMemory(): AsyncIterable<MemoryEntry> {},
    async getSessionMetadata() { return undefined },
    async claimsSessionId(sessionId: string) { return sessions.some(s => s.id === sessionId) },
    async getSessionWatermark(sessionId: string) { return sessions.some(s => s.id === sessionId) ? 1 : undefined },
    async getSessionCost() { return undefined },
    async resolveProject(): Promise<ProjectMeta | undefined> { return undefined },
    async checkFreshness(known: IndexState): Promise<FreshnessResult> {
      if (freshnessResult) return freshnessResult
      const knownIds = known.sessionWatermarks
      const newIds = sessions.filter(s => !knownIds.has(s.id)).map(s => s.id)
      const changedIds = sessions.filter(s => knownIds.has(s.id)).map(s => s.id)
      return {
        isStale: newIds.length > 0 || changedIds.length > 0,
        newSessions: newIds,
        changedSessions: changedIds,
        removedSessions: [],
      }
    },
  }

  const registry = new AdapterRegistry()
  registry.registerAdapter(adapter)
  return registry
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const SESSION_ID = 'test-session-001'
const NOW = '2026-04-01T10:00:00Z'
const LATER = '2026-04-01T10:30:00Z'

function makeMessage(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    sessionId: SESSION_ID,
    role: 'assistant',
    timestamp: NOW,
    contentBlocks: [{ type: 'text', text: 'hello' }],
    model: 'claude-opus-4-6',
    isError: false,
    isCorrection: false,
    hasThinking: false,
    uuid: overrides.id,
    ...overrides,
  }
}

function makeSessionMeta(id: string = SESSION_ID): SessionMeta {
  return {
    id,
    source: 'mock',
    projectSlug: 'test-project',
    cwd: '/home/test',
    startedAt: NOW,
  }
}

// ─── Unit tests: computeSessionMetrics ──────────────────────────────────────

describe('FreshnessGuard — computeSessionMetrics', () => {
  let tempDir: string
  let db: Database.Database
  let indexManager: IndexManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'freshness-metrics-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('populates all metric columns after sync', async () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Fix the build' }], toolNames: undefined }),
      makeMessage({ id: 'msg-2', role: 'assistant', timestamp: '2026-04-01T10:05:00Z', toolNames: ['Edit', 'Bash'], tokenUsage: { input_tokens: 100, output_tokens: 50 } }),
      makeMessage({ id: 'msg-3', role: 'assistant', timestamp: LATER, isError: true, toolNames: ['Bash'], tokenUsage: { input_tokens: 80, output_tokens: 20 } }),
    ]

    const fileChanges: FileChange[] = [
      { sessionId: SESSION_ID, filePath: '/src/main.ts', operation: 'edit', timestamp: NOW },
      { sessionId: SESSION_ID, filePath: '/src/utils.ts', operation: 'create', timestamp: NOW },
    ]

    const subagents: SubagentMeta[] = [
      { id: 'agent-1', sessionId: SESSION_ID, agentType: 'task', totalTokens: 500 },
    ]

    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages,
      fileChanges,
      subagents,
    })

    const guard = new FreshnessGuard(registry, indexManager, tempDir, db)
    await guard.ensureFresh()

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(SESSION_ID) as Record<string, unknown>

    expect(session.ended_at).toBe(LATER)
    expect(session.message_count).toBe(3)
    expect(session.error_count).toBe(1)
    expect(session.correction_count).toBe(0)
    expect(session.subagent_count).toBe(1)
    expect(session.duration_minutes).toBe(30) // 30 min between NOW and LATER
    expect(session.topic).toBeDefined()
    expect(typeof session.topic).toBe('string')
  })

  it('produces correct tool_counts JSON', async () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Do work' }] }),
      makeMessage({ id: 'msg-2', toolNames: ['Edit', 'Bash'], timestamp: NOW }),
      makeMessage({ id: 'msg-3', toolNames: ['Edit', 'Edit', 'Grep'], timestamp: NOW }),
      makeMessage({ id: 'msg-4', toolNames: ['Bash'], timestamp: NOW }),
    ]

    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages,
    })

    const guard = new FreshnessGuard(registry, indexManager, tempDir, db)
    await guard.ensureFresh()

    const session = db.prepare('SELECT tool_counts FROM sessions WHERE id = ?').get(SESSION_ID) as { tool_counts: string }
    const toolCounts = JSON.parse(session.tool_counts)

    expect(toolCounts).toEqual({ Edit: 3, Bash: 2, Grep: 1 })
  })

  it('produces correct files_changed JSON', async () => {
    const fileChanges: FileChange[] = [
      { sessionId: SESSION_ID, filePath: '/src/main.ts', operation: 'edit', timestamp: NOW },
      { sessionId: SESSION_ID, filePath: '/src/main.ts', operation: 'edit', timestamp: NOW },
      { sessionId: SESSION_ID, filePath: '/src/utils.ts', operation: 'create', timestamp: NOW },
    ]

    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages: [makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Edit files' }] })],
      fileChanges,
    })

    const guard = new FreshnessGuard(registry, indexManager, tempDir, db)
    await guard.ensureFresh()

    const session = db.prepare('SELECT files_changed FROM sessions WHERE id = ?').get(SESSION_ID) as { files_changed: string }
    const filesChanged = JSON.parse(session.files_changed) as Array<{ path: string; op: string }>

    expect(filesChanged).toHaveLength(2)
    expect(filesChanged).toContainEqual({ path: '/src/main.ts', op: 'edit' })
    expect(filesChanged).toContainEqual({ path: '/src/utils.ts', op: 'create' })
  })

  it('generates topic from first user message', async () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Fix the build system' }] }),
      makeMessage({ id: 'msg-2', toolNames: ['Bash', 'Edit'], timestamp: NOW }),
    ]

    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages,
    })

    const guard = new FreshnessGuard(registry, indexManager, tempDir, db)
    await guard.ensureFresh()

    const session = db.prepare('SELECT topic FROM sessions WHERE id = ?').get(SESSION_ID) as { topic: string }
    expect(session.topic).toContain('Fix the build system')
  })

  it('handles 0-message session: ended_at = started_at, duration = 0, topic = "Empty session"', async () => {
    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages: [],
      fileChanges: [],
      subagents: [],
    })

    const guard = new FreshnessGuard(registry, indexManager, tempDir, db)
    await guard.ensureFresh()

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(SESSION_ID) as Record<string, unknown>

    expect(session.ended_at).toBe(NOW) // fallback to started_at
    expect(session.duration_minutes).toBe(0)
    expect(session.message_count).toBe(0)
    expect(session.topic).toBe('Empty session')
  })

  it('syncChangedSessions re-indexes file_changes and subagents', async () => {
    // First sync with initial data
    const initialMessages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Hello' }] }),
    ]
    const initialFileChanges: FileChange[] = [
      { sessionId: SESSION_ID, filePath: '/src/old.ts', operation: 'edit', timestamp: NOW },
    ]
    const initialSubagents: SubagentMeta[] = [
      { id: 'agent-1', sessionId: SESSION_ID, agentType: 'task' },
    ]

    const registry1 = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages: initialMessages,
      fileChanges: initialFileChanges,
      subagents: initialSubagents,
    })

    const guard1 = new FreshnessGuard(registry1, indexManager, tempDir, db)
    await guard1.ensureFresh()

    // Verify initial state
    const fcBefore = db.prepare('SELECT COUNT(*) as cnt FROM file_changes WHERE session_id = ?').get(SESSION_ID) as { cnt: number }
    expect(fcBefore.cnt).toBe(1)
    const saBefore = db.prepare('SELECT COUNT(*) as cnt FROM subagents WHERE session_id = ?').get(SESSION_ID) as { cnt: number }
    expect(saBefore.cnt).toBe(1)

    // Second sync with updated data — simulate changed session
    const updatedMessages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Hello' }] }),
      makeMessage({ id: 'msg-2', role: 'assistant', timestamp: LATER, toolNames: ['Edit'] }),
    ]
    const updatedFileChanges: FileChange[] = [
      { sessionId: SESSION_ID, filePath: '/src/old.ts', operation: 'edit', timestamp: NOW },
      { sessionId: SESSION_ID, filePath: '/src/new.ts', operation: 'create', timestamp: LATER },
    ]
    const updatedSubagents: SubagentMeta[] = [
      { id: 'agent-1', sessionId: SESSION_ID, agentType: 'task' },
      { id: 'agent-2', sessionId: SESSION_ID, agentType: 'explore' },
    ]

    // Force changedSessions (session already known, so freshness check returns it as changed)
    const registry2 = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages: updatedMessages,
      fileChanges: updatedFileChanges,
      subagents: updatedSubagents,
    })

    const guard2 = new FreshnessGuard(registry2, indexManager, tempDir, db)
    await guard2.ensureFresh()

    // Verify file_changes were re-indexed
    const fcAfter = db.prepare('SELECT COUNT(*) as cnt FROM file_changes WHERE session_id = ?').get(SESSION_ID) as { cnt: number }
    expect(fcAfter.cnt).toBe(2)

    // Verify subagents were re-indexed
    const saAfter = db.prepare('SELECT COUNT(*) as cnt FROM subagents WHERE session_id = ?').get(SESSION_ID) as { cnt: number }
    expect(saAfter.cnt).toBe(2)

    // Verify metrics updated
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(SESSION_ID) as Record<string, unknown>
    expect(session.message_count).toBe(2)
    expect(session.subagent_count).toBe(2)
  })
})

// ─── Unit tests: generateSummaries ──────────────────────────────────────────

describe('FreshnessGuard — generateSummaries', () => {
  let tempDir: string
  let db: Database.Database
  let indexManager: IndexManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'freshness-summaries-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  function makeMockLlmClient(options: { available?: boolean; summary?: string } = {}) {
    const { available = true, summary = 'Test summary text.' } = options
    return {
      isAvailable: vi.fn().mockResolvedValue(available),
      summarize: vi.fn().mockResolvedValue(summary),
    }
  }

  it('generates LLM summary for sessions missing one', async () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Fix the auth bug' }] }),
      makeMessage({ id: 'msg-2', role: 'assistant', timestamp: LATER, toolNames: ['Edit', 'Bash'] }),
    ]
    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages,
    })

    const llmClient = makeMockLlmClient({ summary: 'The user asked to fix an auth bug. Claude used Edit and Bash tools to resolve it successfully.' })
    const guard = new FreshnessGuard(registry, indexManager, tempDir, db, llmClient as any)
    await guard.ensureFresh()

    // Wait for fire-and-forget to complete
    await new Promise(resolve => setTimeout(resolve, 50))

    const session = db.prepare('SELECT summary, summary_generated_at FROM sessions WHERE id = ?').get(SESSION_ID) as Record<string, unknown>
    expect(session.summary).toBe('The user asked to fix an auth bug. Claude used Edit and Bash tools to resolve it successfully.')
    expect(session.summary_generated_at).toBeDefined()
    expect(llmClient.summarize).toHaveBeenCalledOnce()
  })

  it('leaves summary NULL when LLM unavailable', async () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Do some work' }] }),
    ]
    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages,
    })

    const llmClient = makeMockLlmClient({ available: false })
    const guard = new FreshnessGuard(registry, indexManager, tempDir, db, llmClient as any)
    await guard.ensureFresh()

    // Wait for fire-and-forget to complete
    await new Promise(resolve => setTimeout(resolve, 50))

    const session = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(SESSION_ID) as Record<string, unknown>
    expect(session.summary).toBeNull()
    expect(llmClient.summarize).not.toHaveBeenCalled()
  })

  it('limits to 5 summaries per cycle', async () => {
    // Create 8 sessions, all needing summaries
    const sessionIds = Array.from({ length: 8 }, (_, i) => `session-${String(i + 1).padStart(3, '0')}`)

    const sessions = sessionIds.map(id => makeSessionMeta(id))
    const messages = sessionIds.flatMap((sid, i) => [
      {
        ...makeMessage({ id: `msg-${i}-1`, role: 'user' as const, timestamp: NOW, contentBlocks: [{ type: 'text' as const, text: `User message for session ${sid}` }] }),
        sessionId: sid,
        uuid: `msg-${i}-1`,
      },
    ])

    const adapter = {
      source: 'mock',
      async *discoverProjects() {},
      async *discoverSessions() {
        for (const s of sessions) yield s
      },
      async *getMessages(sessionId: string) {
        for (const m of messages.filter(msg => msg.sessionId === sessionId)) yield m
      },
      async *getFileChanges() {},
      async *getSubagents() {},
      async *getMemory() {},
      async getSessionMetadata() { return undefined },
    async claimsSessionId(sessionId: string) { return sessions.some(s => s.id === sessionId) },
    async getSessionWatermark(sessionId: string) { return sessions.some(s => s.id === sessionId) ? 1 : undefined },
      async getSessionCost() { return undefined },
      async resolveProject() { return undefined },
      async checkFreshness(known: IndexState): Promise<FreshnessResult> {
        const knownIds = known.sessionWatermarks
        const newIds = sessions.filter(s => !knownIds.has(s.id)).map(s => s.id)
        return {
          isStale: newIds.length > 0,
          newSessions: newIds,
          changedSessions: [],
          removedSessions: [],
        }
      },
    }

    const registry = new AdapterRegistry()
    registry.registerAdapter(adapter)

    const llmClient = makeMockLlmClient({ summary: 'A summary.' })
    const guard = new FreshnessGuard(registry, indexManager, tempDir, db, llmClient as any)
    await guard.ensureFresh()

    // Wait for fire-and-forget to complete
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(llmClient.summarize).toHaveBeenCalledTimes(5)

    // Verify exactly 5 sessions got summaries
    const summarized = db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE summary IS NOT NULL').get() as { cnt: number }
    expect(summarized.cnt).toBe(5)

    // Verify 3 sessions remain without summaries
    const unsummarized = db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE summary IS NULL').get() as { cnt: number }
    expect(unsummarized.cnt).toBe(3)
  })

  it('skips summary generation when no llmClient provided', async () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Do work' }] }),
    ]
    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages,
    })

    // No llmClient passed — should not throw
    const guard = new FreshnessGuard(registry, indexManager, tempDir, db)
    await guard.ensureFresh()
    await new Promise(resolve => setTimeout(resolve, 50))

    const session = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(SESSION_ID) as Record<string, unknown>
    expect(session.summary).toBeNull()
  })
})

// ─── Unit tests: FTS indexing uses lastInsertRowid ─────────────────────────

describe('FreshnessGuard — FTS indexing efficiency', () => {
  let tempDir: string
  let db: Database.Database
  let indexManager: IndexManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'freshness-fts-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('indexes FTS entries for messages with content previews', async () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Fix the build' }] }),
      makeMessage({ id: 'msg-2', role: 'assistant', timestamp: LATER, contentBlocks: [{ type: 'text', text: 'I will fix it' }] }),
    ]

    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages,
    })

    const guard = new FreshnessGuard(registry, indexManager, tempDir, db)
    await guard.ensureFresh()

    // Verify FTS entries exist
    const ftsResults = db.prepare("SELECT search_text FROM messages_fts WHERE search_text MATCH 'fix'").all() as Array<{ search_text: string }>
    expect(ftsResults.length).toBeGreaterThanOrEqual(1)
  })

  it('indexes tool-only content with tool name summary for searchability', async () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'assistant', timestamp: NOW, contentBlocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }),
    ]

    const registry = createMockRegistry({
      sessions: [makeSessionMeta()],
      messages,
    })

    const guard = new FreshnessGuard(registry, indexManager, tempDir, db)
    await guard.ensureFresh()

    // Tool-only blocks now include tool name and key input params for searchability
    const msgRow = db.prepare('SELECT content_preview FROM messages WHERE id = ?').get('msg-1') as { content_preview: string }
    expect(msgRow.content_preview).toContain('Bash')
  })
})

// ─── Unit tests: session discovery early exit ──────────────────────────────

describe('FreshnessGuard — session discovery optimization', () => {
  let tempDir: string
  let db: Database.Database
  let indexManager: IndexManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'freshness-discovery-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('discovers sessions efficiently using Set-based lookup', async () => {
    const sessions = [makeSessionMeta('session-1'), makeSessionMeta('session-2')]
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', timestamp: NOW, contentBlocks: [{ type: 'text', text: 'Hello' }] }),
    ]

    let discoveryCallCount = 0
    const adapter = {
      source: 'mock',
      async *discoverProjects() {},
      async *discoverSessions() {
        for (const s of sessions) {
          discoveryCallCount++
          yield s
        }
      },
      async *getMessages() {
        for (const m of messages) yield m
      },
      async *getFileChanges() {},
      async *getSubagents() {},
      async *getMemory() {},
      async getSessionMetadata() { return undefined },
    async claimsSessionId(sessionId: string) { return sessions.some(s => s.id === sessionId) },
    async getSessionWatermark(sessionId: string) { return sessions.some(s => s.id === sessionId) ? 1 : undefined },
      async getSessionCost() { return undefined },
      async resolveProject() { return undefined },
      async checkFreshness(known: IndexState): Promise<FreshnessResult> {
        const knownIds = known.sessionWatermarks
        const newIds = sessions.filter(s => !knownIds.has(s.id)).map(s => s.id)
        return {
          isStale: newIds.length > 0,
          newSessions: newIds,
          changedSessions: [],
          removedSessions: [],
        }
      },
    }

    const registry = new AdapterRegistry()
    registry.registerAdapter(adapter)

    const guard = new FreshnessGuard(registry, indexManager, tempDir, db)
    await guard.ensureFresh()

    // Both sessions should be indexed
    const sessionCount = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number }
    expect(sessionCount.cnt).toBe(2)

    // Discovery should stop early after finding both sessions
    expect(discoveryCallCount).toBe(2)
  })
})

// ─── Integration tests with fixtures ────────────────────────────────────────

describe('FreshnessGuard — integration with fixtures', () => {
  let tempDir: string
  let claudeDir: string
  let db: Database.Database
  let indexManager: IndexManager
  let registry: AdapterRegistry
  let guard: FreshnessGuard

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'freshness-guard-test-'))
    claudeDir = join(tempDir, 'claude-home')
    cpSync(FIXTURES, claudeDir, { recursive: true })

    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')

    indexManager = new (IndexManager as any)(db)
    registry = new AdapterRegistry()
    registry.registerAdapter(new ClaudeCodeAdapter(claudeDir))

    guard = new FreshnessGuard(registry, indexManager, claudeDir, db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('starts with empty index and discovers/indexes sessions', async () => {
    const result = await guard.ensureFresh()

    expect(result.sessionCount).toBeGreaterThanOrEqual(2)
    expect(result.syncDurationMs).toBeGreaterThanOrEqual(0)
    expect(result.indexedAt).toBeDefined()
    expect(result.staleSessions).toBe(0)

    // Verify sessions were inserted
    const sessions = db.prepare('SELECT id FROM sessions').all() as { id: string }[]
    expect(sessions.length).toBeGreaterThanOrEqual(2)

    // Verify messages were inserted
    const messages = db.prepare('SELECT id FROM messages').all() as { id: string }[]
    expect(messages.length).toBeGreaterThan(0)
  })

  it('second call with no changes is fast (no re-indexing needed)', async () => {
    // First sync
    await guard.ensureFresh()

    const messageCountBefore = (db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number }).cnt

    // Second sync - should detect no changes
    const result = await guard.ensureFresh()

    const messageCountAfter = (db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number }).cnt

    expect(result.staleSessions).toBe(0)
    expect(result.sessionCount).toBeGreaterThanOrEqual(2)
    // Message count should not change
    expect(messageCountAfter).toBe(messageCountBefore)
  })

  it('adding a new fixture file triggers re-index', async () => {
    // First sync
    const result1 = await guard.ensureFresh()
    const initialCount = result1.sessionCount

    // Add a new session JSONL file to beta project (no sessions-index.json, uses file listing)
    const { writeFileSync } = await import('node:fs')
    const newSessionId = 'dddddddd-1111-2222-3333-444444444444'
    const newSessionPath = join(
      claudeDir,
      'projects',
      '-home-test-project-beta',
      `${newSessionId}.jsonl`,
    )
    const newSessionContent = [
      JSON.stringify({
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'Hello new session' },
        uuid: 'new-msg-1',
        timestamp: '2026-03-28T12:00:00Z',
        sessionId: newSessionId,
        cwd: '/home/test/project-alpha',
        version: '2.1.87',
      }),
      JSON.stringify({
        parentUuid: 'new-msg-1',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          id: 'new-resp-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 25 },
        },
        requestId: 'new-req-1',
        uuid: 'new-msg-2',
        timestamp: '2026-03-28T12:00:05Z',
        sessionId: newSessionId,
        cwd: '/home/test/project-alpha',
        version: '2.1.87',
      }),
    ].join('\n')
    writeFileSync(newSessionPath, newSessionContent)

    // Re-create adapter to pick up new file
    registry = new AdapterRegistry()
    registry.registerAdapter(new ClaudeCodeAdapter(claudeDir))
    guard = new FreshnessGuard(registry, indexManager, claudeDir, db)

    // Second sync should pick up the new session
    const result2 = await guard.ensureFresh()
    expect(result2.sessionCount).toBe(initialCount + 1)

    // Verify the new session's messages are indexed
    const newMessages = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(newSessionId) as { id: string }[]
    expect(newMessages.length).toBeGreaterThan(0)
  })

  it('returns correct metadata', async () => {
    const result = await guard.ensureFresh()

    expect(typeof result.syncDurationMs).toBe('number')
    expect(result.syncDurationMs).toBeGreaterThanOrEqual(0)
    expect(typeof result.indexedAt).toBe('string')
    expect(result.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof result.sessionCount).toBe('number')
    expect(result.sessionCount).toBeGreaterThan(0)
    expect(result.staleSessions).toBe(0)
  })

  it('removes deleted sessions from index', async () => {
    // First sync
    await guard.ensureFresh()

    const sessionsBefore = db.prepare('SELECT id FROM sessions').all() as { id: string }[]
    expect(sessionsBefore.length).toBeGreaterThanOrEqual(2)

    // Delete a session file
    const { unlinkSync } = await import('node:fs')
    const sessionToDelete = 'bbbbbbbb-1111-2222-3333-444444444444'
    const sessionPath = join(
      claudeDir,
      'projects',
      '-home-test-project-beta',
      `${sessionToDelete}.jsonl`,
    )
    unlinkSync(sessionPath)

    // Re-create adapter
    registry = new AdapterRegistry()
    registry.registerAdapter(new ClaudeCodeAdapter(claudeDir))
    guard = new FreshnessGuard(registry, indexManager, claudeDir, db)

    // Second sync should remove the deleted session
    const result = await guard.ensureFresh()
    expect(result.sessionCount).toBe(sessionsBefore.length - 1)

    // Verify session was removed
    const deletedSession = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionToDelete)
    expect(deletedSession).toBeUndefined()
  })

  it('populates metric columns on fixture sessions after sync', async () => {
    await guard.ensureFresh()

    const sessions = db.prepare('SELECT * FROM sessions').all() as Record<string, unknown>[]
    for (const session of sessions) {
      // Every session should have metrics computed
      expect(session.message_count).toBeDefined()
      expect(typeof session.message_count).toBe('number')
      expect(session.ended_at).toBeDefined()
      expect(session.topic).toBeDefined()
      expect(typeof session.topic).toBe('string')
    }
  })

  it('populates project_id from cwd and records a project_aliases row (migration V7)', async () => {
    await guard.ensureFresh()

    const session = db.prepare(
      "SELECT project_id, cwd, project_slug, source FROM sessions WHERE id = 'aaaaaaaa-1111-2222-3333-444444444444'"
    ).get() as { project_id: string | null; cwd: string; project_slug: string; source: string }

    expect(session.project_id).toBe(session.cwd)

    const projectRow = db.prepare('SELECT id, path FROM projects WHERE id = ?').get(session.project_id) as
      | { id: string; path: string }
      | undefined
    expect(projectRow?.path).toBe(session.cwd)

    const alias = db.prepare(
      'SELECT project_id FROM project_aliases WHERE source = ? AND source_slug = ?'
    ).get(session.source, session.project_slug) as { project_id: string } | undefined
    expect(alias?.project_id).toBe(session.project_id)
  })

  it('resolves ownership via DB hints on a second cycle without re-probing every session', async () => {
    await guard.ensureFresh()
    // Second cycle: sessions.source is now populated for every known
    // session, so setOwnerHints should let checkFreshness skip the disk
    // probe entirely for all of them (finding B11). No behavioural
    // assertion beyond "still works and reports no changes" — the probe
    // count is covered at the AdapterRegistry unit-test level.
    const result = await guard.ensureFresh()
    expect(result.sessionCount).toBeGreaterThanOrEqual(2)
  })
})
