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
let fetchLatestBaileysVersion: any

// Hardcoded current fallback for the WA-Web protocol version. Kept in sync with
// a known-good revision so we never silently drop back to an ancient build.
const FALLBACK_WA_VERSION: [number, number, number] = [2, 3000, 1042371453]

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
  presenceTimer?: NodeJS.Timeout | null
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
    fetchLatestBaileysVersion = (baileys as any).fetchLatestBaileysVersion
  }
}

function parseWaVersionString(raw: string): [number, number, number] | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.includes('.')) {
    const parts = trimmed.split('.')
    if (parts.length !== 3) return null
    const nums = parts.map(p => Number(p))
    if (nums.some(n => !Number.isFinite(n) || !Number.isInteger(n) || n < 0)) return null
    return [nums[0], nums[1], nums[2]]
  }
  const rev = Number(trimmed)
  if (!Number.isFinite(rev) || !Number.isInteger(rev) || rev < 0) return null
  return [2, 3000, rev]
}

/**
 * Resolve the WA-Web protocol version with this priority:
 *   1. WA_VERSION env var ("2.3000.<rev>" or bare "<rev>")
 *   2. fetchLatestWaWebVersion() — only when isLatest === true
 *   3. fetchLatestBaileysVersion() — only when isLatest === true
 *   4. Hardcoded fallback (FALLBACK_WA_VERSION)
 * Never throws.
 */
export async function resolveWaVersion(): Promise<{ version: [number, number, number]; source: string }> {
  try {
    const envRaw = process.env.WA_VERSION
    if (envRaw) {
      const parsed = parseWaVersionString(envRaw)
      if (parsed) {
        return { version: parsed, source: 'env' }
      }
    }
  } catch { /* env access shouldn't throw, but be defensive */ }

  try {
    await loadBaileysModules()
  } catch { /* fall through to fallback */ }

  if (fetchLatestWaWebVersion) {
    try {
      const result = await fetchLatestWaWebVersion({})
      if (result && result.isLatest === true && Array.isArray(result.version)) {
        return { version: result.version as [number, number, number], source: 'wa-web' }
      }
    } catch { /* try next source */ }
  }

  if (fetchLatestBaileysVersion) {
    try {
      const result = await fetchLatestBaileysVersion()
      if (result && result.isLatest === true && Array.isArray(result.version)) {
        return { version: result.version as [number, number, number], source: 'baileys' }
      }
    } catch { /* fall through to hardcoded fallback */ }
  }

  return { version: FALLBACK_WA_VERSION, source: 'fallback' }
}

/**
 * Explicitly mark the bridge's presence as 'unavailable' so the phone keeps
 * receiving push notifications. Accepts either a manager or a raw socket.
 * Fire-and-forget: never throws, errors are logged only.
 */
export function markPresenceUnavailable(managerOrSocket: WhatsAppManager | any): void {
  try {
    const socket = typeof managerOrSocket?.sendPresenceUpdate === 'function'
      ? managerOrSocket
      : managerOrSocket?.socket
    if (typeof socket?.sendPresenceUpdate !== 'function') return
    Promise.resolve(socket.sendPresenceUpdate('unavailable')).catch((error: any) => {
      console.error('[whatsapp-manager] Failed to mark presence unavailable:', error)
    })
  } catch (error) {
    console.error('[whatsapp-manager] Failed to mark presence unavailable:', error)
  }
}

// How often to re-assert 'unavailable' while connected. Baileys sessions can
// drift back to 'available' when receiving messages (Baileys #2553), which
// suppresses push notifications on the user's real devices.
export const PRESENCE_REASSERT_INTERVAL_MS = 60_000

/**
 * Start a periodic timer that re-asserts presence 'unavailable' on the given
 * socket. Replaces any existing timer. The timer self-cancels if the socket
 * has been replaced or the manager is no longer connected.
 */
export function startPresenceKeepalive(manager: WhatsAppManager, socket: any): void {
  stopPresenceKeepalive(manager)
  const timer = setInterval(() => {
    if (manager.socket !== socket || manager.state !== 'connected') {
      stopPresenceKeepalive(manager)
      return
    }
    markPresenceUnavailable(socket)
  }, PRESENCE_REASSERT_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  manager.presenceTimer = timer
}

/**
 * Stop the periodic presence keepalive timer, if any.
 */
export function stopPresenceKeepalive(manager: WhatsAppManager): void {
  if (manager.presenceTimer) {
    clearInterval(manager.presenceTimer)
    manager.presenceTimer = null
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

    // Resolve the WA-Web protocol version (env override → live fetch → fallback).
    const { version, source } = await resolveWaVersion()
    console.log(
      `[whatsapp-manager:${manager.slug}] Using WA version ${version[0]}.${version[1]}.${version[2]} (source: ${source})`
    )

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
      stopPresenceKeepalive(manager)
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
        // Keep the phone receiving push notifications: the bridge should never
        // appear as an active/available client. Re-assert periodically because
        // the session can drift back to 'available' (Baileys #2553).
        markPresenceUnavailable(socket)
        startPresenceKeepalive(manager, socket)
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
  stopPresenceKeepalive(manager)
  const bErr = lastDisconnect?.error as Boom | undefined
  const statusCode = bErr?.output?.statusCode
  const errMessage = (bErr as any)?.message ?? (lastDisconnect?.error?.message) ?? 'unknown'
  console.log(
    `[whatsapp-manager:${manager.slug}] connection closed (statusCode=${statusCode ?? 'unknown'}): ${errMessage}`
  )
  const shouldReconnect = statusCode !== DisconnectReason.loggedOut
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
    // Device removed / logged out: clear stale auth so next Connect shows a QR.
    // Preserve the SQLite DB (messages). Disable MCP endpoint until re-link.
    console.log(`[whatsapp-manager:${manager.slug}] Device removed — clearing stale auth, disabling MCP endpoint; DB preserved`)

    // Clear the auth directory asynchronously (don't block)
    clearWhatsAppSession(manager.slug).catch(err => {
      console.error(`[whatsapp-manager:${manager.slug}] Failed to clear auth session:`, err)
    })

    // Reset auth state so next initializeWhatsApp re-initializes cleanly
    manager.authState = undefined
    manager.saveCreds = undefined

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
  stopPresenceKeepalive(manager)
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

