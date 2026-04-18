import { Boom } from '@hapi/boom'
import QRCode from 'qrcode'
import fs from 'fs'
import crypto from 'crypto'
import { accountAuthDir, setMcpEnabled, getAccount } from './accounts'
import { logOps } from './database'

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
  slug: string
  socket: any
  state: ConnectionState
  qrCode: string | null
  error: string | null
  authState?: any
  saveCreds?: any
  reconnectDelay?: number
  onSocketCreated?: (socket: any) => void
}

// Per-slug registry.
const managers = new Map<string, WhatsAppManager>()

export function getManager(slug: string): WhatsAppManager | undefined {
  return managers.get(slug)
}

export function setManager(slug: string, manager: WhatsAppManager): void {
  managers.set(slug, manager)
}

export function listManagers(): Map<string, WhatsAppManager> {
  return managers
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
      groupMetadataFetcher = getGroupMetadataFetcher(manager.slug)
    } catch {
      // Fetcher may not be initialized yet
    }

    // Fetch the latest WA Web version to avoid 405 errors
    let version: [number, number, number]
    try {
      const result = await fetchLatestWaWebVersion({})
      version = result.version
    } catch {
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
            const msg = messageOps.getByWhatsappMessageId(manager.slug, key.id) as any
            if (msg && msg.content_json) {
              return JSON.parse(msg.content_json)
            }
          }
        } catch {
          // Ignore lookup errors
        }
        return undefined
      }
    })

    // Clean up old socket if it exists
    if (manager.socket) {
      try {
        await manager.socket.end(new Error('Reconnecting'))
      } catch {
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
        // Re-enable MCP endpoint for this account if it was previously disabled
        // after a device-removed event.
        try {
          const account = getAccount(manager.slug)
          if (account && !account.mcpEnabled) {
            setMcpEnabled(manager.slug, true)
            try {
              logOps.insert(manager.slug, 'info', 'connection',
                `Re-enabled MCP endpoint for "${manager.slug}" after successful re-link`)
            } catch { /* db may not be ready */ }
          }
        } catch (err) {
          console.error(`[whatsapp-manager:${manager.slug}] Failed to re-enable MCP:`, err)
        }
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

export function handleConnectionClose(manager: WhatsAppManager, lastDisconnect: any): void {
  const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
  if (shouldReconnect) {
    manager.state = 'connecting'
    const delay = manager.reconnectDelay || 2000
    console.log(`[whatsapp-manager:${manager.slug}] Reconnecting in ${delay}ms...`)
    setTimeout(() => {
      connectSocket(manager).catch(error => {
        console.error(`[whatsapp-manager:${manager.slug}] Reconnection failed:`, error)
        manager.error = error instanceof Error ? error.message : 'Reconnection failed'
        manager.reconnectDelay = Math.min((manager.reconnectDelay || 2000) * 2, 60000)
      })
    }, delay)
  } else {
    // Device removed / logged out: preserve the account's data. Disable the
    // MCP endpoint for this slug until the user explicitly re-links.
    console.log(`[whatsapp-manager:${manager.slug}] Device removed — disabling MCP endpoint; auth/DB preserved`)
    try {
      setMcpEnabled(manager.slug, false)
    } catch (err) {
      console.error(`[whatsapp-manager:${manager.slug}] Failed to set mcpEnabled=false:`, err)
    }
    try {
      logOps.insert(manager.slug, 'warn', 'connection',
        `Device removed for account "${manager.slug}" — MCP endpoint disabled. Re-link via QR to re-enable.`)
    } catch { /* db may not be ready */ }

    manager.state = 'disconnected'
    manager.qrCode = null
    manager.error = 'Device removed. Re-link WhatsApp to re-enable MCP.'
    manager.reconnectDelay = 2000
  }
}

export async function initializeWhatsApp(slug: string): Promise<WhatsAppManager> {
  const manager: WhatsAppManager = {
    slug,
    socket: null,
    state: 'disconnected',
    qrCode: null,
    error: null,
    reconnectDelay: 2000
  }

  try {
    await loadBaileysModules()
    const authDir = accountAuthDir(slug)
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true })
    }
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    manager.authState = state
    manager.saveCreds = saveCreds
    await connectSocket(manager)
    managers.set(slug, manager)
    return manager
  } catch (error) {
    manager.state = 'error'
    manager.error = error instanceof Error ? error.message : 'Unknown error'
    managers.set(slug, manager)
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

export async function clearWhatsAppSession(slug: string): Promise<void> {
  try {
    const authDir = accountAuthDir(slug)
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true })
    }
  } catch (error) {
    console.error(`[whatsapp-manager:${slug}] Failed to clear session:`, error)
  }
}

