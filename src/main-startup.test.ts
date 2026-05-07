import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'

const { testDir, dialogState, appState, mcpServerState } = vi.hoisted(() => {
  const p = require('path')
  const os = require('os')
  const testDir = p.join(
    os.tmpdir(),
    'wa-main-startup-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  )
  const dialogState: { responseQueue: Array<{ response: number }>; calls: any[] } = {
    responseQueue: [],
    calls: [],
  }
  const appState: { exitCalls: number[] } = { exitCalls: [] }
  const mcpServerState: { startCalls: number; errorQueue: Array<Error | null>; running: boolean } = {
    startCalls: 0,
    errorQueue: [],
    running: false,
  }
  return { testDir, dialogState, appState, mcpServerState }
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
    exit: (code: number) => { appState.exitCalls.push(code) },
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
  const dialog = {
    showMessageBox: async (_window: any, options: any) => {
      dialogState.calls.push(options)
      const next = dialogState.responseQueue.shift()
      if (!next) throw new Error('dialog.showMessageBox called but no queued response')
      return next
    },
  }
  return {
    app, ipcMain, BrowserWindow, Menu, Tray, nativeImage, dialog,
    default: { app, ipcMain, BrowserWindow, Menu, Tray, nativeImage, dialog },
  }
})

vi.mock('electron-updater', () => {
  const autoUpdater = {
    autoDownload: true, autoInstallOnAppQuit: true,
    on: () => {}, checkForUpdates: async () => ({}), checkForUpdatesAndNotify: async () => ({}),
    quitAndInstall: () => {},
  }
  return { autoUpdater, default: { autoUpdater } }
})

vi.mock('./mcp-server', () => ({
  startMcpServer: async (_port: number) => {
    mcpServerState.startCalls++
    const err = mcpServerState.errorQueue.shift()
    if (err) {
      mcpServerState.running = false
      throw err
    }
    mcpServerState.running = true
  },
  stopMcpServer: async () => { mcpServerState.running = false },
  isMcpServerRunning: () => mcpServerState.running,
  refreshAccount: () => {},
}))

import Settings from 'electron-settings'
import { closeAllDatabases } from './database'

function resetUserData(): void {
  try { closeAllDatabases() } catch { /* ignore */ }
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  fs.mkdirSync(testDir, { recursive: true })
  try { Settings.unsetSync() } catch { /* ignore */ }
}

let ensureMcpServerOrPrompt: () => Promise<boolean>

describe('ensureMcpServerOrPrompt', () => {
  beforeAll(async () => {
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    resetUserData()
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    const main = await import('./main')
    ensureMcpServerOrPrompt = main.ensureMcpServerOrPrompt
  })

  beforeEach(() => {
    dialogState.responseQueue.length = 0
    dialogState.calls.length = 0
    appState.exitCalls.length = 0
    mcpServerState.startCalls = 0
    mcpServerState.errorQueue.length = 0
    mcpServerState.running = false
  })

  afterAll(() => {
    Settings.reset()
    try { if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true }) }
    catch { /* ignore */ }
  })

  it('shows the failure modal once and resolves true after a successful retry', async () => {
    mcpServerState.errorQueue.push(new Error('Port 13491 is already in use'))
    dialogState.responseQueue.push({ response: 0 })

    const result = await ensureMcpServerOrPrompt()

    expect(result).toBe(true)
    expect(mcpServerState.startCalls).toBe(2)
    expect(dialogState.calls).toHaveLength(1)
    expect(dialogState.calls[0].buttons).toEqual(['Retry', 'Exit'])
    expect(dialogState.calls[0].title).toBe('MCP Server Failed to Start')
    expect(dialogState.calls[0].message).toContain('13491')
    expect(appState.exitCalls).toHaveLength(0)
  })

  it('calls app.exit(1) and resolves false when the user picks Exit', async () => {
    mcpServerState.errorQueue.push(new Error('Port 13491 is already in use'))
    dialogState.responseQueue.push({ response: 1 })

    const result = await ensureMcpServerOrPrompt()

    expect(result).toBe(false)
    expect(mcpServerState.startCalls).toBe(1)
    expect(dialogState.calls).toHaveLength(1)
    expect(appState.exitCalls).toEqual([1])
  })
})

