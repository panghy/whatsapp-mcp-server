import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, dialog } from 'electron'
import path from 'path'
import Settings from 'electron-settings'
import fs from 'fs'
import { autoUpdater } from 'electron-updater'
import {
  initializeWhatsApp,
  disconnectWhatsApp,
  clearWhatsAppSession,
  getManager,
  WhatsAppManager
} from './whatsapp-manager'
import {
  initializeDatabase,
  closeDatabase,
  chatOps,
  contactOps,
  messageOps,
  logOps,
  settingOps,
  getDatabase
} from './database'
import { initializeSyncOrchestrator, getSyncOrchestrator } from './sync-orchestrator'
import { MessageTransformer, extractPhoneFromJid, normalizePhoneNumber } from './message-transformer'
import { initializeGroupMetadataFetcher, getGroupMetadataFetcher } from './group-metadata-fetcher'
import {
  startMcpServer,
  stopMcpServer,
  isMcpServerRunning,
  refreshAccount as refreshMcpAccount
} from './mcp-server'
import {
  migrateLegacyLayoutIfNeeded,
  listAccounts,
  getAccount,
  addAccount,
  removeAccount,
  renameAccount,
  getDefaultSlug,
  setDefaultSlug,
  setMcpEnabled,
  accountAuthDir,
  isValidSlug,
  DEFAULT_SLUG as FALLBACK_SLUG
} from './accounts'
import {
  getMcpPort as getGlobalMcpPort,
  setMcpPort as setGlobalMcpPort,
  getMcpAutoStart as getGlobalMcpAutoStart,
  setMcpAutoStart as setGlobalMcpAutoStart
} from './global-settings'

// Auto-updater configuration
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
interface UpdateState {
  status: UpdateStatus
  version: string | null
  error: string | null
  progress: number | null
}
let updateState: UpdateState = { status: 'idle', version: null, error: null, progress: null }

function sendUpdateStatus() {
  mainWindow?.webContents.send('update-status', updateState)
}

autoUpdater.on('checking-for-update', () => {
  console.log('[AutoUpdater] Checking for updates...')
  updateState = { status: 'checking', version: null, error: null, progress: null }
  sendUpdateStatus()
})

autoUpdater.on('update-available', (info) => {
  console.log('[AutoUpdater] Update available:', info.version)
  updateState = { status: 'available', version: info.version, error: null, progress: null }
  sendUpdateStatus()
})

autoUpdater.on('update-not-available', (info) => {
  console.log('[AutoUpdater] No update available:', info.version)
  updateState = { status: 'not-available', version: info.version, error: null, progress: null }
  sendUpdateStatus()
})

autoUpdater.on('download-progress', (progressObj) => {
  console.log('[AutoUpdater] Download progress:', progressObj.percent)
  updateState = { ...updateState, status: 'downloading', progress: progressObj.percent }
  sendUpdateStatus()
})

autoUpdater.on('update-downloaded', (info) => {
  console.log('[AutoUpdater] Update downloaded:', info.version)
  updateState = { status: 'downloaded', version: info.version, error: null, progress: 100 }
  sendUpdateStatus()
})

autoUpdater.on('error', (err) => {
  console.log('[AutoUpdater] Error:', err.message)
  updateState = { status: 'error', version: null, error: err.message, progress: null }
  sendUpdateStatus()
})

// MCP server status tracking
type McpStatus = 'stopped' | 'starting' | 'running' | 'port_conflict' | 'error'
let mcpStatus: McpStatus = 'stopped'
let mcpError: string | null = null

