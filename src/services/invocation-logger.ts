import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { InvocationRecord } from '../types/invocation-log'

/**
 * Records every MCP tool call to `tool_invocations` — cheap call telemetry
 * (tool name, params, timing, result status/size). No result content is
 * stored, only byte size.
 *
 * Logging failures never propagate — telemetry must never break a real
 * tool call. Errors are written to stderr and swallowed.
 */
export class ToolInvocationLogger {
  private readonly insertInvocation: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.insertInvocation = this.db.prepare(`
      INSERT INTO tool_invocations (
        tool_name, params_json, params_hash, called_at, duration_ms,
        result_status, result_size, caller_session, project_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  }

  record(rec: InvocationRecord): void {
    try {
      this.recordImpl(rec)
    } catch (err) {
      // Telemetry must never break a real call. Surface to stderr only.
      console.error('[invocation-logger] record failed:', err)
    }
  }

  private recordImpl(rec: InvocationRecord): void {
    const calledAt = rec.calledAt ?? Date.now()
    const rawObj = isPlainObject(rec.rawParams) ? rec.rawParams : {}
    const paramsJson = safeStringify(rawObj)
    const paramsHash = sha1Hex(`${rec.toolName}:${canonicalStringify(rawObj)}`)

    this.insertInvocation.run(
      rec.toolName,
      paramsJson,
      paramsHash,
      calledAt,
      rec.durationMs,
      rec.status,
      rec.resultSize,
      rec.callerSession ?? null,
      null,
    )
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return '{}'
  }
}

/** Stable JSON: object keys sorted recursively. */
export function canonicalStringify(v: unknown): string {
  return JSON.stringify(canonicalize(v))
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize)
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k])
    return out
  }
  return v
}

function sha1Hex(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}
