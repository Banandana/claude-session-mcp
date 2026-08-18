import { describe, it, expect } from 'vitest'
import { PaginationManager, InvalidCursorError } from './pagination-manager'

describe('PaginationManager', () => {
  const manager = new PaginationManager()
  const items = Array.from({ length: 120 }, (_, i) => `item-${i}`)

  it('returns first page with no cursor', () => {
    const result = manager.paginate(items, {})

    expect(result.items).toHaveLength(50)
    expect(result.items[0]).toBe('item-0')
    expect(result.items[49]).toBe('item-49')
    expect(result.hasMore).toBe(true)
    expect(result.cursor).toBeDefined()
    expect(result.totalEstimate).toBe(120)
  })

  it('returns second page using cursor from first page', () => {
    const first = manager.paginate(items, {})
    const second = manager.paginate(items, { cursor: first.cursor })

    expect(second.items).toHaveLength(50)
    expect(second.items[0]).toBe('item-50')
    expect(second.items[49]).toBe('item-99')
    expect(second.hasMore).toBe(true)
    expect(second.cursor).toBeDefined()
  })

  it('last page has hasMore=false and no cursor', () => {
    const first = manager.paginate(items, {})
    const second = manager.paginate(items, { cursor: first.cursor })
    const third = manager.paginate(items, { cursor: second.cursor })

    expect(third.items).toHaveLength(20)
    expect(third.items[0]).toBe('item-100')
    expect(third.hasMore).toBe(false)
    expect(third.cursor).toBeUndefined()
  })

  it('cursor encode/decode roundtrip', () => {
    const offset = 42
    const encoded = manager.encodeCursor(offset)
    const decoded = manager.decodeCursor(encoded)
    expect(decoded).toBe(offset)
  })

  it('custom limit works', () => {
    const result = manager.paginate(items, { limit: 10 })

    expect(result.items).toHaveLength(10)
    expect(result.items[0]).toBe('item-0')
    expect(result.items[9]).toBe('item-9')
    expect(result.hasMore).toBe(true)
  })

  it('empty array returns empty result with no cursor', () => {
    const result = manager.paginate([], {})

    expect(result.items).toHaveLength(0)
    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeUndefined()
    expect(result.totalEstimate).toBe(0)
  })

  it('limit larger than total returns all items with no cursor', () => {
    const small = ['a', 'b', 'c']
    const result = manager.paginate(small, { limit: 100 })

    expect(result.items).toHaveLength(3)
    expect(result.hasMore).toBe(false)
    expect(result.cursor).toBeUndefined()
    expect(result.totalEstimate).toBe(3)
  })

  it('cursor from second page can be used for third page', () => {
    const first = manager.paginate(items, { limit: 20 })
    const second = manager.paginate(items, { cursor: first.cursor, limit: 20 })
    const third = manager.paginate(items, { cursor: second.cursor, limit: 20 })

    expect(third.items[0]).toBe('item-40')
    expect(third.items).toHaveLength(20)
  })

  describe('malformed cursor handling (regression: decodeCursor swallowed parse errors and returned 0)', () => {
    it('decodeCursor returns undefined for non-base64url garbage', () => {
      expect(manager.decodeCursor('not a real cursor!!!')).toBeUndefined()
    })

    it('decodeCursor returns undefined for valid base64url that is not JSON', () => {
      const notJson = Buffer.from('plain text, not json').toString('base64url')
      expect(manager.decodeCursor(notJson)).toBeUndefined()
    })

    it('decodeCursor returns undefined for valid JSON missing the "o" key', () => {
      const noOffset = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url')
      expect(manager.decodeCursor(noOffset)).toBeUndefined()
    })

    it('decodeCursor returns undefined for a negative offset', () => {
      const negative = Buffer.from(JSON.stringify({ o: -5 })).toString('base64url')
      expect(manager.decodeCursor(negative)).toBeUndefined()
    })

    it('decodeCursor still decodes a well-formed cursor', () => {
      expect(manager.decodeCursor(manager.encodeCursor(7))).toBe(7)
    })

    it('paginate throws InvalidCursorError for a malformed cursor instead of silently restarting at page 1', () => {
      expect(() => manager.paginate(items, { cursor: 'garbage-cursor' })).toThrow(InvalidCursorError)
    })
  })
})
