/**
 * Typed error hierarchy for codex adapter operations. Pairs with neverthrow
 * Result types — callers can pattern-match on `.error` and decide whether to
 * retry, fall back, or surface to the user. Mirrors pi-code's errors.ts.
 */
export abstract class CodexAdapterError extends Error {
  public abstract readonly code: string

  public constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = new.target.name
  }
}

export class CodexSessionNotFoundError extends CodexAdapterError {
  public readonly code = 'CODEX_SESSION_NOT_FOUND'
  public constructor(public readonly sessionId: string) {
    super(`codex session not found: ${sessionId}`)
  }
}

export class CodexSessionReadError extends CodexAdapterError {
  public readonly code = 'CODEX_SESSION_READ_ERROR'
  public constructor(public readonly path: string, cause: unknown) {
    super(`failed to read codex session at ${path}`, cause)
  }
}