function isNewsletterOrBroadcast(jid: string): boolean {
  return jid.endsWith('@newsletter') || jid === 'status@broadcast'
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function hasAuth(slug: string): boolean {
  try {
    const dir = accountAuthDir(slug)
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * Best-effort log destination for server-wide events (the MCP port is shared
 * across accounts, so events need to land in *some* account's log table).
 * Picks the default account, else the first account, else drops the log.
 */
function logServerEvent(level: string, category: string, message: string): void {
  const slug = getDefaultSlug() ?? listAccounts()[0]?.slug
  if (!slug) return
  try { logOps.insert(slug, level, category, message) } catch { /* db may not be ready */ }
}

async function startMcpServerSafe(): Promise<void> {
  if (isMcpServerRunning()) {
    console.log('[MCP] Server already running')
    return
  }

  const port = getGlobalMcpPort()
  mcpStatus = 'starting'
  mcpError = null

  try {
    await startMcpServer(port)
    mcpStatus = 'running'
    console.log(`[MCP] Server started on port ${port}`)
    logServerEvent('info', 'mcp', `MCP server started on port ${port}`)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    if (errMsg.includes('already in use') || errMsg.includes('EADDRINUSE')) {
      mcpStatus = 'port_conflict'
      mcpError = `Port ${port} is already in use`
      console.error(`[MCP] Port conflict: ${mcpError}`)
      logServerEvent('error', 'mcp', mcpError)
    } else {
      mcpStatus = 'error'
      mcpError = errMsg
      console.error(`[MCP] Failed to start: ${errMsg}`)
      logServerEvent('error', 'mcp', `Failed to start MCP server: ${errMsg}`)
    }
  }
}

async function stopMcpServerSafe(): Promise<void> {
  if (!isMcpServerRunning()) {
    mcpStatus = 'stopped'
    return
  }

  try {
    await stopMcpServer()
    mcpStatus = 'stopped'
    mcpError = null
    console.log('[MCP] Server stopped')
    logServerEvent('info', 'mcp', 'MCP server stopped')
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error(`[MCP] Failed to stop: ${errMsg}`)
    mcpStatus = 'error'
    mcpError = errMsg
  }
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  const isDev = process.env.VITE_DEV_SERVER_URL
  if (isDev) {
    mainWindow.loadURL(isDev)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, 'index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null; updateTrayMenu() })
  mainWindow.on('minimize', () => { mainWindow?.hide() })

  mainWindow.on('close', (event) => {
    if (!isQuitting && mainWindow) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('show', () => {
    if (process.platform === 'darwin') app.dock?.show()
    updateTrayMenu()
  })
  mainWindow.on('hide', () => {
    if (process.platform === 'darwin') app.dock?.hide()
    updateTrayMenu()
  })
  mainWindow.on('focus', () => { updateTrayMenu() })
  mainWindow.on('blur', () => { updateTrayMenu() })
}

export function bringWindowToFront(): void {
  if (!mainWindow) { createWindow(); return }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}

export type WindowMenuItem = { label: 'Show Window' | 'Hide Window'; action: 'show' | 'hide' }

export function computeWindowMenuItem(state: {
  exists: boolean
  visible: boolean
  focused: boolean
}): WindowMenuItem {
  if (state.exists && state.visible && state.focused) {
    return { label: 'Hide Window', action: 'hide' }
  }
  return { label: 'Show Window', action: 'show' }
}

const showMainWindowAndSend = (channel: string, payload?: any) => {
  const hadWindow = mainWindow !== null
  bringWindowToFront()
  if (hadWindow) {
    mainWindow!.webContents.send(channel, payload)
  } else {
    mainWindow!.webContents.once('did-finish-load', () => {
      mainWindow!.webContents.send(channel, payload)
    })
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason)
})

const updateTrayMenu = () => {
  if (!tray) return
  const accounts = listAccounts()
  const accountItems: Electron.MenuItemConstructorOptions[] = accounts.map((acc) => {
    const mgr = getManager(acc.slug)
    const state: string = mgr?.state ?? 'disconnected'
    const stateLabel = state.charAt(0).toUpperCase() + state.slice(1)
    const isDefault = getDefaultSlug() === acc.slug
    const label = `${acc.slug}${isDefault ? ' (default)' : ''}: ${stateLabel}`
    return {
      label,
      click: () => { showMainWindowAndSend('focus-account', acc.slug) }
    }
  })

  const anyConnected = accounts.some(a => getManager(a.slug)?.state === 'connected')
  const topStatus = accounts.length === 0 ? 'No accounts' : (anyConnected ? 'Connected' : 'Disconnected')

  const item = computeWindowMenuItem({
    exists: mainWindow !== null,
    visible: mainWindow?.isVisible() ?? false,
    focused: mainWindow?.isFocused() ?? false,
  })
  const firstItem: Electron.MenuItemConstructorOptions = {
    label: item.label,
    click: () => {
      if (item.action === 'hide') { mainWindow?.hide() }
      else { bringWindowToFront() }
    },
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    firstItem,
    { label: `Status: ${topStatus}`, enabled: false },
    { type: 'separator' }
  ]
  if (accountItems.length > 0) {
    template.push({ label: 'Accounts', submenu: accountItems })
    template.push({ type: 'separator' })
  }
  template.push(
    { label: 'Settings...', click: () => { showMainWindowAndSend('open-settings') } },
    { label: 'Logs...', click: () => { showMainWindowAndSend('open-logs') } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit() } }
  )
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

const createTray = () => {
  try {
    const iconPath = path.join(__dirname, './icon.png')
    const icon = nativeImage.createFromPath(iconPath)
    const trayIcon = icon.resize({ width: 18, height: 18 })
    trayIcon.setTemplateImage(true)
    tray = new Tray(trayIcon)
    tray.setToolTip('WhatsApp MCP Server')
    // On macOS the context menu opens via setContextMenu; on Windows the
    // tray-icon double-click is the standard "show window" gesture.
    const onTrayActivate = () => {
      updateTrayMenu()
      if (mainWindow) bringWindowToFront()
    }
    tray.on('click', onTrayActivate)
    tray.on('double-click', onTrayActivate)
    updateTrayMenu()
  } catch {
    console.log('Tray icon not found, continuing without tray')
  }
}


/**
 * Register Baileys event handlers for a given slug/socket.
 * Called on initial connect and again on every reconnect (via onSocketCreated).
 */
export function registerHandlersForSlug(slug: string, socket: any): void {
  console.log(`[SETUP:${slug}] Registering event handlers on socket...`)
  const syncOrchestrator = initializeSyncOrchestrator(slug, socket)
  const messageTransformer = new MessageTransformer(slug, socket)
  syncOrchestrator.setMessageTransformer(messageTransformer)

  const groupMetadataFetcher = initializeGroupMetadataFetcher(slug)
  groupMetadataFetcher.setSocket(socket)

  let contactSyncComplete = false
  let pendingGroupsBuffer: Array<{ chatId: number; jid: string }> = []

  const flushPendingGroups = () => {
    if (pendingGroupsBuffer.length > 0) {
      console.log(`[GroupMetadata:${slug}] Flushing ${pendingGroupsBuffer.length} buffered groups`)
      groupMetadataFetcher.queueGroups(pendingGroupsBuffer)
      groupMetadataFetcher.start()
      pendingGroupsBuffer = []
    }
  }

  // Upsert a single chat entry from chats.upsert or groups.upsert. Returns
  // the new chatId + group flag when a row was inserted so the caller can
  // queue it for metadata fetching. Returns null for newsletters, broadcasts,
  // and already-known chats (name is refreshed in place for those).
  const upsertDiscoveredChat = (entry: any, forceGroup: boolean): { chatId: number; jid: string; isGroup: boolean } | null => {
    const jid: string | undefined = entry?.id
    if (!jid || isNewsletterOrBroadcast(jid)) return null
    const isGroup = forceGroup || jid.includes('@g.us')
    const chatType = isGroup ? 'group' : 'dm'
    let chatName: string | undefined = entry.subject || entry.name || undefined
    const existing = chatOps.getByWhatsappJid(slug, jid) as any
    if (existing) {
      if (!existing.name && chatName) { chatOps.updateName(slug, existing.id, chatName) }
      return null
    }
    if (!chatName && !isGroup) {
      const contact = contactOps.getByJid(slug, jid) as any
      if (contact?.name) { chatName = contact.name }
    }
    const enabled = isGroup ? 0 : 1
    const result = chatOps.insert(slug, jid, chatType, undefined, chatName, enabled)
    const chatId = (result as any).lastInsertRowid as number
    return { chatId, jid, isGroup }
  }

  const queueOrBufferGroups = (groups: Array<{ chatId: number; jid: string }>) => {
    if (groups.length === 0) return
    if (contactSyncComplete) { groupMetadataFetcher.queueGroups(groups); groupMetadataFetcher.start() }
    else { pendingGroupsBuffer.push(...groups) }
  }

  socket.ev.on('connection.update', async (update: any) => {
    if (update.connection === 'open') {
      console.log(`[Connection:${slug}] open`)
      updateTrayMenu()

      const userJid = socket.user?.id
      if (userJid) {
        const userPhone = extractPhoneFromJid(userJid)
        if (userPhone) { settingOps.set(slug, 'user_phone', userPhone); console.log(`[Connection:${slug}] Stored user phone:`, userPhone) }
      }

      const initialSyncDone = settingOps.get(slug, 'initial_sync_complete')
      if (initialSyncDone === 'true') {
        console.log(`[Connection:${slug}] Initial history sync already completed, skipping sync state`)
        logOps.insert(slug, 'info', 'connection', 'WhatsApp reconnected, history already synced')
        try {
          const groupsNeedingMetadata = chatOps.getGroupsNeedingMetadata(slug) as any[]
          if (groupsNeedingMetadata.length > 0) {
            console.log(`[GroupMetadata:${slug}] Found ${groupsNeedingMetadata.length} groups needing metadata on reconnect`)
            const groupsToQueue = groupsNeedingMetadata.map(g => ({ chatId: g.id, jid: g.whatsapp_jid }))
            groupMetadataFetcher.queueGroups(groupsToQueue)
            groupMetadataFetcher.start()
          }
        } catch (error) { console.error(`[GroupMetadata:${slug}] Failed to check for groups needing metadata:`, error) }

        try {
          const crossResolvedLid = contactOps.crossResolveLidNames(slug)
          const crossResolvedDm = contactOps.crossResolveDmNames(slug)
          const chatBackfill = chatOps.backfillDmNames(slug)
          if (crossResolvedLid.changes > 0 || crossResolvedDm.changes > 0 || chatBackfill.changes > 0) {
            console.log(`[Reconnect:${slug}] Resolve pass: ${crossResolvedLid.changes} LID names, ${crossResolvedDm.changes} DM names, ${chatBackfill.changes} chat names`)
          }
        } catch (error) { console.error(`[Reconnect:${slug}] Cross-resolve/backfill failed:`, error) }
      } else {
        syncOrchestrator.markSyncInProgress()
        logOps.insert(slug, 'info', 'connection', 'WhatsApp connected, waiting for history sync...')
      }
    } else if (update.connection === 'close') {
      updateTrayMenu()
    }
  })

  socket.ev.process(async (events: Record<string, any>) => {
    const eventNames = Object.keys(events)
    if (eventNames.length > 0) { console.log(`[EVENTS:${slug}] ${eventNames.join(', ')}`) }

    if (events['messaging-history.set']) {
      const { chats, contacts, messages, isLatest, syncType, progress } = events['messaging-history.set']
      console.log(`[HistorySync:${slug}] batch: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages`)

      if (contacts && contacts.length > 0) {
        for (const contact of contacts) {
          const jid = contact.id
          const name = contact.name || contact.notify || undefined
          const phone = contact.phoneNumber ? normalizePhoneNumber(contact.phoneNumber) ?? undefined : (jid ? extractPhoneFromJid(jid) ?? undefined : undefined)
          const lid = contact.lid || undefined
          if (jid && (name || phone || lid)) { contactOps.insert(slug, jid, name, phone, lid) }
        }
      }

      if (chats && chats.length > 0) {
        const newGroupsToFetch: Array<{ chatId: number; jid: string }> = []
        for (const chat of chats) {
          const jid = chat.id
          if (!jid || isNewsletterOrBroadcast(jid)) continue
          let chatName = chat.name || chat.subject || undefined
          let dbChat = chatOps.getByWhatsappJid(slug, jid) as any
          if (!dbChat) {
            const chatType = jid.includes('@g.us') ? 'group' : 'dm'
            if (!chatName && chatType === 'dm') {
              const contact = contactOps.getByJid(slug, jid) as any
              if (contact?.name) { chatName = contact.name }
            }
            const result = chatOps.insert(slug, jid, chatType, undefined, chatName)
            const chatId = (result as any).lastInsertRowid
            dbChat = { id: chatId, whatsapp_jid: jid, chat_type: chatType, name: chatName }
            if (chatType === 'group') { newGroupsToFetch.push({ chatId, jid }) }
          } else if (!dbChat.name && chatName) { chatOps.updateName(slug, dbChat.id, chatName) }
        }
        if (newGroupsToFetch.length > 0) {
          if (contactSyncComplete) { groupMetadataFetcher.queueGroups(newGroupsToFetch); groupMetadataFetcher.start() }
          else { pendingGroupsBuffer.push(...newGroupsToFetch) }
        }
      }

      if (messages && messages.length > 0) {
        for (const msg of messages) {
          const jid = msg.key?.remoteJid
          if (!jid || isNewsletterOrBroadcast(jid)) continue
          let chat = chatOps.getByWhatsappJid(slug, jid) as any
          if (!chat) {
            const chatType = jid.includes('@g.us') ? 'group' : 'dm'
            const enabled = chatType === 'dm' ? 1 : 0
            const result = chatOps.insert(slug, jid, chatType, undefined, undefined, enabled)
            const chatId = (result as any).lastInsertRowid
            chat = { id: chatId, whatsapp_jid: jid, chat_type: chatType, enabled }
            if (chatType === 'group') {
              const newGroup = [{ chatId, jid }]
              if (contactSyncComplete) { groupMetadataFetcher.queueGroups(newGroup); groupMetadataFetcher.start() }
              else { pendingGroupsBuffer.push(...newGroup) }
            }
          }
          try { await messageTransformer.processMessage(msg, chat.id) } catch (error) { console.error(`[HistorySync:${slug}] Failed to process message:`, error) }
        }
        const totalMessageCount = messageOps.getCount(slug)
        console.log(`[HistorySync:${slug}] After batch: ${messages.length} messages processed, total in DB: ${totalMessageCount}`)
      }

      if (!contactSyncComplete && syncType === 2 && progress != null && progress >= 100) {
        console.log(`[ContactSync:${slug}] Contact sync complete (progress: ${progress}%)`)
        contactSyncComplete = true
        contactOps.crossResolveLidNames(slug); contactOps.crossResolveDmNames(slug); chatOps.backfillDmNames(slug)
        flushPendingGroups()
      }

      if (isLatest) {
        console.log(`[HistorySync:${slug}] Complete!`)
        logOps.insert(slug, 'info', 'sync', 'History sync complete')
        syncOrchestrator.markSyncComplete()
        settingOps.set(slug, 'initial_sync_complete', 'true')
        if (!contactSyncComplete && syncType !== 5) {
          contactSyncComplete = true
          contactOps.crossResolveLidNames(slug); contactOps.crossResolveDmNames(slug); chatOps.backfillDmNames(slug)
          flushPendingGroups()
        }
      }
    }

    if (events['messages.upsert']) {
      const { messages: newMessages } = events['messages.upsert']
      if (newMessages && newMessages.length > 0) {
        for (const msg of newMessages) {
          const jid = msg.key?.remoteJid
          if (!jid || isNewsletterOrBroadcast(jid)) continue
          let chat = chatOps.getByWhatsappJid(slug, jid) as any
          if (!chat) {
            const chatType = jid.includes('@g.us') ? 'group' : 'dm'
            const chatName = chatType === 'dm' ? (contactOps.getByJid(slug, jid) as any)?.name : undefined
            const enabled = chatType === 'dm' ? 1 : 0
            const result = chatOps.insert(slug, jid, chatType, undefined, chatName, enabled)
            const chatId = (result as any).lastInsertRowid
            chat = { id: chatId, whatsapp_jid: jid, chat_type: chatType, enabled }
            if (chatType === 'group') {
              const newGroup = [{ chatId, jid }]
              if (contactSyncComplete) { groupMetadataFetcher.queueGroups(newGroup); groupMetadataFetcher.start() }
              else { pendingGroupsBuffer.push(...newGroup) }
            }
          }
          if (chat.enabled) {
            try { await messageTransformer.processMessage(msg, chat.id) }
            catch (error) { console.error(`[RealTime:${slug}] Failed to process message:`, error) }
          }
        }
        console.log(`[RealTime:${slug}] Processed ${newMessages.length} new message(s)`)
      }
    }

    if (events['messages.update']) {
      for (const update of events['messages.update']) {
        if (update.update?.message) {
          const jid = update.key?.remoteJid
          if (!jid || isNewsletterOrBroadcast(jid)) continue
          const chat = chatOps.getByWhatsappJid(slug, jid) as any
          if (chat?.enabled) {
            try { await messageTransformer.processMessageEdit(update.key, update.update, chat.id, update.key?.participant) }
            catch (error) { console.error(`[RealTime:${slug}] Failed to process message edit:`, error) }
          }
        }
      }
    }

    if (events['messages.delete']) {
      const deleteEvent = events['messages.delete']
      if (deleteEvent && 'keys' in deleteEvent) {
        for (const key of deleteEvent.keys) {
          const jid = key.remoteJid
          if (!jid || isNewsletterOrBroadcast(jid)) continue
          const chat = chatOps.getByWhatsappJid(slug, jid) as any
          if (chat?.enabled) {
            try { await messageTransformer.processMessageDeletion(key, chat.id, deleteEvent.participant || key.participant) }
            catch (error) { console.error(`[RealTime:${slug}] Failed to process message deletion:`, error) }
          }
        }
      }
    }

    if (events['groups.upsert']) {
      const payload = events['groups.upsert'] as any[]
      const newGroups: Array<{ chatId: number; jid: string }> = []
      for (const group of payload) {
        const res = upsertDiscoveredChat(group, true)
        if (res) newGroups.push({ chatId: res.chatId, jid: res.jid })
      }
      if (newGroups.length > 0) {
        console.log(`[GroupsUpsert:${slug}] Discovered ${newGroups.length} new group(s)`)
        logOps.insert(slug, 'info', 'groups', `Discovered ${newGroups.length} new group(s) via groups.upsert`)
      }
      queueOrBufferGroups(newGroups)
    }

    if (events['chats.upsert']) {
      const payload = events['chats.upsert'] as any[]
      const newGroups: Array<{ chatId: number; jid: string }> = []
      for (const chat of payload) {
        const res = upsertDiscoveredChat(chat, false)
        if (res?.isGroup) newGroups.push({ chatId: res.chatId, jid: res.jid })
      }
      if (newGroups.length > 0) {
        console.log(`[ChatsUpsert:${slug}] Discovered ${newGroups.length} new group(s) in chats.upsert batch`)
        logOps.insert(slug, 'info', 'chats', `Discovered ${newGroups.length} new group(s) via chats.upsert`)
      }
      queueOrBufferGroups(newGroups)
    }

    if (events['groups.update']) {
      const updates = events['groups.update'] as any[]
      for (const upd of updates) {
        if (!upd?.id) continue
        if (upd.subject) {
          const existing = chatOps.getByWhatsappJid(slug, upd.id) as any
          if (existing) { chatOps.updateName(slug, existing.id, upd.subject) }
        }
      }
      try { await groupMetadataFetcher.handleGroupUpdate(updates) }
      catch (error) { console.error(`[RealTime:${slug}] groups.update failed:`, error) }
    }

    if (events['group-participants.update']) {
      try { await groupMetadataFetcher.handleParticipantsUpdate(events['group-participants.update']) }
      catch (error) { console.error(`[RealTime:${slug}] group-participants.update failed:`, error) }
    }
  })
}




/**
 * Initialize the WhatsApp manager for `slug` and wire event handlers,
 * including re-registering them whenever Baileys creates a fresh socket
 * on reconnect.
 */
async function setupWhatsAppConnection(slug: string): Promise<WhatsAppManager> {
  const manager = await initializeWhatsApp(slug)
  if (manager.socket) {
    registerHandlersForSlug(slug, manager.socket)
  }
  manager.onSocketCreated = (socket) => {
    console.log(`[RECONNECT:${slug}] Re-registering event handlers...`)
    registerHandlersForSlug(slug, socket)
  }
  return manager
}

app.whenReady().then(async () => {
  try { migrateLegacyLayoutIfNeeded() }
  catch (error) { console.error('[migration] Failed to migrate legacy layout:', error) }

  // Ensure at least one account exists so we can key DB/session by slug.
  if (listAccounts().length === 0) {
    try { addAccount(FALLBACK_SLUG) }
    catch (error) { console.error('[accounts] Failed to create default account:', error) }
  }

  // Open a DB for every registered account up front so IPC calls that
  // target any slug can hit `getDatabase(slug)` without racing init.
  for (const account of listAccounts()) {
    try { initializeDatabase(account.slug) }
    catch (error) { console.error(`[db] Failed to initialize database for "${account.slug}":`, error) }
  }

  createTray()

  if (process.platform === 'darwin') {
    app.dock?.hide()
  }

  createWindow()

  autoUpdater.checkForUpdatesAndNotify()
  const FOUR_HOURS = 4 * 60 * 60 * 1000
  setInterval(() => { autoUpdater.checkForUpdates() }, FOUR_HOURS)

  // Auto-reconnect every account that already has saved auth.
  for (const account of listAccounts()) {
    if (!hasAuth(account.slug)) continue
    try { await setupWhatsAppConnection(account.slug) }
    catch (error) { console.error(`[auto-connect:${account.slug}] failed:`, error) }
  }

  // Start the MCP server (routes per-slug internally).
  if (getGlobalMcpAutoStart()) {
    await startMcpServerSafe()
  }

  app.on('activate', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus() }
    else { createWindow() }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { app.quit() }
})

app.on('before-quit', () => { isQuitting = true })

// ---------------------------------------------------------------------------
// IPC: app-level (no slug)
// ---------------------------------------------------------------------------

ipcMain.handle('get-auto-launch', async () => app.getLoginItemSettings().openAtLogin)

ipcMain.handle('set-auto-launch', async (_, enabled: boolean) => {
  await Settings.set('autoLaunch', enabled)
  app.setLoginItemSettings({ openAtLogin: enabled })
  return true
})

ipcMain.handle('get-app-version', () => app.getVersion())

ipcMain.handle('check-for-updates', async () => {
  try { await autoUpdater.checkForUpdates(); return { success: true } }
  catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
})

ipcMain.handle('get-update-status', async () => updateState)

ipcMain.handle('quit-and-install', async () => {
  isQuitting = true
  autoUpdater.quitAndInstall()
})

// ---------------------------------------------------------------------------
// IPC: account registry
// ---------------------------------------------------------------------------

ipcMain.handle('accounts-list', async () => ({
  accounts: listAccounts(),
  defaultSlug: getDefaultSlug(),
}))

ipcMain.handle('accounts-add', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  if (!isValidSlug(slug)) throw new Error(`Invalid slug: ${JSON.stringify(slug)}`)
  const account = addAccount(slug)
  initializeDatabase(slug)
  updateTrayMenu()
  return account
})

ipcMain.handle('accounts-remove', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  if (!getAccount(slug)) throw new Error(`Account not found: ${slug}`)
  const mgr = getManager(slug)
  if (mgr && (mgr.state === 'connected' || mgr.state === 'connecting')) {
    throw new Error(`Cannot remove account "${slug}" while connected. Disconnect first.`)
  }
  if (mgr) { try { await disconnectWhatsApp(mgr) } catch { /* ignore */ } }
  try { closeDatabase(slug) } catch { /* ignore */ }
  removeAccount(slug)
  refreshMcpAccount(slug)
  updateTrayMenu()
  return { success: true, defaultSlug: getDefaultSlug() }
})

ipcMain.handle('accounts-rename', async (_, payload: { oldSlug: string; newSlug: string }) => {
  const { oldSlug, newSlug } = payload || ({} as any)
  if (!getAccount(oldSlug)) throw new Error(`Account not found: ${oldSlug}`)
  if (!isValidSlug(newSlug)) throw new Error(`Invalid slug: ${JSON.stringify(newSlug)}`)
  const mgr = getManager(oldSlug)
  if (mgr && (mgr.state === 'connected' || mgr.state === 'connecting')) {
    throw new Error(`Cannot rename account "${oldSlug}" while connected. Disconnect first.`)
  }
  try { closeDatabase(oldSlug) } catch { /* ignore */ }
  renameAccount(oldSlug, newSlug)
  initializeDatabase(newSlug)
  refreshMcpAccount(oldSlug)
  refreshMcpAccount(newSlug)
  updateTrayMenu()
  return getAccount(newSlug)
})

ipcMain.handle('accounts-set-default', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  setDefaultSlug(slug)
  updateTrayMenu()
  return { success: true }
})

ipcMain.handle('accounts-get-mcp-urls', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  if (!getAccount(slug)) throw new Error(`Account not found: ${slug}`)
  const isDefault = getDefaultSlug() === slug
  return {
    path: `/mcp/${slug}`,
    alias: isDefault ? '/mcp' : undefined
  }
})

// ---------------------------------------------------------------------------
// IPC: per-account WhatsApp lifecycle
// ---------------------------------------------------------------------------

ipcMain.handle('whatsapp-connect', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  if (!getAccount(slug)) throw new Error(`Account not found: ${slug}`)
  try {
    const manager = await setupWhatsAppConnection(slug)
    return { state: manager.state, qrCode: manager.qrCode, error: manager.error }
  } catch (error) {
    console.error(`Failed to connect WhatsApp for "${slug}":`, error)
    throw error
  }
})

ipcMain.handle('whatsapp-disconnect', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  const mgr = getManager(slug)
  if (mgr) { await disconnectWhatsApp(mgr) }
  updateTrayMenu()
  return { success: true }
})

