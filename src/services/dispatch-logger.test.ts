import { describe, it, expect } from 'vitest'
import { instrumentDispatch } from './dispatch-logger'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolInvocationLogger } from './invocation-logger'
import type { InvocationRecord } from '../types/invocation-log'

type Handler = (...a: unknown[]) => unknown

/**
 * A minimal fake of the slice of McpServer that instrumentDispatch patches.
 * `server.tool(...)` is overloaded in the real SDK, but instrumentDispatch
 * only cares that the tool name is the first arg and the handler is the
 * last — so a bare `(name, handler)` call exercises the same wrap path.
 *
 * `instrumentDispatch` replaces `server.tool` with an instrumented version
 * that stores the WRAPPED handler via this fake's `tool` method. Calling
 * `server.tool(name, handler)` AFTER `instrumentDispatch` therefore lets us
 * capture the wrapped handler and invoke it directly in tests.
 */
function makeFakeServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const server = {
    tool: (...args: unknown[]) => {
      const name = String(args[0])
      const handler = args[args.length - 1] as Handler
      handlers.set(name, handler)
    },
  }
  return { server: server as unknown as McpServer, handlers }
}

function makeFakeLogger(): { logger: ToolInvocationLogger; records: InvocationRecord[] } {
  const records: InvocationRecord[] = []
  const logger = {
    record: (rec: InvocationRecord) => {
      records.push(rec)
    },
  }
  return { logger: logger as unknown as ToolInvocationLogger, records }
}

function textResult(payload: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function registerAndInvoke(
  server: McpServer,
  handlers: Map<string, Handler>,
  toolName: string,
  handler: Handler,
): Promise<unknown> {
  ;(server as unknown as { tool: Handler }).tool(toolName, handler)
  const wrapped = handlers.get(toolName)
  if (!wrapped) throw new Error(`handler for ${toolName} was not captured`)
  return Promise.resolve(wrapped({}, {}))
}

describe('instrumentDispatch', () => {
  it('records status=error when the handler returns an {error} JSON payload (regression: B3 — was logged as ok)', async () => {
    const { server, handlers } = makeFakeServer()
    const { logger, records } = makeFakeLogger()
    instrumentDispatch(server, logger)

    await registerAndInvoke(server, handlers, 'get_conversation', async () =>
      textResult({ error: 'Session not found: abc123' }),
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('error')
  })

  it('records status=ok for a normal successful payload', async () => {
    const { server, handlers } = makeFakeServer()
    const { logger, records } = makeFakeLogger()
    instrumentDispatch(server, logger)

    await registerAndInvoke(server, handlers, 'list_sessions', async () =>
      textResult({ data: [{ id: 'session-1' }] }),
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('ok')
  })

  it('records status=error when the result carries isError: true', async () => {
    const { server, handlers } = makeFakeServer()
    const { logger, records } = makeFakeLogger()
    instrumentDispatch(server, logger)

    await registerAndInvoke(server, handlers, 'search', async () => ({
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    }))

    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('error')
  })

  it('does NOT flag an "error" key nested inside data as an error (only a TOP-LEVEL error key counts)', async () => {
    const { server, handlers } = makeFakeServer()
    const { logger, records } = makeFakeLogger()
    instrumentDispatch(server, logger)

    await registerAndInvoke(server, handlers, 'get_changes', async () =>
      textResult({ data: { error: 'this is a file path, not a failure' } }),
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('ok')
  })

  it('still records status=error when the handler throws', async () => {
    const { server, handlers } = makeFakeServer()
    const { logger, records } = makeFakeLogger()
    instrumentDispatch(server, logger)

    ;(server as unknown as { tool: Handler }).tool('get_turns', async () => {
      throw new Error('kaboom')
    })
    const wrapped = handlers.get('get_turns')!

    await expect(wrapped({}, {})).rejects.toThrow('kaboom')
    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('error')
  })

  it('never lets a logger failure break the real call', async () => {
    const { server, handlers } = makeFakeServer()
    const logger = {
      record: () => {
        throw new Error('telemetry db is down')
      },
    } as unknown as ToolInvocationLogger
    instrumentDispatch(server, logger)

    const result = await registerAndInvoke(server, handlers, 'get_project', async () =>
      textResult({ data: { name: 'proj' } }),
    )

    expect(result).toEqual(textResult({ data: { name: 'proj' } }))
  })
})
