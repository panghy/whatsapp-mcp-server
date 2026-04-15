import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from 'electron'
import path from 'path'
import Settings from 'electron-settings'
import fs from 'fs'
import { autoUpdater } from 'electron-updater'
import { initializeWhatsApp, disconnectWhatsApp, clearWhatsAppSession, WhatsAppManager } from './whatsapp-manager'
import { initializeDatabase, chatOps, contactOps, messageOps, logOps, settingOps, getDatabase } from './database'
import { initializeSyncOrchestrator, getSyncOrchestrator } from './sync-orchestrator'
import { MessageTransformer, extractPhoneFromJid, normalizePhoneNumber } from './message-transformer'
import { initializeGroupMetadataFetcher, getGroupMetadataFetcher } from './group-metadata-fetcher'
import { startMcpServer, stopMcpServer, isMcpServerRunning, setWhatsAppManager } from './mcp-server'

// Auto-updater configuration
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

autoUpdater.on('checking-for-update', () => {
  console.log('[AutoUpdater] Checking for updates...')
})

autoUpdater.on('update-available', (info) => {
  console.log('[AutoUpdater] Update available:', info.version)
})

autoUpdater.on('update-not-available', (info) => {
  console.log('[AutoUpdater] No update available:', info.version)
})

autoUpdater.on('update-downloaded', (info) => {
  console.log('[AutoUpdater] Update downloaded:', info.version)
})

autoUpdater.on('error', (err) => {
  console.log('[AutoUpdater] Error:', err.message)
})

// MCP server status tracking
type McpStatus = 'stopped' | 'starting' | 'running' | 'port_conflict' | 'error'
let mcpStatus: McpStatus = 'stopped'
let mcpError: string | null = null

// Default MCP port
const DEFAULT_MCP_PORT = 13491

// Filter out newsletter and status broadcast JIDs
function isNewsletterOrBroadcast(jid: string): boolean {
  return jid.endsWith('@newsletter') || jid === 'status@broadcast'
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let whatsappManager: WhatsAppManager | null = null
let whatsappConnected = false

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[UNHANDLED REJECTION]', reason)
})

/**
 * Get the MCP port from database settings
 */
function getMcpPort(): number {
  const portStr = settingOps.get('mcp_port')
  return portStr ? parseInt(portStr, 10) : DEFAULT_MCP_PORT
}

/**
 * Set the MCP port in database settings
 */
function setMcpPortSetting(port: number): void {
  settingOps.set('mcp_port', String(port))
}

/**
 * Start the MCP server with port conflict handling
 */
async function startMcpServerSafe(): Promise<void> {
  if (isMcpServerRunning()) {
    console.log('[MCP] Server already running')
    return
  }

  const port = getMcpPort()
  mcpStatus = 'starting'
  mcpError = null

  try {
    await startMcpServer(port)
    mcpStatus = 'running'
    console.log(`[MCP] Server started on port ${port}`)
    logOps.insert('info', 'mcp', `MCP server started on port ${port}`)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    if (errMsg.includes('already in use') || errMsg.includes('EADDRINUSE')) {
      mcpStatus = 'port_conflict'
      mcpError = `Port ${port} is already in use`
      console.error(`[MCP] Port conflict: ${mcpError}`)
      logOps.insert('error', 'mcp', mcpError)
    } else {
      mcpStatus = 'error'
      mcpError = errMsg
      console.error(`[MCP] Failed to start: ${errMsg}`)
      logOps.insert('error', 'mcp', `Failed to start MCP server: ${errMsg}`)
    }
  }
}

/**
 * Stop the MCP server safely
 */
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
    logOps.insert('info', 'mcp', 'MCP server stopped')
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
    mainWindow.loadFile(path.join(__dirname, '../index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.on('minimize', () => { mainWindow?.hide() })

  mainWindow.on('close', (event) => {
    if (mainWindow) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('show', () => { updateTrayMenu() })
  mainWindow.on('hide', () => { updateTrayMenu() })
}

const updateTrayMenu = () => {
  if (!tray) return
  const connectionStatus = whatsappConnected ? 'Connected' : 'Disconnected'
  const contextMenu = Menu.buildFromTemplate([
    { label: mainWindow?.isVisible() ? 'Hide Window' : 'Show Window', click: () => {
      if (mainWindow) { mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus()) }
      else { createWindow() }
    }},
    { label: `Connection Status: ${connectionStatus}`, enabled: false },
    { type: 'separator' },
    { label: 'Settings...', click: () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('open-settings') }
      else { createWindow() }
    }},
    { label: 'Logs...', click: () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('open-logs') }
      else { createWindow() }
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit() }}
  ])
  tray.setContextMenu(contextMenu)
}

