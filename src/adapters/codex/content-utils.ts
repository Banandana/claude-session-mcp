import type { ContentBlock, TokenUsage } from '../../types'

interface CodexTextPart {
  readonly type?: string
  readonly text?: string
}

/**
 * Codex `message` content is `[{type:"input_text"|"output_text", text}]`
 * (or, defensively, a bare string). Each part becomes its own text block —
 * unlike tool_result output, message content isn't collapsed to one blob.
 */
export function extractTextBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const blocks: ContentBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const part = raw as CodexTextPart
    if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text })
    }
  }
  return blocks
}

/** First non-empty text part of a `message` content array, trimmed. */
export function firstTextFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const part = raw as CodexTextPart
    if (typeof part.text === 'string' && part.text.trim().length > 0) {
      return part.text.trim()
    }
  }
  return undefined
}

/**
 * `function_call_output.output` is a plain string; `custom_tool_call_output.output`
 * is an array of `{type:"input_text", text}` parts that must be joined into
 * one blob for the tool_result content field.
 */
export function joinOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const parts: string[] = []
    for (const raw of output) {
      if (!raw || typeof raw !== 'object') continue
      const part = raw as CodexTextPart
      if (typeof part.text === 'string') parts.push(part.text)
    }
    return parts.join('')
  }
  if (output === undefined || output === null) return ''
  return JSON.stringify(output)
}

/**
 * Authoritative only (mirrors services/heuristics/error-detection.ts): a
 * `*_output` payload counts as an explicit error only when it carries its
 * own `success:false` or a truthy/non-empty `error` field. Output TEXT is
 * never consulted — never infer an error from the word "error" appearing
 * in successful output.
 */
export function explicitOutputError(payload: { readonly success?: unknown; readonly error?: unknown }): boolean {
  if (payload.success === false) return true
  const err = payload.error
  if (err === true) return true
  if (typeof err === 'string' && err.length > 0) return true
  return false
}

/** `function_call.arguments` is a JSON string; fall back to the raw string if it doesn't parse. */
export function parseFunctionCallArguments(raw: string | undefined): unknown {
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

interface CodexTokenUsageRaw {
  readonly input_tokens?: number
  readonly cached_input_tokens?: number
  readonly cache_write_input_tokens?: number
  readonly output_tokens?: number
}

/**
 * `event_msg/token_count.info.last_token_usage` -> TokenUsage.
 * `cached_input_tokens` -> cache_read, `cache_write_input_tokens` -> cache_creation.
 */
export function translateTokenUsage(raw: CodexTokenUsageRaw | undefined): TokenUsage | undefined {
  if (!raw) return undefined
  const input = raw.input_tokens ?? 0
  const output = raw.output_tokens ?? 0
  if (input === 0 && output === 0) return undefined

  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: raw.cached_input_tokens ? raw.cached_input_tokens : undefined,
    cache_creation_input_tokens: raw.cache_write_input_tokens ? raw.cache_write_input_tokens : undefined,
  }
}