ipcMain.handle('whatsapp-status', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  const has = hasAuth(slug)
  const mgr = getManager(slug)
  if (!mgr) return { state: 'disconnected', qrCode: null, error: null, hasAuth: has }
  return { state: mgr.state, qrCode: mgr.qrCode, error: mgr.error, hasAuth: has }
})

// whatsapp-logout: per spec, does NOT wipe DB. Disconnects + disables MCP for slug.
ipcMain.handle('whatsapp-logout', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  if (!getAccount(slug)) throw new Error(`Account not found: ${slug}`)
  const mgr = getManager(slug)
  if (mgr) { try { await disconnectWhatsApp(mgr) } catch (e) { console.error(`Disconnect failed for "${slug}":`, e) } }
  try { setMcpEnabled(slug, false); refreshMcpAccount(slug) }
  catch (e) { console.error(`setMcpEnabled failed for "${slug}":`, e) }
  updateTrayMenu()
  return { success: true }
})

// whatsapp-clear-session: disconnect and wipe auth dir so the user can re-pair.
ipcMain.handle('whatsapp-clear-session', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  if (!getAccount(slug)) throw new Error(`Account not found: ${slug}`)
  const mgr = getManager(slug)
  if (mgr) { try { await disconnectWhatsApp(mgr) } catch (e) { console.error(`Disconnect failed for "${slug}":`, e) } }
  await clearWhatsAppSession(slug)
  updateTrayMenu()
  return { success: true }
})

