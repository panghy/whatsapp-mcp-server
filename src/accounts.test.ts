import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'

const { testDir } = vi.hoisted(() => {
  const p = require('path')
  const os = require('os')
  const testDir = p.join(
    os.tmpdir(),
    'wa-accounts-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  )
  return { testDir }
})

vi.mock('electron', () => {
  const app = { getPath: () => testDir }
  return { app, default: { app } }
})

import Settings from 'electron-settings'
import {
  SLUG_REGEX,
  DEFAULT_SLUG,
  ACCOUNTS_SCHEMA_VERSION,
  isValidSlug,
  assertValidSlug,
  loadAccounts,
  saveAccounts,
  listAccounts,
  getAccount,
  addAccount,
  removeAccount,
  renameAccount,
  setMcpEnabled,
  getDefaultSlug,
  setDefaultSlug,
  accountAuthDir,
  accountDbPath,
  migrateLegacyLayoutIfNeeded,
} from './accounts'
import { getMcpPort, getMcpAutoStart } from './global-settings'

function resetUserData(): void {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  fs.mkdirSync(testDir, { recursive: true })
  try { Settings.unsetSync() } catch { /* ignore */ }
}

describe('accounts', () => {
  beforeAll(() => {
    // electron-settings normally derives its directory from Electron's userData
    // path. In tests we point it at our tmp dir so the legacy-migration tests
    // (which lift mcp_port/mcp_auto_start into electron-settings) have a real
    // place to write.
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
  })

  beforeEach(() => {
    resetUserData()
    // After wiping testDir, re-apply the configure() since the dir is rebuilt.
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
  })

  afterAll(() => {
    Settings.reset()
    try { if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true }) }
    catch { /* ignore */ }
  })

  describe('slug validation', () => {
    const valid = ['a', 'ab', 'work', 'personal', 'a1', 'my-account', 'default', 'a-b-c', 'a'.repeat(32), 'abcdefghij0123456789-0123456789a']
    const invalid = ['', 'A', 'Ab', '1abc', '-abc', 'abc-', 'ab_cd', 'a'.repeat(33), 'foo bar', 'foo.bar', 'foo/bar', '  ', 'ab-']

    it.each(valid)('accepts %j', (s) => {
      expect(isValidSlug(s)).toBe(true)
      expect(SLUG_REGEX.test(s)).toBe(true)
      expect(() => assertValidSlug(s)).not.toThrow()
    })

    it.each(invalid)('rejects %j', (s) => {
      expect(isValidSlug(s)).toBe(false)
      expect(() => assertValidSlug(s)).toThrow()
    })
  })

  describe('path helpers', () => {
    it('builds account auth dir and DB paths under userData/accounts/<slug>/', () => {
      expect(accountAuthDir('work')).toBe(path.join(testDir, 'accounts', 'work', 'whatsapp-auth'))
      expect(accountDbPath('work')).toBe(path.join(testDir, 'accounts', 'work', 'nodexa.db'))
    })
  })

  describe('load/save registry', () => {
    it('loadAccounts returns empty registry when accounts.json is missing', () => {
      const reg = loadAccounts()
      expect(reg.schemaVersion).toBe(ACCOUNTS_SCHEMA_VERSION)
      expect(reg.accounts).toEqual([])
      expect(reg.defaultSlug).toBeNull()
    })

    it('saveAccounts + loadAccounts round-trips', () => {
      saveAccounts({
        schemaVersion: 1,
        accounts: [{ slug: 'work', createdAt: '2024-01-01T00:00:00Z', mcpEnabled: true }],
        defaultSlug: 'work',
      })
      const reg = loadAccounts()
      expect(reg.defaultSlug).toBe('work')
      expect(reg.accounts).toHaveLength(1)
      expect(reg.accounts[0].slug).toBe('work')
    })
  })

  describe('CRUD', () => {
    it('addAccount creates dirs, registers the account, and sets defaultSlug when empty', () => {
      const a = addAccount('alice')
      expect(a.slug).toBe('alice')
      expect(a.mcpEnabled).toBe(true)
      expect(typeof a.createdAt).toBe('string')
      expect(fs.existsSync(accountAuthDir('alice'))).toBe(true)
      expect(getDefaultSlug()).toBe('alice')
      expect(listAccounts().map((x) => x.slug)).toEqual(['alice'])
    })

    it('addAccount rejects duplicates and invalid slugs', () => {
      addAccount('alice')
      expect(() => addAccount('alice')).toThrow(/already exists/)
      expect(() => addAccount('Invalid')).toThrow(/Invalid account slug/)
    })

    it('addAccount does not overwrite existing defaultSlug', () => {
      addAccount('alice')
      addAccount('bob')
      expect(getDefaultSlug()).toBe('alice')
      expect(listAccounts().map((x) => x.slug).sort()).toEqual(['alice', 'bob'])
    })

    it('getAccount finds by slug, undefined otherwise', () => {
      addAccount('alice')
      expect(getAccount('alice')?.slug).toBe('alice')
      expect(getAccount('missing')).toBeUndefined()
    })

    it('removeAccount deletes dir and updates defaultSlug', () => {
      addAccount('alice')
      addAccount('bob')
      removeAccount('alice')
      expect(fs.existsSync(path.join(testDir, 'accounts', 'alice'))).toBe(false)
      expect(listAccounts().map((x) => x.slug)).toEqual(['bob'])
      expect(getDefaultSlug()).toBe('bob')
    })

    it('removeAccount on last account clears defaultSlug', () => {
      addAccount('alice')
      removeAccount('alice')
      expect(getDefaultSlug()).toBeNull()
    })

    it('removeAccount throws when slug not found', () => {
      expect(() => removeAccount('nope')).toThrow(/not found/)
    })

    it('renameAccount renames dir, updates registry and defaultSlug', () => {
      addAccount('alice')
      // Create a marker file to verify directory move preserves contents.
      fs.writeFileSync(path.join(accountAuthDir('alice'), 'marker.txt'), 'hi')
      renameAccount('alice', 'alicia')
      expect(fs.existsSync(path.join(testDir, 'accounts', 'alice'))).toBe(false)
      expect(fs.existsSync(accountAuthDir('alicia'))).toBe(true)
      expect(fs.readFileSync(path.join(accountAuthDir('alicia'), 'marker.txt'), 'utf-8')).toBe('hi')
      expect(getDefaultSlug()).toBe('alicia')
    })

    it('renameAccount rejects invalid new slug and duplicate target', () => {
      addAccount('alice')
      addAccount('bob')
      expect(() => renameAccount('alice', 'BAD')).toThrow(/Invalid account slug/)
      expect(() => renameAccount('alice', 'bob')).toThrow(/already exists/)
      expect(() => renameAccount('missing', 'ok')).toThrow(/not found/)
    })

    it('renameAccount with same slug is a no-op', () => {
      addAccount('alice')
      renameAccount('alice', 'alice')
      expect(getAccount('alice')).toBeDefined()
    })

    it('setMcpEnabled flips the flag', () => {
      addAccount('alice')
      expect(getAccount('alice')?.mcpEnabled).toBe(true)
      setMcpEnabled('alice', false)
      expect(getAccount('alice')?.mcpEnabled).toBe(false)
      setMcpEnabled('alice', true)
      expect(getAccount('alice')?.mcpEnabled).toBe(true)
      expect(() => setMcpEnabled('missing', false)).toThrow(/not found/)
    })

    it('setDefaultSlug validates that slug exists', () => {
      addAccount('alice')
      addAccount('bob')
      setDefaultSlug('bob')
      expect(getDefaultSlug()).toBe('bob')
      expect(() => setDefaultSlug('missing')).toThrow(/not found/)
    })
  })

  describe('migrateLegacyLayoutIfNeeded', () => {
    it('fresh install: writes empty registry and is idempotent', () => {
      migrateLegacyLayoutIfNeeded()
      const reg = loadAccounts()
      expect(reg.accounts).toEqual([])
      expect(reg.defaultSlug).toBeNull()
      expect(reg.schemaVersion).toBe(ACCOUNTS_SCHEMA_VERSION)
      // Second call must be a no-op (accounts.json already exists).
      const before = fs.readFileSync(path.join(testDir, 'accounts.json'), 'utf-8')
      migrateLegacyLayoutIfNeeded()
      const after = fs.readFileSync(path.join(testDir, 'accounts.json'), 'utf-8')
      expect(after).toBe(before)
    })

    it('legacy install: migrates auth dir + DB, lifts mcp settings, and writes registry', () => {
      // Seed legacy auth dir with a file.
      const legacyAuth = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(legacyAuth, { recursive: true })
      fs.writeFileSync(path.join(legacyAuth, 'creds.json'), '{"fake":"creds"}')

      // Seed legacy DB with a `settings` table carrying mcp_port / mcp_auto_start plus a
      // per-account key that should remain in the DB post-migration.
      const legacyDbDir = path.join(testDir, 'nodexa-whatsapp')
      fs.mkdirSync(legacyDbDir, { recursive: true })
      const legacyDbPath = path.join(legacyDbDir, 'nodexa.db')
      const db = new Database(legacyDbPath)
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('mcp_port', '14444')
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('mcp_auto_start', 'false')
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('user_display_name', 'Clem')
      db.close()

      migrateLegacyLayoutIfNeeded()

      // Auth file moved.
      expect(fs.existsSync(legacyAuth)).toBe(false)
      expect(fs.readFileSync(path.join(accountAuthDir(DEFAULT_SLUG), 'creds.json'), 'utf-8'))
        .toBe('{"fake":"creds"}')

      // DB moved.
      expect(fs.existsSync(legacyDbPath)).toBe(false)
      expect(fs.existsSync(accountDbPath(DEFAULT_SLUG))).toBe(true)

      // Global MCP settings lifted into electron-settings.
      expect(getMcpPort()).toBe(14444)
      expect(getMcpAutoStart()).toBe(false)

      // MCP rows removed from the moved DB; per-account setting preserved.
      const moved = new Database(accountDbPath(DEFAULT_SLUG), { readonly: true })
      const rows = moved.prepare('SELECT key FROM settings ORDER BY key').all() as { key: string }[]
      moved.close()
      expect(rows.map((r) => r.key)).toEqual(['user_display_name'])

      // Backup marker written.
      expect(fs.existsSync(path.join(testDir, 'migration-backup', 'README.txt'))).toBe(true)

      // Registry written with default account.
      const reg = loadAccounts()
      expect(reg.defaultSlug).toBe(DEFAULT_SLUG)
      expect(reg.accounts).toHaveLength(1)
      expect(reg.accounts[0]).toMatchObject({ slug: DEFAULT_SLUG, mcpEnabled: true })

      // Second call is a no-op.
      const before = fs.readFileSync(path.join(testDir, 'accounts.json'), 'utf-8')
      migrateLegacyLayoutIfNeeded()
      const after = fs.readFileSync(path.join(testDir, 'accounts.json'), 'utf-8')
      expect(after).toBe(before)
    })

    it('already-migrated: does nothing when accounts.json exists', () => {
      // Pre-seed a registry that looks already-migrated.
      saveAccounts({
        schemaVersion: 1,
        accounts: [{ slug: 'existing', createdAt: '2024-01-01T00:00:00Z', mcpEnabled: true }],
        defaultSlug: 'existing',
      })
      // Also drop a legacy dir - it should be left alone since accounts.json is already there.
      const legacyAuth = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(legacyAuth, { recursive: true })
      fs.writeFileSync(path.join(legacyAuth, 'creds.json'), '{}')

      migrateLegacyLayoutIfNeeded()

      expect(loadAccounts().accounts.map((a) => a.slug)).toEqual(['existing'])
      expect(fs.existsSync(path.join(legacyAuth, 'creds.json'))).toBe(true)
      expect(fs.existsSync(path.join(testDir, 'migration-backup'))).toBe(false)
    })

    it('legacy auth dir only (no DB): still migrates and writes registry', () => {
      const legacyAuth = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(legacyAuth, { recursive: true })
      fs.writeFileSync(path.join(legacyAuth, 'creds.json'), '{}')

      migrateLegacyLayoutIfNeeded()

      expect(fs.existsSync(legacyAuth)).toBe(false)
      expect(fs.existsSync(path.join(accountAuthDir(DEFAULT_SLUG), 'creds.json'))).toBe(true)
      expect(loadAccounts().defaultSlug).toBe(DEFAULT_SLUG)
    })

    it('legacy DB only (no auth dir): still migrates and writes registry', () => {
      const legacyDbDir = path.join(testDir, 'nodexa-whatsapp')
      fs.mkdirSync(legacyDbDir, { recursive: true })
      const legacyDbPath = path.join(legacyDbDir, 'nodexa.db')
      const db = new Database(legacyDbPath)
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
      db.close()

      migrateLegacyLayoutIfNeeded()

      expect(fs.existsSync(legacyDbPath)).toBe(false)
      expect(fs.existsSync(accountDbPath(DEFAULT_SLUG))).toBe(true)
      expect(loadAccounts().defaultSlug).toBe(DEFAULT_SLUG)
    })

    it('empty legacy auth dir is treated as no legacy data (fresh install path)', () => {
      const legacyAuth = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(legacyAuth, { recursive: true })

      migrateLegacyLayoutIfNeeded()

      const reg = loadAccounts()
      expect(reg.accounts).toEqual([])
      expect(reg.defaultSlug).toBeNull()
      // No migration backup written for fresh installs.
      expect(fs.existsSync(path.join(testDir, 'migration-backup'))).toBe(false)
    })
  })
})

