/**
 * Types for the MCP tool-invocation log.
 *
 * Records every MCP tool call (raw firehose) to `tool_invocations` — cheap
 * call telemetry (tool name, params, timing, result status/size).
 */

export type InvocationStatus = 'ok' | 'error'

/** Input record submitted to the logger after each MCP call. */
export interface InvocationRecord {
  readonly toolName: string
  readonly rawParams: unknown
  readonly status: InvocationStatus
  readonly durationMs: number
  readonly resultSize: number
  readonly calledAt?: number | undefined
  readonly callerSession?: string | null
}