// relink-whatsapp: alias of clear-session (clears auth so QR flow re-pairs).
ipcMain.handle('relink-whatsapp', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  if (!getAccount(slug)) throw new Error(`Account not found: ${slug}`)
  const mgr = getManager(slug)
  if (mgr) { try { await disconnectWhatsApp(mgr) } catch (e) { console.error(`Disconnect failed for "${slug}":`, e) } }
  await clearWhatsAppSession(slug)
  updateTrayMenu()
  return { success: true }
})


// ---------------------------------------------------------------------------
// IPC: per-account display name / user settings
// ---------------------------------------------------------------------------

ipcMain.handle('get-user-display-name', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  try { return settingOps.get(slug, 'user_display_name') || '' }
  catch (error) { console.error('Failed to get user display name:', error); return '' }
})

ipcMain.handle('set-user-display-name', async (_, payload: { slug: string; name: string }) => {
  const { slug, name } = payload || ({} as any)
  try { settingOps.set(slug, 'user_display_name', name); return true }
  catch (error) { console.error('Failed to set user display name:', error); throw error }
})

// ---------------------------------------------------------------------------
// IPC: per-account chats / messages / contacts
// ---------------------------------------------------------------------------

ipcMain.handle('get-chats', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  try { return chatOps.getAll(slug) }
  catch (error) { console.error('Failed to get chats:', error); throw error }
})

