import type {
  SessionAdapter,
  SessionMetadataResult,
  IndexState,
  FreshnessResult,
  ProjectMeta,
  SessionMeta,
  NormalizedMessage,
  FileChange,
  SubagentMeta,
  MemoryEntry,
} from '../types'

export class AdapterRegistry {
  private readonly adapters: SessionAdapter[] = []
  /** adapter.source -> adapter, for O(1) hint resolution. */
  private readonly adaptersBySource = new Map<string, SessionAdapter>()
  /** sessionId -> owning adapter. Populated lazily by discoverSessions / checkFreshness / getOwner probes. */
  private readonly ownerCache = new Map<string, SessionAdapter>()
  /**
   * sessionId -> source, supplied by the caller (FreshnessGuard, from
   * `SELECT id, source FROM sessions`) once per freshness cycle (finding
   * B11). When a session's source is already known, ownership resolves
   * straight to the matching adapter with no disk probe. Sessions absent
   * from this map — new ids, or a hint pointing at an adapter that turns
   * out not to claim the id — fall back to the original claimsSessionId
   * probe, so a wrong or missing hint still resolves correctly.
   */
  private ownerHints: ReadonlyMap<string, string> = new Map()

  registerAdapter(adapter: SessionAdapter): void {
    this.adapters.push(adapter)
    this.adaptersBySource.set(adapter.source, adapter)
  }

  getAdapters(): readonly SessionAdapter[] {
    return this.adapters
  }

  /** Supplies (or replaces) the sessionId -> source hint map. See `ownerHints`. */
  setOwnerHints(hints: ReadonlyMap<string, string>): void {
    this.ownerHints = hints
  }

  /** Cache/hint helper: probe adapters via claimsSessionId() only when neither is available. */
  private async getOwner(sessionId: string): Promise<SessionAdapter | undefined> {
    const cached = this.ownerCache.get(sessionId)
    if (cached) return cached

    const hinted = this.adapterForHint(sessionId)
    if (hinted && (await hinted.claimsSessionId(sessionId))) {
      this.ownerCache.set(sessionId, hinted)
      return hinted
    }

    for (const adapter of this.adapters) {
      if (adapter === hinted) continue // already probed and rejected above
      if (await adapter.claimsSessionId(sessionId)) {
        this.ownerCache.set(sessionId, adapter)
        return adapter
      }
    }
    return undefined
  }

  private adapterForHint(sessionId: string): SessionAdapter | undefined {
    const source = this.ownerHints.get(sessionId)
    return source ? this.adaptersBySource.get(source) : undefined
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    for (const adapter of this.adapters) {
      yield* adapter.discoverProjects()
    }
  }

  async *discoverSessions(project?: string): AsyncIterable<SessionMeta> {
    for (const adapter of this.adapters) {
      for await (const session of adapter.discoverSessions(project)) {
        this.ownerCache.set(session.id, adapter)
        yield session
      }
    }
  }

  async *getMessages(sessionId: string): AsyncIterable<NormalizedMessage> {
    const owner = await this.getOwner(sessionId)
    if (owner) {
      yield* owner.getMessages(sessionId)
      return
    }
    for (const adapter of this.adapters) {
      yield* adapter.getMessages(sessionId)
    }
  }

  async *getFileChanges(sessionId: string): AsyncIterable<FileChange> {
    const owner = await this.getOwner(sessionId)
    if (owner) {
      yield* owner.getFileChanges(sessionId)
      return
    }
    for (const adapter of this.adapters) {
      yield* adapter.getFileChanges(sessionId)
    }
  }

  async *getSubagents(sessionId: string): AsyncIterable<SubagentMeta> {
    const owner = await this.getOwner(sessionId)
    if (owner) {
      yield* owner.getSubagents(sessionId)
      return
    }
    for (const adapter of this.adapters) {
      yield* adapter.getSubagents(sessionId)
    }
  }