const createTray = () => {
  try {
    const iconPath = path.join(__dirname, './icon.png')
    const icon = nativeImage.createFromPath(iconPath)
    const trayIcon = icon.resize({ width: 18, height: 18 })
    trayIcon.setTemplateImage(true)
    tray = new Tray(trayIcon)
    tray.setToolTip('WhatsApp MCP Server')
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      } else {
        createWindow()
      }
    })
    updateTrayMenu()
  } catch (e) {
    console.log('Tray icon not found, continuing without tray')
  }
}

ipcMain.handle('get-auto-launch', async () => {
  return await Settings.get('autoLaunch') || false
})

ipcMain.handle('get-user-display-name', async () => {
  try { return settingOps.get('user_display_name') || '' }
  catch (error) { console.error('Failed to get user display name:', error); return '' }
})

ipcMain.handle('set-user-display-name', async (_, name: string) => {
  try { settingOps.set('user_display_name', name); return true }
  catch (error) { console.error('Failed to set user display name:', error); throw error }
})

ipcMain.handle('set-auto-launch', async (_, enabled: boolean) => {
  await Settings.set('autoLaunch', enabled)
  app.setLoginItemSettings({ openAtLogin: enabled })
  return true
})

// Initialize database on app ready
app.whenReady().then(async () => {
  initializeDatabase()
  createTray()
  createWindow()

  // Check for updates after window is shown
  autoUpdater.checkForUpdatesAndNotify()

  // Auto-connect if we have saved auth
  const authDir = path.join(app.getPath('userData'), 'whatsapp-auth')
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    try {
      whatsappManager = await initializeWhatsApp()
      if (whatsappManager.socket) {
        await setupWhatsAppConnection(whatsappManager)
      }
    } catch (error) {
      console.error('Auto-connect failed:', error)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) { createWindow() }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { app.quit() }
})

/**
 * Shared function to set up WhatsApp connection with sync orchestrator and message handlers
 */