ipcMain.handle('get-groups', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  try { return chatOps.getAll(slug) }
  catch (error) { console.error('Failed to get groups:', error); throw error }
})

ipcMain.handle('get-chat', async (_, payload: { slug: string; chatId: number }) => {
  const { slug, chatId } = payload || ({} as any)
  try { return chatOps.getById(slug, chatId) }
  catch (error) { console.error('Failed to get chat:', error); throw error }
})

ipcMain.handle('toggle-chat', async (_, payload: { slug: string; chatId: number; enabled: boolean }) => {
  const { slug, chatId, enabled } = payload || ({} as any)
  try {
    chatOps.updateEnabled(slug, chatId, enabled)
    if (enabled) {
      const chat = chatOps.getById(slug, chatId) as any
      if (chat && chat.chat_type === 'group') {
        try { await getSyncOrchestrator(slug).syncEnabledGroup(chatId) }
        catch (e) { console.error('Failed to sync enabled group:', e) }
      }
    }
    return { success: true }
  } catch (error) { console.error('Failed to toggle chat:', error); throw error }
})

ipcMain.handle('set-group-enabled', async (_, payload: { slug: string; groupId: number; enabled: boolean }) => {
  const { slug, groupId, enabled } = payload || ({} as any)
  try {
    chatOps.updateEnabled(slug, groupId, enabled)
    if (enabled) {
      const chat = chatOps.getById(slug, groupId) as any
      if (chat && chat.chat_type === 'group') {
        try { await getSyncOrchestrator(slug).syncEnabledGroup(groupId) }
        catch (e) { console.error('Failed to sync enabled group:', e) }
      }
    }
    return { success: true }
  } catch (error) { console.error('Failed to set group enabled:', error); throw error }
})

