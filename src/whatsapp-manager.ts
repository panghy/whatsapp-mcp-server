import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import path from 'path'
import { app } from 'electron'
import fs from 'fs'
import crypto from 'crypto'

// Ensure crypto.subtle is available for Baileys
if (!globalThis.crypto) {
  (globalThis as any).crypto = crypto
}
if (!globalThis.crypto.subtle) {
  (globalThis.crypto as any).subtle = crypto.subtle
}

// Dynamic imports for ESM modules
let makeWASocket: any
let useMultiFileAuthState: any
let DisconnectReason: any
let Browsers: any
let fetchLatestWaWebVersion: any

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WhatsAppManager {
  socket: any
  state: ConnectionState
  qrCode: string | null
  error: string | null
  authState?: any
  saveCreds?: any
  reconnectDelay?: number
  onSocketCreated?: (socket: any) => void
}

const AUTH_DIR = path.join(app.getPath('userData'), 'whatsapp-auth')

// Ensure auth directory exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
}

// Load ESM modules dynamically
async function loadBaileysModules() {
  if (!makeWASocket) {
    const baileys = await import('@whiskeysockets/baileys')
    makeWASocket = baileys.makeWASocket
    useMultiFileAuthState = baileys.useMultiFileAuthState
    DisconnectReason = baileys.DisconnectReason
    Browsers = baileys.Browsers
    fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion
  }
}

/**
 * Create a new socket connection with event listeners
 */
async function connectSocket(manager: WhatsAppManager): Promise<void> {
  if (!manager.authState || !manager.saveCreds) {
    throw new Error('Auth state not initialized')
  }

  try {
    // Import group metadata fetcher for cachedGroupMetadata
    const { getGroupMetadataFetcher } = require('./group-metadata-fetcher')
    let groupMetadataFetcher: any = null
    try {
      groupMetadataFetcher = getGroupMetadataFetcher()
    } catch (e) {
      // Fetcher may not be initialized yet
    }

    // Fetch the latest WA Web version to avoid 405 errors
    let version: [number, number, number]
    try {
      const result = await fetchLatestWaWebVersion({})
      version = result.version
    } catch (e) {
      version = [2, 3000, 1034074495]
    }

    const socket = makeWASocket({
      auth: manager.authState,
      printQRInTerminal: false,
      version,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
      cachedGroupMetadata: async (jid: string) => {
        if (groupMetadataFetcher) {
          return groupMetadataFetcher.getCachedMetadata(jid)
        }
        return undefined
      },
      getMessage: async (key: any) => {
        try {
          const { messageOps } = require('./database')
          if (key.id) {
            const msg = messageOps.getByWhatsappMessageId(key.id) as any
            if (msg && msg.content_json) {
              return JSON.parse(msg.content_json)
            }
          }
        } catch (e) {
          // Ignore lookup errors
        }
        return undefined
      }
    })

    // Clean up old socket if it exists
    if (manager.socket) {
      try {
        await manager.socket.end(new Error('Reconnecting'))
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    manager.socket = socket
    manager.state = 'connecting'

    // Notify listeners about the new socket
    if (manager.onSocketCreated) {
      console.log('[RECONNECT] New socket created, invoking onSocketCreated callback...')
      manager.onSocketCreated(socket)
    }

    // Handle QR code
    socket.ev.on('connection.update', (update: any) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        QRCode.toDataURL(qr).then(dataUrl => {
          manager.qrCode = dataUrl
          manager.state = 'connecting'
        }).catch(error => {
          console.error('Failed to generate QR code:', error)
          manager.error = 'Failed to generate QR code'
        })
      }

      if (connection === 'open') {
        manager.state = 'connected'
        manager.qrCode = null
        manager.error = null
        manager.reconnectDelay = 2000
      } else if (connection === 'close') {
        handleConnectionClose(manager, lastDisconnect)
      }
    })

    // Save credentials
    socket.ev.on('creds.update', manager.saveCreds)
  } catch (error) {
    manager.state = 'error'
    manager.error = error instanceof Error ? error.message : 'Unknown error'
    throw error
  }
}

function handleConnectionClose(manager: WhatsAppManager, lastDisconnect: any): void {
  const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
  if (shouldReconnect) {
    manager.state = 'connecting'
    const delay = manager.reconnectDelay || 2000
    console.log(`Reconnecting to WhatsApp in ${delay}ms...`)
    setTimeout(() => {
      connectSocket(manager).catch(error => {
        console.error('Reconnection failed:', error)
        manager.error = error instanceof Error ? error.message : 'Reconnection failed'
        manager.reconnectDelay = Math.min((manager.reconnectDelay || 2000) * 2, 60000)
      })
    }, delay)
  } else {
    // Device removed or logged out - clear stale credentials
    console.log('Device removed, clearing session and showing new QR code...')
    try {
      const { settingOps, getDatabase } = require('./database')
      settingOps.delete('initial_sync_complete')
      settingOps.delete('user_display_name')
      settingOps.delete('user_phone')
      const db = getDatabase()
      db.exec('DELETE FROM messages')
      db.exec('DELETE FROM chats')
      db.exec('DELETE FROM contacts')
      db.exec('DELETE FROM logs')
      db.exec('UPDATE chats SET last_pushed_message_id = NULL')
    } catch (error) {
      console.error('Failed to clear sync state after device removal:', error)
    }

    clearWhatsAppSession().then(async () => {
      try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
        manager.authState = state
        manager.saveCreds = saveCreds
        await connectSocket(manager)
      } catch (error) {
        console.error('Failed to reinitialize auth after device removal:', error)
        manager.state = 'error'
        manager.error = error instanceof Error ? error.message : 'Failed to reinitialize auth'
        manager.reconnectDelay = 2000
      }
    }).catch(error => {
      console.error('Failed to clear WhatsApp session:', error)
      manager.state = 'error'
      manager.error = 'Failed to clear session'
      manager.reconnectDelay = 2000
    })
  }
}

export async function initializeWhatsApp(): Promise<WhatsAppManager> {
  const manager: WhatsAppManager = {
    socket: null,
    state: 'disconnected',
    qrCode: null,
    error: null,
    reconnectDelay: 2000
  }

  try {
    await loadBaileysModules()
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    manager.authState = state
    manager.saveCreds = saveCreds
    await connectSocket(manager)
    return manager
  } catch (error) {
    manager.state = 'error'
    manager.error = error instanceof Error ? error.message : 'Unknown error'
    return manager
  }
}

export async function disconnectWhatsApp(manager: WhatsAppManager): Promise<void> {
  if (manager.socket) {
    try {
      await manager.socket.end(new Error('User disconnected'))
    } catch (error) {
      console.error('Error disconnecting socket:', error)
    }
    manager.socket = null
    manager.state = 'disconnected'
    manager.qrCode = null
  }
}

export async function clearWhatsAppSession(): Promise<void> {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    }
  } catch (error) {
    console.error('Failed to clear WhatsApp session:', error)
  }
}