async function setupWhatsAppConnection(manager: WhatsAppManager): Promise<void> {
  if (!manager.socket) { throw new Error('WhatsApp socket not initialized') }

  function registerHandlers(socket: any) {
    console.log('[SETUP] Registering event handlers on socket...')
    const syncOrchestrator = initializeSyncOrchestrator(socket)
    const messageTransformer = new MessageTransformer(socket)
    syncOrchestrator.setMessageTransformer(messageTransformer)

    const groupMetadataFetcher = initializeGroupMetadataFetcher()
    groupMetadataFetcher.setSocket(socket)

    let contactSyncComplete = false
    let pendingGroupsBuffer: Array<{ chatId: number; jid: string }> = []

    const flushPendingGroups = () => {
      if (pendingGroupsBuffer.length > 0) {
        console.log(`[GroupMetadata] Flushing ${pendingGroupsBuffer.length} buffered groups`)
        groupMetadataFetcher.queueGroups(pendingGroupsBuffer)
        groupMetadataFetcher.start()
        pendingGroupsBuffer = []
      }
    }

    socket.ev.on('connection.update', async (update: any) => {
      if (update.connection === 'open') {
        console.log('Connection open...')
        whatsappConnected = true
        updateTrayMenu()

        // Set WhatsApp manager for MCP server and start it
        if (whatsappManager) {
          setWhatsAppManager(whatsappManager)
          await startMcpServerSafe()
        }

        const userJid = socket.user?.id
        if (userJid) {
          const userPhone = extractPhoneFromJid(userJid)
          if (userPhone) { settingOps.set('user_phone', userPhone); console.log('[Connection] Stored user phone:', userPhone) }
        }

        const initialSyncDone = settingOps.get('initial_sync_complete')
        if (initialSyncDone === 'true') {
          console.log('Initial history sync already completed, skipping sync state')
          logOps.insert('info', 'connection', 'WhatsApp reconnected, history already synced')
          try {
            const groupsNeedingMetadata = chatOps.getGroupsNeedingMetadata() as any[]
            if (groupsNeedingMetadata.length > 0) {
              console.log(`[GroupMetadata] Found ${groupsNeedingMetadata.length} groups needing metadata on reconnect`)
              const groupsToQueue = groupsNeedingMetadata.map(g => ({ chatId: g.id, jid: g.whatsapp_jid }))
              groupMetadataFetcher.queueGroups(groupsToQueue)
              groupMetadataFetcher.start()
            }
          } catch (error) { console.error('Failed to check for groups needing metadata:', error) }

          try {
            const crossResolvedLid = contactOps.crossResolveLidNames()
            const crossResolvedDm = contactOps.crossResolveDmNames()
            const chatBackfill = chatOps.backfillDmNames()
            if (crossResolvedLid.changes > 0 || crossResolvedDm.changes > 0 || chatBackfill.changes > 0) {
              console.log(`[Reconnect] Resolve pass: ${crossResolvedLid.changes} LID names, ${crossResolvedDm.changes} DM names, ${chatBackfill.changes} chat names`)
            }
          } catch (error) { console.error('[Reconnect] Cross-resolve/backfill failed:', error) }
        } else {
          syncOrchestrator.markSyncInProgress()
          logOps.insert('info', 'connection', 'WhatsApp connected, waiting for history sync...')
        }
      } else if (update.connection === 'close') {
        whatsappConnected = false
        updateTrayMenu()
        // Don't stop MCP server - it handles disconnected state gracefully
        // and will reconnect when WhatsApp reconnects
      }
    })

    // Event processing - simplified version without queue-processor
    console.log('Registering event handlers via ev.process()...')
    socket.ev.process(async (events: Record<string, any>) => {
      const eventNames = Object.keys(events)
      if (eventNames.length > 0) { console.log(`[EVENTS] ${eventNames.join(', ')}`) }

      if (events['messaging-history.set']) {
        const { chats, contacts, messages, isLatest, syncType, progress } = events['messaging-history.set']
        console.log(`History sync batch: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages`)

        // Process contacts
        if (contacts && contacts.length > 0) {
          for (const contact of contacts) {
            const jid = contact.id
            const name = contact.name || contact.notify || undefined
            const phone = contact.phoneNumber ? normalizePhoneNumber(contact.phoneNumber) ?? undefined : (jid ? extractPhoneFromJid(jid) ?? undefined : undefined)
            const lid = contact.lid || undefined
            if (jid && (name || phone || lid)) { contactOps.insert(jid, name, phone, lid) }
          }
        }

        // Process chats
        if (chats && chats.length > 0) {
          const newGroupsToFetch: Array<{ chatId: number; jid: string }> = []
          for (const chat of chats) {
            const jid = chat.id
            if (!jid || isNewsletterOrBroadcast(jid)) continue
            let chatName = chat.name || chat.subject || undefined
            let dbChat = chatOps.getByWhatsappJid(jid) as any
            if (!dbChat) {
              const chatType = jid.includes('@g.us') ? 'group' : 'dm'
              if (!chatName && chatType === 'dm') {
                const contact = contactOps.getByJid(jid) as any
                if (contact?.name) { chatName = contact.name }
              }
              const result = chatOps.insert(jid, chatType, undefined, chatName)
              const chatId = (result as any).lastInsertRowid
              dbChat = { id: chatId, whatsapp_jid: jid, chat_type: chatType, name: chatName }
              if (chatType === 'group') { newGroupsToFetch.push({ chatId, jid }) }
            } else if (!dbChat.name && chatName) { chatOps.updateName(dbChat.id, chatName) }
          }
          if (newGroupsToFetch.length > 0) {
            if (contactSyncComplete) { groupMetadataFetcher.queueGroups(newGroupsToFetch); groupMetadataFetcher.start() }
            else { pendingGroupsBuffer.push(...newGroupsToFetch) }
          }
        }

        // Process messages
        if (messages && messages.length > 0) {
          for (const msg of messages) {
            const jid = msg.key?.remoteJid
            if (!jid || isNewsletterOrBroadcast(jid)) continue
            let chat = chatOps.getByWhatsappJid(jid) as any
            if (!chat) {
              const chatType = jid.includes('@g.us') ? 'group' : 'dm'
              const result = chatOps.insert(jid, chatType, undefined, undefined)
              const chatId = (result as any).lastInsertRowid
              chat = { id: chatId, whatsapp_jid: jid, chat_type: chatType }
            }
            try { await messageTransformer.processMessage(msg, chat.id) } catch (error) { console.error(`Failed to process history message: ${error}`) }
          }
          const totalMessageCount = messageOps.getCount()
          console.log(`[HistorySync] After batch: ${messages.length} messages processed, total in DB: ${totalMessageCount}`)
        }

        if (!contactSyncComplete && syncType === 2 && progress != null && progress >= 100) {
          console.log(`[ContactSync] Contact sync complete (progress: ${progress}%)`)
          contactSyncComplete = true
          contactOps.crossResolveLidNames(); contactOps.crossResolveDmNames(); chatOps.backfillDmNames()
          flushPendingGroups()
        }

        if (isLatest) {
          console.log('History sync complete!')
          logOps.insert('info', 'sync', 'History sync complete')
          syncOrchestrator.markSyncComplete()
          settingOps.set('initial_sync_complete', 'true')
          if (!contactSyncComplete && syncType !== 5) {
            contactSyncComplete = true
            contactOps.crossResolveLidNames(); contactOps.crossResolveDmNames(); chatOps.backfillDmNames()
            flushPendingGroups()
          }
        }
      }
    })
  }

  registerHandlers(manager.socket)
  manager.onSocketCreated = (socket) => { console.log('[RECONNECT] Re-registering event handlers...'); registerHandlers(socket) }
}

