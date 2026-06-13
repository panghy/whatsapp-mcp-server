import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs'
import Settings from 'electron-settings'

// electron-settings normally derives its storage directory from
// `electron.app.getPath('userData')`, which isn't available in the vitest
// environment. Point it at an isolated tmp dir via `configure({ dir })`.
const testDir = path.join(
  os.tmpdir(),
  'wa-global-settings-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
)

import {
  getMcpPort,
  setMcpPort,
  getMcpAutoStart,
  setMcpAutoStart,
  getMediaInlineMaxBytes,
  setMediaInlineMaxBytes,
  DEFAULT_MCP_PORT,
  DEFAULT_MCP_AUTO_START,
  DEFAULT_MEDIA_INLINE_MAX_BYTES,
} from './global-settings'

describe('global-settings', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true })
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
  })

  beforeEach(() => {
    try { Settings.unsetSync() } catch { /* ignore */ }
  })

  afterAll(() => {
    Settings.reset()
    try {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  describe('defaults', () => {
    it('returns default port when unset', () => {
      expect(getMcpPort()).toBe(DEFAULT_MCP_PORT)
      expect(DEFAULT_MCP_PORT).toBe(13491)
    })

    it('returns default auto-start when unset', () => {
      expect(getMcpAutoStart()).toBe(DEFAULT_MCP_AUTO_START)
      expect(DEFAULT_MCP_AUTO_START).toBe(true)
    })

    it('returns default media inline max bytes when unset', () => {
      expect(getMediaInlineMaxBytes()).toBe(DEFAULT_MEDIA_INLINE_MAX_BYTES)
      expect(DEFAULT_MEDIA_INLINE_MAX_BYTES).toBe(25 * 1024 * 1024)
    })
  })

  describe('round-trip', () => {
    it('persists and reads mcp_port', () => {
      setMcpPort(15000)
      expect(getMcpPort()).toBe(15000)
      setMcpPort(22222)
      expect(getMcpPort()).toBe(22222)
    })

    it('persists and reads mcp_auto_start', () => {
      setMcpAutoStart(false)
      expect(getMcpAutoStart()).toBe(false)
      setMcpAutoStart(true)
      expect(getMcpAutoStart()).toBe(true)
    })

    it('stores port and auto-start independently', () => {
      setMcpPort(13500)
      setMcpAutoStart(false)
      expect(getMcpPort()).toBe(13500)
      expect(getMcpAutoStart()).toBe(false)
    })

    it('persists and reads media_inline_max_bytes', () => {
      setMediaInlineMaxBytes(10 * 1024 * 1024)
      expect(getMediaInlineMaxBytes()).toBe(10 * 1024 * 1024)
      setMediaInlineMaxBytes(1024)
      expect(getMediaInlineMaxBytes()).toBe(1024)
    })
  })

  describe('validation', () => {
    it('rejects invalid ports', () => {
      expect(() => setMcpPort(0)).toThrow()
      expect(() => setMcpPort(-1)).toThrow()
      expect(() => setMcpPort(70000)).toThrow()
      expect(() => setMcpPort(1.5)).toThrow()
    })

    it('rejects invalid media inline max bytes', () => {
      expect(() => setMediaInlineMaxBytes(0)).toThrow()
      expect(() => setMediaInlineMaxBytes(-1)).toThrow()
      expect(() => setMediaInlineMaxBytes(1.5)).toThrow()
    })

    it('falls back to default when stored value has wrong type', () => {
      // Simulate a corrupt/legacy value (string instead of number).
      Settings.setSync('mcp_port', 'not-a-number' as unknown as number)
      expect(getMcpPort()).toBe(DEFAULT_MCP_PORT)
      Settings.setSync('mcp_auto_start', 'yes' as unknown as boolean)
      expect(getMcpAutoStart()).toBe(DEFAULT_MCP_AUTO_START)
      Settings.setSync('media_inline_max_bytes', 'lots' as unknown as number)
      expect(getMediaInlineMaxBytes()).toBe(DEFAULT_MEDIA_INLINE_MAX_BYTES)
    })
  })
})