ipcMain.handle('get-messages', async (_, payload: { slug: string; chatId: number; limit?: number; offset?: number }) => {
  const { slug, chatId, limit = 100, offset = 0 } = payload || ({} as any)
  try { return { messages: messageOps.getByChatId(slug, chatId, limit, offset) } }
  catch (error) { console.error('Failed to get messages:', error); throw error }
})

ipcMain.handle('get-message-count', async (_, payload: { slug: string; chatId: number }) => {
  const { slug, chatId } = payload || ({} as any)
  try { return messageOps.getCountByChatId(slug, chatId) }
  catch (error) { console.error('Failed to get message count:', error); throw error }
})

ipcMain.handle('get-total-message-count', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  try { return messageOps.getCount(slug) }
  catch (error) { console.error('Failed to get total message count:', error); return 0 }
})

ipcMain.handle('get-contacts', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  try { return contactOps.getAll(slug) }
  catch (error) { console.error('Failed to get contacts:', error); throw error }
})

ipcMain.handle('send-message', async (_, payload: { slug: string; jid: string; text: string }) => {
  const { slug, jid, text } = payload || ({} as any)
  const mgr = getManager(slug)
  if (!mgr?.socket) throw new Error(`WhatsApp not connected for "${slug}"`)
  try { await mgr.socket.sendMessage(jid, { text }); return { success: true } }
  catch (error) { console.error('Failed to send message:', error); throw error }
})

