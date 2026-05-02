import { vi, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs'

const { testDir, ipcHandlers, browserWindowState } = vi.hoisted(() => {
  const p = require('path')
  const os = require('os')
  const testDir = p.join(
    os.tmpdir(),
    'wa-main-ipc-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  )
  const ipcHandlers = new Map<string, (event: any, ...args: any[]) => any>()
  const browserWindowState: {
    constructorCount: number
    instances: any[]
    lastInstance: any | null
    appFocusCalls: any[]
  } = { constructorCount: 0, instances: [], lastInstance: null, appFocusCalls: [] }
  return { testDir, ipcHandlers, browserWindowState }
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
    focus: (opts?: any) => { browserWindowState.appFocusCalls.push(opts) },
    dock: { hide: () => {}, show: () => {} },
  }
  const ipcMain = {
    handle: (channel: string, handler: (event: any, ...args: any[]) => any) => {
      ipcHandlers.set(channel, handler)
    },
  }
  const BrowserWindow: any = function () {
    browserWindowState.constructorCount++
    const inst: any = {
      webContents: { send: vi.fn(), once: vi.fn() },
      on: vi.fn(),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      isVisible: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
      focus: vi.fn(),
      restore: vi.fn(),
      moveTop: vi.fn(),
      setAlwaysOnTop: vi.fn(),
    }
    browserWindowState.instances.push(inst)
    browserWindowState.lastInstance = inst
    return inst
  }
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
import { settingOps, chatOps, contactOps, logOps, messageOps, closeAllDatabases, initializeDatabase } from './database'
import { setManager, listManagers, type WhatsAppManager, type ConnectionState } from './whatsapp-manager'
import { initializeGroupMetadataFetcher, resetGroupMetadataFetchers } from './group-metadata-fetcher'

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
    it('accounts-list returns the registry contents with defaultSlug envelope', async () => {
      addAccount('alpha')
      addAccount('beta')
      const envelope = await invoke('accounts-list')
      expect(envelope.accounts.map((a: any) => a.slug).sort()).toEqual(['alpha', 'beta'])
      expect('defaultSlug' in envelope).toBe(true)
    })

    it('accounts-list returns the current defaultSlug and is unaffected by any UI "selected" notion', async () => {
      await invoke('accounts-add', { slug: 'first' })
      await invoke('accounts-add', { slug: 'second' })
      await invoke('accounts-set-default', { slug: 'first' })

      const envelope1 = await invoke('accounts-list')
      expect(envelope1.defaultSlug).toBe('first')

      // There is no IPC that changes defaultSlug based on which slug the UI is
      // "viewing" — only accounts-set-default does. Calling accounts-list again
      // (regardless of any selection state) must keep the previously set default.
      const envelope2 = await invoke('accounts-list')
      expect(envelope2.defaultSlug).toBe('first')

      await invoke('accounts-set-default', { slug: 'second' })
      const envelope3 = await invoke('accounts-list')
      expect(envelope3.defaultSlug).toBe('second')
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
      const envelope = await invoke('accounts-list')
      expect(envelope.accounts.find((x: any) => x.slug === 'b')).toBeTruthy()
      expect(envelope.defaultSlug).toBe('b')
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

  describe('registerHandlersForSlug — groups.upsert / chats.upsert / groups.update', () => {
    let registerHandlersForSlug: (slug: string, socket: any) => void
    let makeSocket: () => { socket: any; fire: (events: any) => Promise<void>; fireConnection: (u: any) => Promise<void> }

    beforeAll(async () => {
      const mod: any = await import('./main')
      registerHandlersForSlug = mod.registerHandlersForSlug
      expect(typeof registerHandlersForSlug).toBe('function')
      makeSocket = () => {
        let processCb: ((ev: any) => Promise<void>) | null = null
        const connectionHandlers: Array<(u: any) => any> = []
        const socket: any = {
          user: { id: '123@s.whatsapp.net' },
          ev: {
            on: (name: string, cb: any) => {
              if (name === 'connection.update') connectionHandlers.push(cb)
            },
            process: (cb: any) => { processCb = cb },
          },
          groupMetadata: vi.fn().mockResolvedValue({ participants: [] }),
        }
        return {
          socket,
          fire: async (events: any) => { if (processCb) await processCb(events) },
          fireConnection: async (u: any) => { for (const h of connectionHandlers) await h(u) },
        }
      }
    })

    beforeEach(() => {
      resetGroupMetadataFetchers()
    })

    const setupAccount = (slug: string) => { addAccount(slug); initializeDatabase(slug) }

    it('groups.upsert inserts each group with enabled=1 and queues metadata when contact sync complete', async () => {
      const slug = 'grp-upsert'
      setupAccount(slug)
      settingOps.set(slug, 'initial_sync_complete', 'true')

      const fetcher = initializeGroupMetadataFetcher(slug)
      const queueSpy = vi.spyOn(fetcher, 'queueGroups').mockImplementation(() => {})
      const startSpy = vi.spyOn(fetcher, 'start').mockImplementation(() => {})

      const { socket, fire, fireConnection } = makeSocket()
      registerHandlersForSlug(slug, socket)
      await fireConnection({ connection: 'open' })

      await fire({
        'messaging-history.set': { chats: [], contacts: [], messages: [], isLatest: true, syncType: 0, progress: 100 },
      })

      await fire({
        'groups.upsert': [
          { id: 'new-group@g.us', subject: 'New Group' },
          { id: 'newsletter@newsletter', subject: 'Skip me' },
        ],
      })

      const inserted = chatOps.getByWhatsappJid(slug, 'new-group@g.us') as any
      expect(inserted).toBeDefined()
      expect(inserted.chat_type).toBe('group')
      expect(inserted.enabled).toBe(1)
      expect(inserted.name).toBe('New Group')

      expect(chatOps.getByWhatsappJid(slug, 'newsletter@newsletter')).toBeUndefined()
      expect(queueSpy).toHaveBeenCalledWith([{ chatId: inserted.id, jid: 'new-group@g.us' }])
      expect(startSpy).toHaveBeenCalled()
    })

    it('chats.upsert handles mixed DM/group entries with correct enabled values', async () => {
      const slug = 'chats-upsert'
      setupAccount(slug)
      settingOps.set(slug, 'initial_sync_complete', 'true')

      const fetcher = initializeGroupMetadataFetcher(slug)
      const queueSpy = vi.spyOn(fetcher, 'queueGroups').mockImplementation(() => {})
      vi.spyOn(fetcher, 'start').mockImplementation(() => {})

      const { socket, fire, fireConnection } = makeSocket()
      registerHandlersForSlug(slug, socket)
      await fireConnection({ connection: 'open' })
      await fire({
        'messaging-history.set': { chats: [], contacts: [], messages: [], isLatest: true, syncType: 0, progress: 100 },
      })

      await fire({
        'chats.upsert': [
          { id: 'grp1@g.us', name: 'Team Chat' },
          { id: '111@s.whatsapp.net', name: 'Alice' },
          { id: '999@newsletter' },
        ],
      })

      const grp = chatOps.getByWhatsappJid(slug, 'grp1@g.us') as any
      const dm = chatOps.getByWhatsappJid(slug, '111@s.whatsapp.net') as any
      expect(grp.chat_type).toBe('group')
      expect(grp.enabled).toBe(1)
      expect(grp.name).toBe('Team Chat')
      expect(dm.chat_type).toBe('dm')
      expect(dm.enabled).toBe(1)
      expect(dm.name).toBe('Alice')
      expect(chatOps.getByWhatsappJid(slug, '999@newsletter')).toBeUndefined()

      expect(queueSpy).toHaveBeenCalledWith([{ chatId: grp.id, jid: 'grp1@g.us' }])
    })

    it('buffers groups when contact sync not complete, flushes them when messaging-history.set completes', async () => {
      const slug = 'buf-flush'
      setupAccount(slug)

      const fetcher = initializeGroupMetadataFetcher(slug)
      const queueSpy = vi.spyOn(fetcher, 'queueGroups').mockImplementation(() => {})
      const startSpy = vi.spyOn(fetcher, 'start').mockImplementation(() => {})

      const { socket, fire, fireConnection } = makeSocket()
      registerHandlersForSlug(slug, socket)
      await fireConnection({ connection: 'open' })

      await fire({
        'groups.upsert': [{ id: 'buffered@g.us', subject: 'Buffered' }],
      })

      const inserted = chatOps.getByWhatsappJid(slug, 'buffered@g.us') as any
      expect(inserted).toBeDefined()
      expect(inserted.enabled).toBe(1)
      expect(queueSpy).not.toHaveBeenCalled()
      expect(startSpy).not.toHaveBeenCalled()

      await fire({
        'messaging-history.set': { chats: [], contacts: [], messages: [], isLatest: true, syncType: 0, progress: 100 },
      })

      expect(queueSpy).toHaveBeenCalledWith([{ chatId: inserted.id, jid: 'buffered@g.us' }])
      expect(startSpy).toHaveBeenCalled()
    })

    it('groups.update refreshes subject and delegates to handleGroupUpdate', async () => {
      const slug = 'grp-update'
      setupAccount(slug)
      settingOps.set(slug, 'initial_sync_complete', 'true')

      chatOps.insert(slug, 'existing@g.us', 'group', undefined, 'Old Name', 0)
      const existing = chatOps.getByWhatsappJid(slug, 'existing@g.us') as any

      const fetcher = initializeGroupMetadataFetcher(slug)
      const handleSpy = vi.spyOn(fetcher, 'handleGroupUpdate').mockResolvedValue(undefined)

      const { socket, fire, fireConnection } = makeSocket()
      registerHandlersForSlug(slug, socket)
      await fireConnection({ connection: 'open' })

      await fire({
        'groups.update': [{ id: 'existing@g.us', subject: 'New Name' }],
      })

      const after = chatOps.getByWhatsappJid(slug, 'existing@g.us') as any
      expect(after.name).toBe('New Name')
      expect(existing.id).toBe(after.id)
      expect(handleSpy).toHaveBeenCalledWith([{ id: 'existing@g.us', subject: 'New Name' }])
    })

    it('group-participants.update delegates to handleParticipantsUpdate', async () => {
      const slug = 'grp-parts'
      setupAccount(slug)
      settingOps.set(slug, 'initial_sync_complete', 'true')

      const fetcher = initializeGroupMetadataFetcher(slug)
      const handleSpy = vi.spyOn(fetcher, 'handleParticipantsUpdate').mockResolvedValue(undefined)

      const { socket, fire, fireConnection } = makeSocket()
      registerHandlersForSlug(slug, socket)
      await fireConnection({ connection: 'open' })

      const payload = { id: 'g@g.us', participants: ['1@lid'], action: 'add' }
      await fire({ 'group-participants.update': payload })
      expect(handleSpy).toHaveBeenCalledWith(payload)
    })

    it('messages.upsert fallback inserts new groups with enabled=1 and queues metadata', async () => {
      const slug = 'msgs-fallback'
      setupAccount(slug)
      settingOps.set(slug, 'initial_sync_complete', 'true')

      const fetcher = initializeGroupMetadataFetcher(slug)
      const queueSpy = vi.spyOn(fetcher, 'queueGroups').mockImplementation(() => {})
      vi.spyOn(fetcher, 'start').mockImplementation(() => {})

      const { socket, fire, fireConnection } = makeSocket()
      registerHandlersForSlug(slug, socket)
      await fireConnection({ connection: 'open' })
      await fire({
        'messaging-history.set': { chats: [], contacts: [], messages: [], isLatest: true, syncType: 0, progress: 100 },
      })

      await fire({
        'messages.upsert': {
          messages: [
            { key: { remoteJid: 'surprise@g.us', id: 'm1', fromMe: false }, messageTimestamp: 1 },
          ],
        },
      })

      const chat = chatOps.getByWhatsappJid(slug, 'surprise@g.us') as any
      expect(chat).toBeDefined()
      expect(chat.chat_type).toBe('group')
      expect(chat.enabled).toBe(1)
      expect(queueSpy).toHaveBeenCalledWith([{ chatId: chat.id, jid: 'surprise@g.us' }])
    })

    it('messages.upsert persists message and updates last_activity for manually-disabled groups', async () => {
      const slug = 'msgs-disabled-persist'
      setupAccount(slug)
      settingOps.set(slug, 'initial_sync_complete', 'true')

      const fetcher = initializeGroupMetadataFetcher(slug)
      vi.spyOn(fetcher, 'queueGroups').mockImplementation(() => {})
      vi.spyOn(fetcher, 'start').mockImplementation(() => {})

      const { socket, fire, fireConnection } = makeSocket()
      registerHandlersForSlug(slug, socket)
      await fireConnection({ connection: 'open' })
      await fire({
        'messaging-history.set': { chats: [], contacts: [], messages: [], isLatest: true, syncType: 0, progress: 100 },
      })

      // First upsert auto-creates the chat (now enabled=1 by default).
      await fire({
        'messages.upsert': {
          messages: [
            {
              key: { remoteJid: 'newgroup@g.us', id: 'm1', fromMe: false },
              message: { conversation: 'first msg' },
              messageTimestamp: 1700000000,
            },
          ],
        },
      })

      const chat = chatOps.getByWhatsappJid(slug, 'newgroup@g.us') as any
      expect(chat).toBeDefined()
      const firstActivity = chat.last_activity
      expect(firstActivity).toBeTruthy()

      // Manually disable the chat, then fire a second message at a later timestamp.
      chatOps.updateEnabled(slug, chat.id, false)
      const disabled = chatOps.getByWhatsappJid(slug, 'newgroup@g.us') as any
      expect(disabled.enabled).toBe(0)

      await fire({
        'messages.upsert': {
          messages: [
            {
              key: { remoteJid: 'newgroup@g.us', id: 'm2', fromMe: false },
              message: { conversation: 'second msg after disable' },
              messageTimestamp: 1700000100,
            },
          ],
        },
      })

      // last_activity must advance and both messages must persist even though
      // the chat is disabled — proving the realtime gate is gone.
      const after = chatOps.getByWhatsappJid(slug, 'newgroup@g.us') as any
      expect(after.enabled).toBe(0)
      expect(after.last_activity).toBeTruthy()
      expect(String(after.last_activity) > String(firstActivity)).toBe(true)
      const rows = messageOps.getByChatId(slug, after.id, 10) as any[]
      expect(rows.length).toBeGreaterThanOrEqual(2)
    })
  })

  // Must run BEFORE the bringWindowToFront describe block: that block's first
  // test relies on mainWindow inside main.ts still being null. raiseWindowAboveOthers
  // must early-return on null mainWindow without constructing a BrowserWindow.
  describe('raiseWindowAboveOthers — no-window guard', () => {
    let raiseWindowAboveOthers: () => void

    beforeAll(async () => {
      const mod: any = await import('./main')
      raiseWindowAboveOthers = mod.raiseWindowAboveOthers
      expect(typeof raiseWindowAboveOthers).toBe('function')
    })

    it('with no window, is a no-op (does not construct a BrowserWindow, does not call app.focus, does not toggle setAlwaysOnTop)', () => {
      const startCount = browserWindowState.constructorCount
      browserWindowState.appFocusCalls.length = 0
      // Capture any pre-existing instance (from earlier suites) and clear its
      // setAlwaysOnTop mock so we can assert it stays untouched. May be null
      // when this test runs first.
      const inst = browserWindowState.lastInstance
      if (inst) {
        inst.setAlwaysOnTop.mockClear()
        inst.focus.mockClear()
      }

      raiseWindowAboveOthers()

      expect(browserWindowState.constructorCount).toBe(startCount)
      expect(browserWindowState.appFocusCalls).toHaveLength(0)
      if (inst) {
        expect(inst.setAlwaysOnTop).not.toHaveBeenCalled()
        expect(inst.focus).not.toHaveBeenCalled()
      }
    })
  })

  describe('bringWindowToFront', () => {
    let bringWindowToFront: () => void
    const originalPlatform = process.platform

    beforeAll(async () => {
      const mod: any = await import('./main')
      bringWindowToFront = mod.bringWindowToFront
      expect(typeof bringWindowToFront).toBe('function')
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      browserWindowState.appFocusCalls.length = 0
    })

    it('with no window, constructs a BrowserWindow via createWindow', () => {
      // Tests in this describe run in order; this one must run first so
      // mainWindow inside main.ts is still null.
      const startCount = browserWindowState.constructorCount
      bringWindowToFront()
      expect(browserWindowState.constructorCount).toBe(startCount + 1)
      expect(browserWindowState.lastInstance).not.toBeNull()
    })

    it('with a hidden, non-minimized window, calls show() and focus() (no restore)', () => {
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(false)
      inst.isMinimized.mockReturnValue(false)
      inst.show.mockClear(); inst.focus.mockClear(); inst.restore.mockClear()

      bringWindowToFront()

      expect(inst.show).toHaveBeenCalledTimes(1)
      expect(inst.focus).toHaveBeenCalledTimes(1)
      expect(inst.restore).not.toHaveBeenCalled()
    })

    it('with a minimized window, calls restore() and focus()', () => {
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(true)
      inst.isMinimized.mockReturnValue(true)
      inst.show.mockClear(); inst.focus.mockClear(); inst.restore.mockClear()

      bringWindowToFront()

      expect(inst.restore).toHaveBeenCalledTimes(1)
      expect(inst.focus).toHaveBeenCalledTimes(1)
      expect(inst.show).not.toHaveBeenCalled()
    })

    it('with a visible, non-minimized window, only calls focus() (no show/restore)', () => {
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(true)
      inst.isMinimized.mockReturnValue(false)
      inst.show.mockClear(); inst.focus.mockClear(); inst.restore.mockClear()

      bringWindowToFront()

      expect(inst.focus).toHaveBeenCalledTimes(1)
      expect(inst.show).not.toHaveBeenCalled()
      expect(inst.restore).not.toHaveBeenCalled()
    })

    it('on darwin, calls app.focus({ steal: true })', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(true)
      inst.isMinimized.mockReturnValue(false)
      browserWindowState.appFocusCalls.length = 0

      bringWindowToFront()

      expect(browserWindowState.appFocusCalls).toHaveLength(1)
      expect(browserWindowState.appFocusCalls[0]).toEqual({ steal: true })
    })

    it('on non-darwin platforms, does NOT call app.focus', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(true)
      inst.isMinimized.mockReturnValue(false)
      browserWindowState.appFocusCalls.length = 0

      bringWindowToFront()

      expect(browserWindowState.appFocusCalls).toHaveLength(0)
    })
  })

  describe('computeWindowMenuItem', () => {
    let computeWindowMenuItem: (state: { exists: boolean; visible: boolean; minimized: boolean }) =>
      { label: 'Show Window' | 'Hide Window'; action: 'show' | 'hide' }

    beforeAll(async () => {
      const mod: any = await import('./main')
      computeWindowMenuItem = mod.computeWindowMenuItem
      expect(typeof computeWindowMenuItem).toBe('function')
    })

    it('no window → "Show Window" / "show"', () => {
      expect(computeWindowMenuItem({ exists: false, visible: false, minimized: false }))
        .toEqual({ label: 'Show Window', action: 'show' })
    })

    it('hidden window → "Show Window" / "show"', () => {
      expect(computeWindowMenuItem({ exists: true, visible: false, minimized: false }))
        .toEqual({ label: 'Show Window', action: 'show' })
    })

    it('minimized window (visible=true, minimized=true) → "Show Window" / "show"', () => {
      expect(computeWindowMenuItem({ exists: true, visible: true, minimized: true }))
        .toEqual({ label: 'Show Window', action: 'show' })
    })

    it('visible and not minimized → "Hide Window" / "hide"', () => {
      expect(computeWindowMenuItem({ exists: true, visible: true, minimized: false }))
        .toEqual({ label: 'Hide Window', action: 'hide' })
    })
  })

  describe('raiseWindowAboveOthers — with window', () => {
    // Runs after the bringWindowToFront block has constructed a BrowserWindow,
    // so module-level mainWindow inside main.ts is set to lastInstance.
    let raiseWindowAboveOthers: () => void
    const originalPlatform = process.platform

    beforeAll(async () => {
      const mod: any = await import('./main')
      raiseWindowAboveOthers = mod.raiseWindowAboveOthers
      expect(typeof raiseWindowAboveOthers).toBe('function')
      // Ensure mainWindow is set in case the bringWindowToFront block was filtered out.
      if (!browserWindowState.lastInstance) mod.bringWindowToFront()
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      browserWindowState.appFocusCalls.length = 0
    })

    it('with a visible, non-minimized window, calls setAlwaysOnTop(true) → moveTop() → setAlwaysOnTop(false) (no show/restore/focus/app.focus)', () => {
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(true)
      inst.isMinimized.mockReturnValue(false)
      inst.show.mockClear(); inst.restore.mockClear(); inst.moveTop.mockClear()
      inst.setAlwaysOnTop.mockClear(); inst.focus.mockClear()
      browserWindowState.appFocusCalls.length = 0

      raiseWindowAboveOthers()

      expect(inst.setAlwaysOnTop).toHaveBeenCalledTimes(2)
      expect(inst.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true)
      expect(inst.setAlwaysOnTop).toHaveBeenNthCalledWith(2, false)
      expect(inst.moveTop).toHaveBeenCalledTimes(1)
      // Sequence: setAlwaysOnTop(true) → moveTop() → setAlwaysOnTop(false).
      const order1 = inst.setAlwaysOnTop.mock.invocationCallOrder[0]
      const orderMove = inst.moveTop.mock.invocationCallOrder[0]
      const order2 = inst.setAlwaysOnTop.mock.invocationCallOrder[1]
      expect(order1).toBeLessThan(orderMove)
      expect(orderMove).toBeLessThan(order2)
      expect(inst.show).not.toHaveBeenCalled()
      expect(inst.restore).not.toHaveBeenCalled()
      expect(inst.focus).not.toHaveBeenCalled()
      expect(browserWindowState.appFocusCalls).toHaveLength(0)
    })

    it('with a hidden window, calls show() before setAlwaysOnTop(true) (no restore/focus/app.focus)', () => {
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(false)
      inst.isMinimized.mockReturnValue(false)
      inst.show.mockClear(); inst.restore.mockClear(); inst.moveTop.mockClear()
      inst.setAlwaysOnTop.mockClear(); inst.focus.mockClear()
      browserWindowState.appFocusCalls.length = 0

      raiseWindowAboveOthers()

      expect(inst.show).toHaveBeenCalledTimes(1)
      expect(inst.setAlwaysOnTop).toHaveBeenCalledTimes(2)
      expect(inst.moveTop).toHaveBeenCalledTimes(1)
      // show() must happen before the first setAlwaysOnTop(true).
      const orderShow = inst.show.mock.invocationCallOrder[0]
      const orderAOTOn = inst.setAlwaysOnTop.mock.invocationCallOrder[0]
      expect(orderShow).toBeLessThan(orderAOTOn)
      expect(inst.restore).not.toHaveBeenCalled()
      expect(inst.focus).not.toHaveBeenCalled()
      expect(browserWindowState.appFocusCalls).toHaveLength(0)
    })

    it('with a minimized window, calls restore() before setAlwaysOnTop(true) (defensive; no focus/app.focus)', () => {
      // onTrayActivate gates this case out, but the helper itself must remain safe.
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(false)
      inst.isMinimized.mockReturnValue(true)
      inst.show.mockClear(); inst.restore.mockClear(); inst.moveTop.mockClear()
      inst.setAlwaysOnTop.mockClear(); inst.focus.mockClear()
      browserWindowState.appFocusCalls.length = 0

      raiseWindowAboveOthers()

      expect(inst.restore).toHaveBeenCalledTimes(1)
      expect(inst.show).toHaveBeenCalledTimes(1)
      expect(inst.setAlwaysOnTop).toHaveBeenCalledTimes(2)
      expect(inst.moveTop).toHaveBeenCalledTimes(1)
      // restore() must happen before the first setAlwaysOnTop(true).
      const orderRestore = inst.restore.mock.invocationCallOrder[0]
      const orderAOTOn = inst.setAlwaysOnTop.mock.invocationCallOrder[0]
      expect(orderRestore).toBeLessThan(orderAOTOn)
      expect(inst.focus).not.toHaveBeenCalled()
      expect(browserWindowState.appFocusCalls).toHaveLength(0)
    })

    it('on darwin, NEVER calls app.focus or window.focus (the whole point: keep the tray menu open)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(true)
      inst.isMinimized.mockReturnValue(false)
      inst.focus.mockClear()
      browserWindowState.appFocusCalls.length = 0

      raiseWindowAboveOthers()

      expect(browserWindowState.appFocusCalls).toHaveLength(0)
      expect(inst.focus).not.toHaveBeenCalled()
    })
  })

  describe('tray activate handler — hidden/minimized window guard', () => {
    // Mirrors the lambda inside createTray() in src/main.ts. Locks in:
    //   1. raiseWindowAboveOthers() must NOT run when the window is hidden or
    //      minimized (close-to-tray / minimize-to-tray on darwin).
    //   2. updateTrayMenu() always runs AFTER raiseWindowAboveOthers() so the
    //      menu opens with the correct label immediately.
    //   3. raiseWindowAboveOthers() (not bringWindowToFront) is used here, so
    //      app.focus({ steal: true }) is never invoked — that would dismiss
    //      the tray context menu on darwin.
    let raiseWindowAboveOthers: () => void

    beforeAll(async () => {
      const mod: any = await import('./main')
      raiseWindowAboveOthers = mod.raiseWindowAboveOthers
    })

    function onTrayActivate(
      win: { isVisible: () => boolean; isMinimized: () => boolean } | null,
      updateMenu: () => void
    ): void {
      if (win && win.isVisible() && !win.isMinimized()) raiseWindowAboveOthers()
      updateMenu()
    }

    it('does NOT call moveTop when the window exists but is hidden', () => {
      const updateMenu = vi.fn()
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(false)
      inst.isMinimized.mockReturnValue(false)
      inst.moveTop.mockClear()
      browserWindowState.appFocusCalls.length = 0

      onTrayActivate(inst, updateMenu)

      expect(updateMenu).toHaveBeenCalledTimes(1)
      expect(inst.moveTop).not.toHaveBeenCalled()
      expect(browserWindowState.appFocusCalls).toHaveLength(0)
    })

    it('does NOT call moveTop when the window is minimized', () => {
      const updateMenu = vi.fn()
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(true)
      inst.isMinimized.mockReturnValue(true)
      inst.moveTop.mockClear()
      browserWindowState.appFocusCalls.length = 0

      onTrayActivate(inst, updateMenu)

      expect(updateMenu).toHaveBeenCalledTimes(1)
      expect(inst.moveTop).not.toHaveBeenCalled()
      expect(browserWindowState.appFocusCalls).toHaveLength(0)
    })

    it('calls moveTop (and NOT app.focus) when the window is visible and not minimized', () => {
      const updateMenu = vi.fn()
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(true)
      inst.isMinimized.mockReturnValue(false)
      inst.moveTop.mockClear()
      browserWindowState.appFocusCalls.length = 0

      onTrayActivate(inst, updateMenu)

      expect(updateMenu).toHaveBeenCalledTimes(1)
      expect(inst.moveTop).toHaveBeenCalledTimes(1)
      expect(browserWindowState.appFocusCalls).toHaveLength(0)
    })

    it('with no window, only re-renders the tray menu', () => {
      const updateMenu = vi.fn()
      const inst = browserWindowState.lastInstance!
      inst.moveTop.mockClear()
      browserWindowState.appFocusCalls.length = 0

      onTrayActivate(null, updateMenu)

      expect(updateMenu).toHaveBeenCalledTimes(1)
      expect(inst.moveTop).not.toHaveBeenCalled()
      expect(browserWindowState.appFocusCalls).toHaveLength(0)
    })

    it('runs raiseWindowAboveOthers BEFORE updateTrayMenu (so menu opens with correct label)', () => {
      const calls: string[] = []
      const updateMenu = vi.fn(() => { calls.push('updateMenu') })
      const inst = browserWindowState.lastInstance!
      inst.isVisible.mockReturnValue(true)
      inst.isMinimized.mockReturnValue(false)
      inst.moveTop.mockImplementation(() => { calls.push('moveTop') })

      onTrayActivate(inst, updateMenu)

      expect(calls[0]).toBe('moveTop')
      expect(calls[calls.length - 1]).toBe('updateMenu')
      // Reset so subsequent tests get a fresh vi.fn() with no implementation.
      inst.moveTop.mockReset()
    })
  })
})

