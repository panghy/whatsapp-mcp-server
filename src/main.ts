import { app, BrowserWindow, Menu, Tray, ipcMain, dialog } from 'electron'
import path from 'path'
import Settings from 'electron-settings'
import fs from 'fs'
import { initializeWhatsApp, disconnectWhatsApp, clearWhatsAppSession, WhatsAppManager } from './whatsapp-manager'
import { initializeDatabase, chatOps, contactOps, messageOps, logOps, settingOps, getDatabase } from './database'
import { initializeSyncOrchestrator, getSyncOrchestrator } from './sync-orchestrator'
import { MessageTransformer, extractPhoneFromJid, normalizePhoneNumber } from './message-transformer'
import { initializeGroupMetadataFetcher, getGroupMetadataFetcher } from './group-metadata-fetcher'

// Filter out newsletter and status broadcast JIDs
const _loggedFilteredJids = new Set<string>()
function isNewsletterOrBroadcast(jid: string): boolean {
  return jid.endsWith('@newsletter') || jid === 'status@broadcast'
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let whatsappManager: WhatsAppManager | null = null
let whatsappConnected = false
let lastActivityTime: number | null = null

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason)
})

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

  mainWindow.on('close', async (event) => {
    const minimizeToTray = await Settings.get('minimizeToTray')
    if (minimizeToTray && mainWindow) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
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
    tray = new Tray(iconPath)
    tray.on('click', () => {
      if (mainWindow) { mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus()) }
      else { createWindow() }
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
      }
    })

    // Event processing - simplified version without queue-processor
    console.log('Registering event handlers via ev.process()...')
    socket.ev.process(async (events) => {
      const eventNames = Object.keys(events)
      if (eventNames.length > 0) { console.log(`[EVENTS] ${eventNames.join(', ')}`) }

      if (events['messaging-history.set']) {
        const { chats, contacts, messages, isLatest, syncType, progress } = events['messaging-history.set']
        console.log(`History sync batch: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages`)
        lastActivityTime = Date.now()

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
              const enabled = chatType === 'dm' ? 1 : 0
              if (!chatName && chatType === 'dm') {
                const contact = contactOps.getByJid(jid) as any
                if (contact?.name) { chatName = contact.name }
              }
              const result = chatOps.insert(jid, chatType, undefined, chatName)
              const chatId = (result as any).lastInsertRowid
              dbChat = { id: chatId, whatsapp_jid: jid, chat_type: chatType, enabled, name: chatName }
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
              const enabled = chatType === 'dm' ? 1 : 0
              const result = chatOps.insert(jid, chatType, undefined, undefined)
              const chatId = (result as any).lastInsertRowid
              chat = { id: chatId, whatsapp_jid: jid, chat_type: chatType, enabled }
            }
            if (!chat.enabled) continue
            try { await messageTransformer.processMessage(msg, chat.id) } catch (error) { console.error(`Failed to process history message: ${error}`) }
          }
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

// Contact IPC handlers
ipcMain.handle('get-contacts', async () => {
  try { return contactOps.getAll() } catch (error) { console.error('Failed to get contacts:', error); throw error }
})

// Logs IPC handlers
ipcMain.handle('get-logs', async (_, limit = 100) => {
  try { return logOps.getRecent(limit) } catch (error) { console.error('Failed to get logs:', error); throw error }
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

