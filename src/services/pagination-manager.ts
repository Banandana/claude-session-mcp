export interface PaginatedResult<T> {
  readonly items: readonly T[]
  readonly cursor?: string | undefined
  readonly hasMore: boolean
  readonly totalEstimate: number
}

/**
 * Thrown when a cursor string fails to decode to a valid non-negative
 * offset. Tools using `PaginationManager` should decode a caller-supplied
 * cursor up front and turn this into a real tool error — a cursor minted by
 * a DIFFERENT tool (or corrupted in transit) must not silently restart
 * pagination at page 1.
 */
export class InvalidCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Invalid pagination cursor: ${cursor}`)
    this.name = 'InvalidCursorError'
  }
}

export class PaginationManager {
  readonly defaultLimit = 50

  paginate<T>(
    items: readonly T[],
    params: { cursor?: string | undefined; limit?: number | undefined; total?: number | undefined }
  ): PaginatedResult<T> {
    let offset = 0
    if (params.cursor) {
      const decoded = this.decodeCursor(params.cursor)
      if (decoded === undefined) {
        throw new InvalidCursorError(params.cursor)
      }
      offset = decoded
    }
    const limit = params.limit ?? this.defaultLimit
    const page = items.slice(offset, offset + limit)
    // If caller supplies a real total (e.g., from a COUNT query), trust it.
    // Otherwise fall back to items.length — which is only accurate when the
    // caller passed the full result set.
    const totalEstimate = params.total ?? items.length
    const hasMore = params.total !== undefined
      ? offset + page.length < params.total
      : offset + limit < items.length
    const nextCursor = hasMore ? this.encodeCursor(offset + page.length) : undefined

    return {
      items: page,
      cursor: nextCursor,
      hasMore,
      totalEstimate,
    }
  }

  encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
  }

  /**
   * Decode a base64url `{"o":offset}` cursor. Returns `undefined` — rather
   * than defaulting to 0 — when the cursor is malformed, so a caller can
   * distinguish "no cursor" (start at page 1) from "garbage cursor" (an
   * error) instead of the two collapsing into the same silent restart.
   */
  decodeCursor(cursor: string): number | undefined {
    try {
      const data: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString())
      const offset = (data as { o?: unknown } | null)?.o
      if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
        return offset
      }
      return undefined
    } catch {
      return undefined
    }
  }
}
