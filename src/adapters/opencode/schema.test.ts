import { describe, it, expect } from 'vitest'
import { isGlobalProject, toProjectSlug, fromProjectSlug, friendlyModel, parseSessionModel } from './schema'

describe('isGlobalProject', () => {
  it('flags the id="global" row', () => {
    expect(isGlobalProject({ id: 'global', worktree: '/home/test/somewhere' })).toBe(true)
  })

  it('flags worktree="/" regardless of id', () => {
    expect(isGlobalProject({ id: 'proj_weird', worktree: '/' })).toBe(true)
  })

  it('does not flag a real project', () => {
    expect(isGlobalProject({ id: 'proj_alpha_sha1', worktree: '/home/test/project-alpha' })).toBe(false)
  })
})

describe('project slug namespacing', () => {
  it('prefixes with oc- so it cannot collide with claude/pi slug shapes', () => {
    const slug = toProjectSlug('proj_alpha_sha1')
    expect(slug).toBe('oc-proj_alpha_sha1')
    expect(slug.startsWith('-')).toBe(false)
  })

  it('round-trips through fromProjectSlug', () => {
    expect(fromProjectSlug(toProjectSlug('proj_alpha_sha1'))).toBe('proj_alpha_sha1')
  })

  it('fromProjectSlug tolerates an un-prefixed id', () => {
    expect(fromProjectSlug('proj_alpha_sha1')).toBe('proj_alpha_sha1')
  })
})

describe('friendlyModel', () => {
  it('joins provider and model', () => {
    expect(friendlyModel('cerebras', 'zai-glm-4.7')).toBe('cerebras/zai-glm-4.7')
  })

  it('falls back to bare model id when provider is missing', () => {
    expect(friendlyModel(undefined, 'zai-glm-4.7')).toBe('zai-glm-4.7')
  })

  it('returns undefined when there is no model id', () => {
    expect(friendlyModel('cerebras', undefined)).toBeUndefined()
  })
})

describe('parseSessionModel', () => {
  it('parses the {id,providerID,variant} JSON string', () => {
    const raw = '{"id":"zai-glm-4.7","providerID":"cerebras","variant":"default"}'
    expect(parseSessionModel(raw)).toBe('cerebras/zai-glm-4.7')
  })

  it('returns undefined for null/malformed input', () => {
    expect(parseSessionModel(null)).toBeUndefined()
    expect(parseSessionModel('not json')).toBeUndefined()
  })
})