// ---------------------------------------------------------------------------
// IPC: per-account logs / sync / metadata
// ---------------------------------------------------------------------------

ipcMain.handle('get-logs', async (_, payload: { slug: string; levels?: string[]; categories?: string[]; searchText?: string; limit?: number }) => {
  const { slug, levels, categories, searchText, limit = 1000 } = payload || ({} as any)
  try {
    const db = getDatabase(slug)
    let query = 'SELECT * FROM logs'
    const conditions: string[] = []
    const params: any[] = []
    if (levels && levels.length > 0 && levels.length < 4) {
      conditions.push(`level IN (${levels.map(() => '?').join(', ')})`)
      params.push(...levels)
    }
    if (categories && categories.length > 0) {
      conditions.push(`category IN (${categories.map(() => '?').join(', ')})`)
      params.push(...categories)
    }
    if (searchText) { conditions.push('message LIKE ?'); params.push(`%${searchText}%`) }
    if (conditions.length > 0) { query += ' WHERE ' + conditions.join(' AND ') }
    query += ' ORDER BY timestamp DESC LIMIT ?'
    params.push(limit)
    return db.prepare(query).all(...params)
  } catch (error) { console.error('Failed to get logs:', error); throw error }
})

ipcMain.handle('clear-logs', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  try { logOps.clear(slug); return { success: true } }
  catch (error) { console.error('Failed to clear logs:', error); throw error }
})