  async *getMemory(project?: string): AsyncIterable<MemoryEntry> {
    for (const adapter of this.adapters) {
      yield* adapter.getMemory(project)
    }
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadataResult | undefined> {
    const owner = await this.getOwner(sessionId)
    if (owner) return owner.getSessionMetadata(sessionId)
    for (const adapter of this.adapters) {
      const result = await adapter.getSessionMetadata(sessionId)
      if (result) return result
    }
    return undefined
  }

  async getSessionCost(projectSlug: string, sessionId: string): Promise<number | undefined> {
    const owner = await this.getOwner(sessionId)
    if (owner) return owner.getSessionCost(projectSlug, sessionId)
    for (const adapter of this.adapters) {
      const result = await adapter.getSessionCost(projectSlug, sessionId)
      if (result !== undefined) return result
    }
    return undefined
  }

  async getSessionWatermark(sessionId: string): Promise<number | undefined> {
    const owner = await this.getOwner(sessionId)
    if (owner) return owner.getSessionWatermark(sessionId)
    for (const adapter of this.adapters) {
      const result = await adapter.getSessionWatermark(sessionId)
      if (result !== undefined) return result
    }
    return undefined
  }

  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    for (const adapter of this.adapters) {
      const result = await adapter.resolveProject(path)
      if (result) return result
    }
    return undefined
  }

  async checkFreshness(known: IndexState): Promise<FreshnessResult> {
    const newSessions: string[] = []
    const changedSessions: string[] = []
    const removedSessions: string[] = []

    // Partition known sessionWatermarks by claiming adapter. Ids that no
    // adapter claims (after probing) become "orphans" and are reported as
    // removed — they no longer exist anywhere on disk.
    const perAdapterWatermarks = new Map<SessionAdapter, Map<string, number>>()
    for (const adapter of this.adapters) {
      perAdapterWatermarks.set(adapter, new Map())
    }

    // Ids that need a real disk probe: no cached owner AND no usable hint.
    // This is the fix for finding B11 — with hints populated, a session
    // whose source is already known in the DB skips claimsSessionId
    // entirely instead of re-listing every adapter's directories once per
    // known session (quadratic in session count × adapter count).
    const unresolved: Array<[string, number]> = []

    for (const [id, watermark] of known.sessionWatermarks) {
      const cached = this.ownerCache.get(id)
      if (cached) {
        perAdapterWatermarks.get(cached)!.set(id, watermark)
        continue
      }
      const hinted = this.adapterForHint(id)
      if (hinted) {
        // Trust the DB-recorded source directly — no disk probe. If the
        // hint is stale or wrong, the hinted adapter's own checkFreshness
        // pass won't find the session on disk and will report it removed;
        // it then falls to the correct adapter's newSessions on the next
        // cycle once the hint (sourced from the now-deleted row) is gone.
        // That's the "wrong/missing hint still resolves correctly" fallback.
        this.ownerCache.set(id, hinted)
        perAdapterWatermarks.get(hinted)!.set(id, watermark)
        continue
      }
      unresolved.push([id, watermark])
    }

    const orphanIds: string[] = []
    for (const [id, watermark] of unresolved) {
      let owner: SessionAdapter | undefined
      for (const adapter of this.adapters) {
        if (await adapter.claimsSessionId(id)) {
          owner = adapter
          this.ownerCache.set(id, adapter)
          break
        }
      }
      if (owner) {
        perAdapterWatermarks.get(owner)!.set(id, watermark)
      } else {
        orphanIds.push(id)
      }
    }
    removedSessions.push(...orphanIds)

    // Each adapter sees only its own slice of `known.sessionWatermarks`.
    // Removals are taken at face value and unioned (no intersection across
    // adapters).
    for (const adapter of this.adapters) {
      const filteredWatermarks = perAdapterWatermarks.get(adapter)!
      const filteredKnown: IndexState = {
        sessionWatermarks: filteredWatermarks,
        lastSyncAt: known.lastSyncAt,
      }
      const result = await adapter.checkFreshness(filteredKnown)
      for (const id of result.newSessions) {
        this.ownerCache.set(id, adapter)
        newSessions.push(id)
      }
      for (const id of result.changedSessions) {
        this.ownerCache.set(id, adapter)
        changedSessions.push(id)
      }
      for (const id of result.removedSessions) {
        // Owner is gone — drop from cache so future probes re-resolve.
        this.ownerCache.delete(id)
        removedSessions.push(id)
      }
    }

    return {
      isStale: newSessions.length > 0 || changedSessions.length > 0 || removedSessions.length > 0,
      newSessions,
      changedSessions,
      removedSessions,
    }
  }
}
