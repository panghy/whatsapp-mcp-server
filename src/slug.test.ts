import { describe, it, expect } from 'vitest'
import {
  SLUG_REGEX,
  isValidSlug,
  validateSlug,
  buildMcpUrl,
  accountMcpPath,
} from './slug'

describe('slug helpers', () => {
  describe('isValidSlug', () => {
    it('accepts a single lowercase letter', () => {
      expect(isValidSlug('a')).toBe(true)
      expect(isValidSlug('z')).toBe(true)
    })

    it('accepts typical multi-char slugs', () => {
      expect(isValidSlug('work')).toBe(true)
      expect(isValidSlug('personal')).toBe(true)
      expect(isValidSlug('alice-1')).toBe(true)
      expect(isValidSlug('ab')).toBe(true)
    })

    it('rejects slugs starting with digits or hyphens', () => {
      expect(isValidSlug('1abc')).toBe(false)
      expect(isValidSlug('-abc')).toBe(false)
    })

    it('rejects slugs ending with a hyphen', () => {
      expect(isValidSlug('abc-')).toBe(false)
    })

    it('rejects uppercase, spaces, and specials', () => {
      expect(isValidSlug('Work')).toBe(false)
      expect(isValidSlug('my account')).toBe(false)
      expect(isValidSlug('my_account')).toBe(false)
      expect(isValidSlug('acct!')).toBe(false)
    })

    it('rejects empty and overlong slugs', () => {
      expect(isValidSlug('')).toBe(false)
      expect(isValidSlug('a'.repeat(33))).toBe(false)
    })

    it('accepts 32-char slugs at the upper limit', () => {
      expect(isValidSlug('a' + 'b'.repeat(30) + 'c')).toBe(true)
    })

    it('rejects non-string inputs', () => {
      expect(isValidSlug(null as unknown as string)).toBe(false)
      expect(isValidSlug(123 as unknown as string)).toBe(false)
    })
  })

  describe('validateSlug', () => {
    it('returns null for a valid unused slug', () => {
      expect(validateSlug('work', ['personal'])).toBeNull()
    })

    it('flags empty input specifically', () => {
      expect(validateSlug('')).toMatch(/required/i)
    })

    it('flags invalid format with a helpful message', () => {
      const msg = validateSlug('Bad Slug')
      expect(msg).toBeTruthy()
      expect(msg).not.toMatch(/required/i)
    })

    it('flags duplicates against the existing list', () => {
      expect(validateSlug('work', ['work', 'personal'])).toMatch(/already exists/i)
    })
  })

  describe('buildMcpUrl', () => {
    it('constructs a localhost URL with port and path', () => {
      expect(buildMcpUrl(13491, '/mcp')).toBe('http://localhost:13491/mcp')
      expect(buildMcpUrl(13491, '/mcp/work')).toBe('http://localhost:13491/mcp/work')
    })

    it('tolerates a path without a leading slash', () => {
      expect(buildMcpUrl(8080, 'mcp/x')).toBe('http://localhost:8080/mcp/x')
    })

    it('falls back to the default port on bogus input', () => {
      expect(buildMcpUrl(0, '/mcp')).toBe('http://localhost:13491/mcp')
      expect(buildMcpUrl(-1, '/mcp')).toBe('http://localhost:13491/mcp')
      expect(buildMcpUrl(Number.NaN, '/mcp')).toBe('http://localhost:13491/mcp')
    })
  })

  describe('accountMcpPath', () => {
    it('returns the per-account MCP path', () => {
      expect(accountMcpPath('work')).toBe('/mcp/work')
      expect(accountMcpPath('default')).toBe('/mcp/default')
    })
  })

  describe('SLUG_REGEX', () => {
    it('is exported for callers that need the raw pattern', () => {
      expect(SLUG_REGEX.test('work')).toBe(true)
      expect(SLUG_REGEX.test('BAD')).toBe(false)
    })
  })
})

