/**
 * The authoritative signal describing whether a tool result failed. Every
 * field here is something a naive detector might be tempted to sniff for
 * "error" — that's deliberate, so `isToolResultError` below has something
 * concrete to ignore.
 */
export interface ToolResultSignal {
  /**
   * The source's own explicit error flag, already extracted by the caller:
   * claude's `tool_result.is_error`, pi's `toolResult.isError`. `undefined`
   * means the source didn't say either way.
   */
  readonly explicitError?: boolean | undefined
  /** The tool result's display/body text, if any. NOT authoritative. */
  readonly text?: string | undefined
  /** The tool result's stderr stream, if any. NOT authoritative. */
  readonly stderr?: string | undefined
}

/**
 * Authoritative tool-result error determination (finding B1).
 *
 * TRUE only when the source explicitly flagged the result as an error.
 * Text content — including the literal word "error" in an otherwise
 * successful result, or a non-empty stderr stream from a command that
 * still exited cleanly — is NEVER authoritative and is intentionally
 * ignored here.
 *
 * Before this fix, both adapters derived `isError` from substring/stderr
 * heuristics. Measured on one real session: 104 tool results actually
 * carried `is_error: true`, but the old heuristic flagged 286 turns as
 * errors — a 175% inflation, 182 of them purely from the substring rule.
 * Every error metric in the product (session error_count, `analyze`,
 * `query_turns` isError filter, phase clustering's Error category) is
 * built on this signal, so getting it wrong here poisons everything
 * downstream.
 *
 * See `isSuspectedError` below for the separate, non-authoritative text
 * heuristic — kept available for callers that explicitly want a fuzzy
 * "might be an error" signal and are prepared for false positives.
 */
export function isToolResultError(signal: ToolResultSignal): boolean {
  return signal.explicitError === true
}

/**
 * Non-authoritative text heuristic: does this text merely *look* like it
 * describes an error? Matches the word "error" as a whole word (case
 * insensitive), which is deliberately loose — it will false-positive on
 * strings like "0 errors found" or "no error occurred".
 *
 * Do NOT wire this into `NormalizedMessage.isError` or `ToolResultSignal`.
 * It exists as an explicit opt-in for callers that want a fuzzy signal
 * (e.g. flagging "possible errors we didn't catch" for human review) and
 * understand it is not ground truth. Nothing calls this yet.
 */
export function isSuspectedError(text: string | undefined | null): boolean {
  if (!text) return false
  return /(^|\s)error\b/i.test(text)
}
