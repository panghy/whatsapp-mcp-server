import { vi, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs'

const { testDir, ipcHandlers } = vi.hoisted(() => {
  const p = require('path')
  const os = require('os')
  const testDir = p.join(
    os.tmpdir(),
    'wa-main-ipc-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  )
  const ipcHandlers = new Map<string, (event: any, ...args: any[]) => any>()
  return { testDir, ipcHandlers }
})

// Mock electron: only what main.ts touches at import time.
vi.mock('electron', () => {
  const app = {
    getPath: () => testDir,
    getVersion: () => '0.0.0-test',
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    quit: () => {},
    dock: { hide: () => {}, show: () => {} },
  }
  const ipcMain = {
    handle: (channel: string, handler: (event: any, ...args: any[]) => any) => {
      ipcHandlers.set(channel, handler)
    },
  }
  const BrowserWindow: any = function () { return { webContents: { send: () => {} }, on: () => {}, loadURL: () => {}, loadFile: () => {}, isVisible: () => false, show: () => {}, hide: () => {}, focus: () => {} } }
  const Menu = { buildFromTemplate: () => ({}) }
  const Tray: any = function () { return { setToolTip: () => {}, setContextMenu: () => {}, on: () => {} } }
  const nativeImage = { createFromPath: () => ({ resize: () => ({ setTemplateImage: () => {} }) }) }
  return { app, ipcMain, BrowserWindow, Menu, Tray, nativeImage, default: { app, ipcMain, BrowserWindow, Menu, Tray, nativeImage } }
})

// Mock electron-updater so autoUpdater.on() calls at import time do not crash.
vi.mock('electron-updater', () => {
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: () => {},
    checkForUpdates: async () => ({}),
    checkForUpdatesAndNotify: async () => ({}),
    quitAndInstall: () => {},
  }
  return { autoUpdater, default: { autoUpdater } }
})

// Baileys import is dynamic; we never trigger it in these tests because no
// account has an auth dir so hasAuth() returns false.

import Settings from 'electron-settings'
import { addAccount, getAccount, accountAuthDir, accountDbPath } from './accounts'
import { settingOps, chatOps, contactOps, logOps, closeAllDatabases } from './database'
import { setManager, listManagers, type WhatsAppManager, type ConnectionState } from './whatsapp-manager'

async function invoke(channel: string, ...args: any[]): Promise<any> {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No IPC handler registered for "${channel}"`)
  return await handler({}, ...args)
}

function resetUserData(): void {
  try { closeAllDatabases() } catch { /* ignore */ }
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  fs.mkdirSync(testDir, { recursive: true })
  try { Settings.unsetSync() } catch { /* ignore */ }
}

describe('main IPC surface', () => {
  beforeAll(async () => {
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    resetUserData()
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    await import('./main')
  })

  beforeEach(() => {
    resetUserData()
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
  })

  afterAll(() => {
    Settings.reset()
    try { if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true }) }
    catch { /* ignore */ }
  })

  describe('account registry IPC', () => {
    it('accounts-list returns the registry contents', async () => {
      addAccount('alpha')
      addAccount('beta')
      const accounts = await invoke('accounts-list')
      expect(accounts.map((a: any) => a.slug).sort()).toEqual(['alpha', 'beta'])
    })

    it('accounts-add creates the account and initializes its DB', async () => {
      const account = await invoke('accounts-add', { slug: 'work' })
      expect(account.slug).toBe('work')
      expect(fs.existsSync(accountAuthDir('work'))).toBe(true)
      // DB should be usable without an explicit initializeDatabase() call.
      settingOps.set('work', 'sanity_check', '1')
      expect(settingOps.get('work', 'sanity_check')).toBe('1')
    })

    it('accounts-add rejects invalid slugs', async () => {
      await expect(invoke('accounts-add', { slug: 'Has Caps' })).rejects.toThrow(/Invalid slug/)
      await expect(invoke('accounts-add', { slug: '' })).rejects.toThrow(/Invalid slug/)
    })

    it('accounts-remove wipes the account dir and picks a new default', async () => {
      await invoke('accounts-add', { slug: 'one' })
      await invoke('accounts-add', { slug: 'two' })
      await invoke('accounts-set-default', { slug: 'one' })
      const result = await invoke('accounts-remove', { slug: 'one' })
      expect(result.success).toBe(true)
      expect(result.defaultSlug).toBe('two')
      expect(fs.existsSync(path.dirname(accountDbPath('one')))).toBe(false)
      expect(getAccount('one')).toBeUndefined()
    })

    it('accounts-remove throws on unknown slug', async () => {
      await expect(invoke('accounts-remove', { slug: 'nope' })).rejects.toThrow(/not found/)
    })

    it('accounts-rename moves the directory and re-opens the DB', async () => {
      await invoke('accounts-add', { slug: 'old-slug' })
      settingOps.set('old-slug', 'key1', 'value1')
      const renamed = await invoke('accounts-rename', { oldSlug: 'old-slug', newSlug: 'new-slug' })
      expect(renamed.slug).toBe('new-slug')
      expect(fs.existsSync(accountDbPath('new-slug'))).toBe(true)
      // DB carries over under the new slug.
      expect(settingOps.get('new-slug', 'key1')).toBe('value1')
    })

    it('accounts-set-default updates the default slug', async () => {
      await invoke('accounts-add', { slug: 'a' })
      await invoke('accounts-add', { slug: 'b' })
      await invoke('accounts-set-default', { slug: 'b' })
      const accounts = await invoke('accounts-list')
      expect(accounts.find((x: any) => x.slug === 'b')).toBeTruthy()
    })

    it('accounts-get-mcp-urls returns /mcp/<slug> and /mcp alias for default', async () => {
      await invoke('accounts-add', { slug: 'primary' })
      await invoke('accounts-add', { slug: 'secondary' })
      await invoke('accounts-set-default', { slug: 'primary' })

      const primary = await invoke('accounts-get-mcp-urls', { slug: 'primary' })
      expect(primary).toEqual({ path: '/mcp/primary', alias: '/mcp' })

      const secondary = await invoke('accounts-get-mcp-urls', { slug: 'secondary' })
      expect(secondary.path).toBe('/mcp/secondary')
      expect(secondary.alias).toBeUndefined()
    })
  })

  describe('account-management connected-guard', () => {
    function fakeManager(slug: string, state: ConnectionState): WhatsAppManager {
      return { slug, socket: null, state, qrCode: null, error: null }
    }

    afterEach(() => {
      // Purge any fake managers so later tests see a clean registry.
      const registry = listManagers()
      for (const slug of Array.from(registry.keys())) registry.delete(slug)
    })

    it('accounts-remove rejects when the account has a connected manager', async () => {
      await invoke('accounts-add', { slug: 'live' })
      setManager('live', fakeManager('live', 'connected'))

      await expect(invoke('accounts-remove', { slug: 'live' })).rejects.toThrow(/while connected/)

      // Registry entry is untouched.
      expect(getAccount('live')).toBeDefined()
      // Account dir (and its auth subdir) are still on disk.
      expect(fs.existsSync(path.dirname(accountDbPath('live')))).toBe(true)
      expect(fs.existsSync(accountAuthDir('live'))).toBe(true)
    })

    it('accounts-remove rejects when the manager is still connecting', async () => {
      await invoke('accounts-add', { slug: 'pending' })
      setManager('pending', fakeManager('pending', 'connecting'))

      await expect(invoke('accounts-remove', { slug: 'pending' })).rejects.toThrow(/while connected/)
      expect(getAccount('pending')).toBeDefined()
      expect(fs.existsSync(path.dirname(accountDbPath('pending')))).toBe(true)
    })

    it('accounts-rename rejects when the old slug has a connected manager', async () => {
      await invoke('accounts-add', { slug: 'old-live' })
      setManager('old-live', fakeManager('old-live', 'connected'))

      await expect(
        invoke('accounts-rename', { oldSlug: 'old-live', newSlug: 'renamed' })
      ).rejects.toThrow(/while connected/)

      // Registry unchanged: old slug still there, new slug not created.
      expect(getAccount('old-live')).toBeDefined()
      expect(getAccount('renamed')).toBeUndefined()
      // Old dir still on disk; new dir was not moved into place.
      expect(fs.existsSync(path.dirname(accountDbPath('old-live')))).toBe(true)
      expect(fs.existsSync(path.dirname(accountDbPath('renamed')))).toBe(false)
    })

    it('accounts-rename rejects when the old slug is still connecting', async () => {
      await invoke('accounts-add', { slug: 'old-pending' })
      setManager('old-pending', fakeManager('old-pending', 'connecting'))

      await expect(
        invoke('accounts-rename', { oldSlug: 'old-pending', newSlug: 'renamed-pending' })
      ).rejects.toThrow(/while connected/)
      expect(getAccount('old-pending')).toBeDefined()
      expect(getAccount('renamed-pending')).toBeUndefined()
    })

    it('accounts-remove succeeds once the manager transitions to disconnected', async () => {
      await invoke('accounts-add', { slug: 'will-drop' })
      const mgr = fakeManager('will-drop', 'connected')
      setManager('will-drop', mgr)

      // First call blocked by the guard.
      await expect(invoke('accounts-remove', { slug: 'will-drop' })).rejects.toThrow(/while connected/)

      // Simulate the user disconnecting: state flips to 'disconnected'.
      mgr.state = 'disconnected'
      const result = await invoke('accounts-remove', { slug: 'will-drop' })
      expect(result.success).toBe(true)
      expect(getAccount('will-drop')).toBeUndefined()
      expect(fs.existsSync(path.dirname(accountDbPath('will-drop')))).toBe(false)
    })

    it('accounts-rename succeeds once the manager transitions to disconnected', async () => {
      await invoke('accounts-add', { slug: 'old-name' })
      const mgr = fakeManager('old-name', 'connected')
      setManager('old-name', mgr)

      await expect(
        invoke('accounts-rename', { oldSlug: 'old-name', newSlug: 'new-name' })
      ).rejects.toThrow(/while connected/)

      mgr.state = 'disconnected'
      const renamed = await invoke('accounts-rename', { oldSlug: 'old-name', newSlug: 'new-name' })
      expect(renamed.slug).toBe('new-name')
      expect(getAccount('old-name')).toBeUndefined()
      expect(getAccount('new-name')).toBeDefined()
      expect(fs.existsSync(accountDbPath('new-name'))).toBe(true)
    })
  })

  describe('per-account IPC handlers', () => {
    beforeEach(async () => {
      await invoke('accounts-add', { slug: 'acct1' })
    })

    it('get-chats / get-contacts / get-logs route to the right account DB', async () => {
      chatOps.insert('acct1', 'jid@dm', 'dm', undefined, 'Alice')
      contactOps.insert('acct1', 'jid@dm', 'Alice')
      logOps.insert('acct1', 'info', 'test', 'hello world')

      const chats = await invoke('get-chats', { slug: 'acct1' })
      expect(chats).toHaveLength(1)
      const contacts = await invoke('get-contacts', { slug: 'acct1' })
      expect(contacts).toHaveLength(1)
      const logs = await invoke('get-logs', { slug: 'acct1' })
      expect(logs).toHaveLength(1)
    })

    it('get-sync-status returns a safe default when the orchestrator is uninitialized', async () => {
      const status = await invoke('get-sync-status', { slug: 'acct1' })
      expect(status.isSyncing).toBe(false)
    })

    it('get-activity-status reports the per-account message count', async () => {
      const activity = await invoke('get-activity-status', { slug: 'acct1' })
      expect(activity.totalMessagesStored).toBe(0)
    })

    it('get-user-display-name / set-user-display-name round-trip via settingOps', async () => {
      await invoke('set-user-display-name', { slug: 'acct1', name: 'Clement' })
      const name = await invoke('get-user-display-name', { slug: 'acct1' })
      expect(name).toBe('Clement')
    })

    it('whatsapp-status reports hasAuth=false when no auth dir exists', async () => {
      fs.rmSync(accountAuthDir('acct1'), { recursive: true, force: true })
      const status = await invoke('whatsapp-status', { slug: 'acct1' })
      expect(status.hasAuth).toBe(false)
      expect(status.state).toBe('disconnected')
    })

    it('whatsapp-logout does NOT wipe the per-account database', async () => {
      const slug = 'acct1'
      chatOps.insert(slug, 'group@g.us', 'group')
      settingOps.set(slug, 'user_display_name', 'KeepMe')

      const result = await invoke('whatsapp-logout', { slug })
      expect(result.success).toBe(true)

      // Rows must still be there — §6 hard rule.
      expect(chatOps.getAll(slug)).toHaveLength(1)
      expect(settingOps.get(slug, 'user_display_name')).toBe('KeepMe')

      // MCP flag should be flipped off for the slug.
      expect(getAccount(slug)?.mcpEnabled).toBe(false)
    })

    it('whatsapp-logout throws for unknown accounts', async () => {
      await expect(invoke('whatsapp-logout', { slug: 'ghost' })).rejects.toThrow(/not found/)
    })

    it('send-message throws when the account has no live socket', async () => {
      await expect(
        invoke('send-message', { slug: 'acct1', jid: 'x@s.whatsapp.net', text: 'hi' })
      ).rejects.toThrow(/not connected/)
    })
  })

  describe('MCP IPC handlers', () => {
    it('mcp-get-port / mcp-set-port round-trip through electron-settings', async () => {
      await invoke('mcp-set-port', 14000)
      const port = await invoke('mcp-get-port')
      expect(port).toBe(14000)
    })

    it('mcp-set-port rejects out-of-range ports', async () => {
      await expect(invoke('mcp-set-port', 0)).rejects.toThrow(/between 1 and 65535/)
      await expect(invoke('mcp-set-port', 70000)).rejects.toThrow(/between 1 and 65535/)
    })

    it('mcp-get-auto-start / mcp-set-auto-start round-trip through electron-settings', async () => {
      await invoke('mcp-set-auto-start', false)
      expect(await invoke('mcp-get-auto-start')).toBe(false)
      await invoke('mcp-set-auto-start', true)
      expect(await invoke('mcp-get-auto-start')).toBe(true)
    })

    it('mcp-get-status reports not-running with the current port', async () => {
      await invoke('mcp-set-port', 15555)
      const status = await invoke('mcp-get-status')
      expect(status.running).toBe(false)
      expect(status.port).toBe(15555)
    })
  })
})

