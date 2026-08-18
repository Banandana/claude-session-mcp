import { describe, it, expect, beforeAll } from 'vitest'
import { OpencodeDatabase } from './database'
import { OpencodeSessionDiscovery } from './session-discovery'
import { OpencodeMetadataParser } from './metadata-parser'
import { buildFixtureDb } from './test-fixture'

describe('OpencodeMetadataParser', () => {
  let discovery: OpencodeSessionDiscovery
  let parser: OpencodeMetadataParser

  beforeAll(() => {
    const dbPath = buildFixtureDb()
    const database = new OpencodeDatabase(dbPath)
    discovery = new OpencodeSessionDiscovery(database)
    parser = new OpencodeMetadataParser(database)
  })

  it('maps session.title to customTitle', async () => {
    const session = await discovery.findSessionRow('ses_parent0000000000000001')
    const meta = await parser.extractMetadata(session!)
    expect(meta.customTitle).toBe('Add retry to fetch helper')
  })

  it('produces one ContextCollapse from the compaction part', async () => {
    const session = await discovery.findSessionRow('ses_parent0000000000000001')
    const meta = await parser.extractMetadata(session!)
    expect(meta.collapses).toHaveLength(1)
    const [collapse] = meta.collapses
    expect(collapse?.sessionId).toBe('ses_parent0000000000000001')
    expect(collapse?.collapseId).toBe('prt_0000000000000000000010')
    expect(collapse?.summary).toContain('auto=true')
    expect(collapse?.summary).toContain('overflow=true')
  })

  it('anchors the archived range around tail_start_id', async () => {
    const session = await discovery.findSessionRow('ses_parent0000000000000001')
    const meta = await parser.extractMetadata(session!)
    const [collapse] = meta.collapses
    // tail_start_id is msg_asst_...0002, the surviving-prefix anchor — the
    // only message before it (msg_user_...0001) is the whole archived range.
    expect(collapse?.firstArchivedUuid).toBe('msg_user_0000000000000001')
    expect(collapse?.lastArchivedUuid).toBe('msg_user_0000000000000001')
  })

  it('has no collapses for a session with no compaction part', async () => {
    const session = await discovery.findSessionRow('ses_child00000000000000002')
    const meta = await parser.extractMetadata(session!)
    expect(meta.collapses).toHaveLength(0)
  })

  it('leaves opencode-unsupported fields empty rather than guessed', async () => {
    const session = await discovery.findSessionRow('ses_parent0000000000000001')
    const meta = await parser.extractMetadata(session!)
    expect(meta.tags).toEqual([])
    expect(meta.prLinks).toEqual([])
    expect(meta.taskSummaries).toEqual([])
    expect(meta.mode).toBeUndefined()
  })
})
