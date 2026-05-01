import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'

const { testDir } = vi.hoisted(() => {
  const p = require('path')
  const os = require('os')
  const testDir = p.join(
    os.tmpdir(),
    'wa-main-events-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  )
  return { testDir }
})

vi.mock('electron', () => {
  const app = {
    getPath: () => testDir,
    getVersion: () => '0.0.0-test',
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    quit: () => {},
    focus: () => {},
    dock: { hide: () => {}, show: () => {} },
  }
  const ipcMain = { handle: () => {} }
  const BrowserWindow: any = function () {
    return {
      webContents: { send: vi.fn(), once: vi.fn() },
      on: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn(),
      isVisible: vi.fn(() => false), isMinimized: vi.fn(() => false), isFocused: vi.fn(() => false),
      show: vi.fn(), hide: vi.fn(), focus: vi.fn(), restore: vi.fn(),
      moveTop: vi.fn(), setAlwaysOnTop: vi.fn(),
    }
  }
  const Menu = { buildFromTemplate: () => ({}) }
  const Tray: any = function () { return { setToolTip: () => {}, setContextMenu: () => {}, on: () => {} } }
  const nativeImage = { createFromPath: () => ({ resize: () => ({ setTemplateImage: () => {} }) }) }
  return { app, ipcMain, BrowserWindow, Menu, Tray, nativeImage, default: { app, ipcMain, BrowserWindow, Menu, Tray, nativeImage } }
})

vi.mock('electron-updater', () => {
  const autoUpdater = {
    autoDownload: true, autoInstallOnAppQuit: true,
    on: () => {}, checkForUpdates: async () => ({}), checkForUpdatesAndNotify: async () => ({}),
    quitAndInstall: () => {},
  }
  return { autoUpdater, default: { autoUpdater } }
})

import Settings from 'electron-settings'
import { addAccount } from './accounts'
import { contactOps, closeAllDatabases, initializeDatabase } from './database'
import { resetSyncOrchestrators } from './sync-orchestrator'
import { resetGroupMetadataFetchers } from './group-metadata-fetcher'

let registerHandlersForSlug: (slug: string, socket: any) => void

const SLUG = 'events-acct'
const LID = '111222333@lid'
const PN = '15551234567@s.whatsapp.net'

function buildFakeSocket() {
  let processCb: ((events: Record<string, any>) => Promise<void> | void) | null = null
  const onListeners: Record<string, ((arg: any) => void)[]> = {}
  return {
    user: { id: PN },
    ev: {
      on: (name: string, cb: (arg: any) => void) => {
        (onListeners[name] ||= []).push(cb)
      },
      process: (cb: (events: Record<string, any>) => Promise<void> | void) => {
        processCb = cb
      },
    },
    fire: async (events: Record<string, any>) => {
      if (!processCb) throw new Error('process() callback was not registered')
      await processCb(events)
    },
    onListeners,
  }
}

function resetUserData(): void {
  try { closeAllDatabases() } catch { /* ignore */ }
  resetSyncOrchestrators()
  resetGroupMetadataFetchers()
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  fs.mkdirSync(testDir, { recursive: true })
  try { Settings.unsetSync() } catch { /* ignore */ }
}

describe('main.ts realtime LID/PN harvesting', () => {
  beforeAll(async () => {
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    resetUserData()
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    const main = await import('./main')
    registerHandlersForSlug = main.registerHandlersForSlug
  })

  beforeEach(() => {
    resetUserData()
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    addAccount(SLUG)
    initializeDatabase(SLUG)
  })

  afterAll(() => {
    closeAllDatabases()
    Settings.reset()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('persists rows from contacts.upsert', async () => {
    const sock = buildFakeSocket()
    registerHandlersForSlug(SLUG, sock)
    await sock.fire({
      'contacts.upsert': [{ id: PN, lid: LID, name: 'Carol' }],
    })
    const pnRow = contactOps.getByJid(SLUG, PN) as any
    expect(pnRow).toBeTruthy()
    expect(pnRow.lid).toBe(LID)
    expect(pnRow.name).toBe('Carol')
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
  })

  it('persists rows from contacts.update (Partial<Contact>)', async () => {
    const sock = buildFakeSocket()
    registerHandlersForSlug(SLUG, sock)
    await sock.fire({
      'contacts.update': [{ id: PN, lid: LID }],
    })
    expect((contactOps.getByJid(SLUG, PN) as any).lid).toBe(LID)
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
  })

  it('harvests LID↔PN from messages.upsert keys before processing', async () => {
    const sock = buildFakeSocket()
    registerHandlersForSlug(SLUG, sock)
    await sock.fire({
      'messages.upsert': {
        type: 'notify',
        messages: [{
          key: { remoteJid: 'group@g.us', participant: LID, participantAlt: PN, addressingMode: 'lid', id: 'M1' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        }],
      },
    })
    expect((contactOps.getByJid(SLUG, PN) as any)?.lid).toBe(LID)
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
  })

  it('persists pair on lid-mapping.update', async () => {
    const sock = buildFakeSocket()
    registerHandlersForSlug(SLUG, sock)
    await sock.fire({ 'lid-mapping.update': { lid: LID, pn: PN } })
    expect((contactOps.getByJid(SLUG, PN) as any)?.lid).toBe(LID)
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
  })
})