ipcMain.handle('export-logs', async (_, payload: { slug: string; format?: 'json' | 'text' }) => {
  const { slug, format = 'json' } = payload || ({} as any)
  const rows = logOps.getAll(slug, Number.MAX_SAFE_INTEGER) as Array<{
    timestamp: string
    level: string
    category: string
    message: string
    details_json: string | null
  }>

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const ext = format === 'text' ? 'txt' : 'json'
  const defaultFileName = `logs-${slug}-${stamp}.${ext}`

  const filters = format === 'text'
    ? [{ name: 'Text', extensions: ['txt'] }]
    : [{ name: 'JSON', extensions: ['json'] }]

  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, { defaultPath: defaultFileName, filters })
    : await dialog.showSaveDialog({ defaultPath: defaultFileName, filters })

  if (result.canceled || !result.filePath) return false

  let content: string
  if (format === 'text') {
    const parts = rows.map((row) => {
      const iso = new Date(row.timestamp + 'Z').toISOString()
      const head = `[${iso}] [${row.level}] [${row.category}] ${row.message}`
      return row.details_json ? `${head}\n${row.details_json}` : head
    })
    content = parts.join('\n\n') + (parts.length > 0 ? '\n' : '')
  } else {
    content = JSON.stringify(rows, null, 2)
  }

  fs.writeFileSync(result.filePath, content, 'utf8')
  return true
})

ipcMain.handle('get-sync-status', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  try { return getSyncOrchestrator(slug).getStatus() }
  catch { return { isSyncing: false, totalChats: 0, completedChats: 0, currentChat: null, messageCount: 0, lastError: null } }
})

ipcMain.handle('get-group-metadata-status', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  try { return getGroupMetadataFetcher(slug).getStatus() }
  catch { return { isRunning: false, totalGroups: 0, fetchedCount: 0, currentGroup: null, lastError: null, nextRetryTime: null } }
})

ipcMain.handle('get-activity-status', async (_, payload: { slug: string }) => {
  const { slug } = payload || ({} as any)
  try {
    const total = messageOps.getCount(slug)
    return { lastActivityTime: Date.now(), totalMessagesStored: total || 0 }
  } catch { return { lastActivityTime: Date.now(), totalMessagesStored: 0 } }
})

// ---------------------------------------------------------------------------
// IPC: MCP server (global — port is shared across accounts)
// ---------------------------------------------------------------------------

ipcMain.handle('mcp-get-status', async () => ({
  status: mcpStatus,
  port: getGlobalMcpPort(),
  running: isMcpServerRunning(),
  error: mcpError
}))

ipcMain.handle('mcp-get-port', async () => getGlobalMcpPort())

ipcMain.handle('mcp-set-port', async (_, port: number) => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535')
  }
  setGlobalMcpPort(port)
  return { success: true }
})

ipcMain.handle('mcp-restart', async () => {
  await stopMcpServerSafe()
  await startMcpServerSafe()
  return { status: mcpStatus, error: mcpError }
})

ipcMain.handle('mcp-get-auto-start', async () => getGlobalMcpAutoStart())

ipcMain.handle('mcp-set-auto-start', async (_, enabled: boolean) => {
  setGlobalMcpAutoStart(enabled)
  return { success: true }
})