// WhatsApp connection IPC handlers
ipcMain.handle('whatsapp-connect', async () => {
  try {
    whatsappManager = await initializeWhatsApp()
    if (whatsappManager.socket) { await setupWhatsAppConnection(whatsappManager) }
    return { state: whatsappManager.state, qrCode: whatsappManager.qrCode, error: whatsappManager.error }
  } catch (error) {
    console.error('Failed to connect WhatsApp:', error)
    throw error
  }
})

ipcMain.handle('whatsapp-disconnect', async () => {
  if (whatsappManager) {
    await disconnectWhatsApp(whatsappManager)
    whatsappManager = null
  }
  whatsappConnected = false
  updateTrayMenu()
  return { success: true }
})

ipcMain.handle('whatsapp-logout', async () => {
  if (whatsappManager) {
    await disconnectWhatsApp(whatsappManager)
    await clearWhatsAppSession()
    whatsappManager = null
  }
  try {
    settingOps.delete('initial_sync_complete')
    settingOps.delete('user_display_name')
    settingOps.delete('user_phone')
    const db = getDatabase()
    db.exec('DELETE FROM messages'); db.exec('DELETE FROM chats'); db.exec('DELETE FROM contacts'); db.exec('DELETE FROM logs')
  } catch (error) { console.error('Failed to clear database on logout:', error) }
  whatsappConnected = false
  updateTrayMenu()
  return { success: true }
})

ipcMain.handle('whatsapp-status', async () => {
  const authDir = path.join(app.getPath('userData'), 'whatsapp-auth')
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0
  if (!whatsappManager) { return { state: 'disconnected', qrCode: null, error: null, hasAuth } }
  return { state: whatsappManager.state, qrCode: whatsappManager.qrCode, error: whatsappManager.error, hasAuth }
})

// Chat management IPC handlers
ipcMain.handle('get-chats', async () => {
  try { return chatOps.getAll() } catch (error) { console.error('Failed to get chats:', error); throw error }
})

ipcMain.handle('get-chat', async (_, chatId: number) => {
  try { return chatOps.getById(chatId) } catch (error) { console.error('Failed to get chat:', error); throw error }
})

ipcMain.handle('toggle-chat', async (_, chatId: number, enabled: boolean) => {
  try {
    chatOps.updateEnabled(chatId, enabled)
    if (enabled) {
      const chat = chatOps.getById(chatId) as any
      if (chat && chat.chat_type === 'group') {
        try { await getSyncOrchestrator().syncEnabledGroup(chatId) } catch (e) { console.error('Failed to sync enabled group:', e) }
      }
    }
    return { success: true }
  } catch (error) { console.error('Failed to toggle chat:', error); throw error }
})

// Message IPC handlers
ipcMain.handle('get-messages', async (_, chatId: number, limit = 100, offset = 0) => {
  try { return { messages: messageOps.getByChatId(chatId, limit, offset) } } catch (error) { console.error('Failed to get messages:', error); throw error }
})

ipcMain.handle('get-message-count', async (_, chatId: number) => {
  try { return messageOps.getCountByChatId(chatId) } catch (error) { console.error('Failed to get message count:', error); throw error }
})

ipcMain.handle('get-total-message-count', async () => {
  try { return messageOps.getCount() } catch (error) { console.error('Failed to get total message count:', error); return 0 }
})

// Contact IPC handlers
ipcMain.handle('get-contacts', async () => {
  try { return contactOps.getAll() } catch (error) { console.error('Failed to get contacts:', error); throw error }
})

// Logs IPC handlers
ipcMain.handle('get-logs', async (_, filters: { levels?: string[], categories?: string[], searchText?: string, limit?: number } = {}) => {
  try {
    const { levels, categories, searchText, limit = 1000 } = filters
    const db = getDatabase()

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

    if (searchText) {
      conditions.push('message LIKE ?')
      params.push(`%${searchText}%`)
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ')
    }

    query += ' ORDER BY timestamp DESC LIMIT ?'
    params.push(limit)

    return db.prepare(query).all(...params)
  } catch (error) {
    console.error('Failed to get logs:', error)
    throw error
  }
})

ipcMain.handle('clear-logs', async () => {
  try { logOps.clear(); return { success: true } } catch (error) { console.error('Failed to clear logs:', error); throw error }
})

// Sync status
ipcMain.handle('get-sync-status', async () => {
  try { return getSyncOrchestrator().getStatus() } catch (error) { return { isSyncing: false, totalChats: 0, completedChats: 0, currentChat: null, messageCount: 0, lastError: null } }
})

// Group metadata status
ipcMain.handle('get-group-metadata-status', async () => {
  try { return getGroupMetadataFetcher().getStatus() } catch (error) { return { isRunning: false, totalGroups: 0, fetchedCount: 0, currentGroup: null, lastError: null, nextRetryTime: null } }
})

// Settings IPC handlers
ipcMain.handle('get-minimize-to-tray', async () => {
  return await Settings.get('minimizeToTray') || false
})

ipcMain.handle('set-minimize-to-tray', async (_, enabled: boolean) => {
  await Settings.set('minimizeToTray', enabled)
  return true
})

// Send message via WhatsApp
ipcMain.handle('send-message', async (_, jid: string, text: string) => {
  if (!whatsappManager?.socket) { throw new Error('WhatsApp not connected') }
  try {
    await whatsappManager.socket.sendMessage(jid, { text })
    return { success: true }
  } catch (error) {
    console.error('Failed to send message:', error)
    throw error
  }
})

// MCP Server IPC handlers
ipcMain.handle('mcp-get-status', async () => {
  return {
    status: mcpStatus,
    port: getMcpPort(),
    running: isMcpServerRunning(),
    error: mcpError
  }
})

ipcMain.handle('mcp-get-port', async () => {
  return getMcpPort()
})

ipcMain.handle('mcp-set-port', async (_, port: number) => {
  if (port < 1 || port > 65535) {
    throw new Error('Port must be between 1 and 65535')
  }
  setMcpPortSetting(port)
  return { success: true }
})

ipcMain.handle('mcp-restart', async () => {
  await stopMcpServerSafe()
  await startMcpServerSafe()
  return { status: mcpStatus, error: mcpError }
})

ipcMain.handle('mcp-get-auto-start', async () => {
  const value = settingOps.get('mcp_auto_start')
  return value !== 'false' // Default to true
})

ipcMain.handle('mcp-set-auto-start', async (_, enabled: boolean) => {
  settingOps.set('mcp_auto_start', enabled ? 'true' : 'false')
  return { success: true }
})

ipcMain.handle('get-app-version', () => app.getVersion())
