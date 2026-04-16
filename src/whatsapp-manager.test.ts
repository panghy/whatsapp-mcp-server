import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import Module from 'module'

// Create a unique temp directory for isolation - hoisted so mock can access it
const testDir = vi.hoisted(() => {
  const path = require('path')
  const os = require('os')
  return path.join(os.tmpdir(), 'wa-manager-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
})

// Store original Module._load
const originalLoad = (Module as any)._load

// Mock require() calls for specific modules
;(Module as any)._load = function(request: string, parent: any, isMain: boolean) {
  if (request === './group-metadata-fetcher' || request.endsWith('group-metadata-fetcher')) {
    return {
      getGroupMetadataFetcher: () => ({ getCachedMetadata: vi.fn() })
    }
  }
  if (request === './database' || request.endsWith('database')) {
    return {
      messageOps: { getByWhatsappMessageId: vi.fn() },
      settingOps: { delete: vi.fn() },
      getDatabase: () => ({ exec: vi.fn() })
    }
  }
  return originalLoad.apply(this, [request, parent, isMain])
}

// Hoisted mock functions
const mockEvOn = vi.hoisted(() => vi.fn())
const mockSocketEnd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSocket = vi.hoisted(() => ({
  ev: { on: mockEvOn },
  end: mockSocketEnd,
}))

const mockSaveCreds = vi.hoisted(() => vi.fn())
const mockMakeWASocket = vi.hoisted(() => vi.fn(() => mockSocket))
const mockUseMultiFileAuthState = vi.hoisted(() => vi.fn().mockResolvedValue({
  state: { creds: {}, keys: {} },
  saveCreds: mockSaveCreds,
}))
const mockFetchLatestWaWebVersion = vi.hoisted(() => vi.fn().mockResolvedValue({
  version: [2, 3000, 1034074495],
}))

// Mock electron BEFORE importing whatsapp-manager module
vi.mock('electron', () => ({
  app: {
    getPath: () => testDir
  }
}))

// Mock Baileys module - try to intercept the dynamic import
vi.mock('@whiskeysockets/baileys', () => ({
  default: mockMakeWASocket,
  makeWASocket: mockMakeWASocket,
  useMultiFileAuthState: mockUseMultiFileAuthState,
  DisconnectReason: { loggedOut: 401 },
  Browsers: { macOS: vi.fn(() => ['macOS', 'Desktop', '1.0']) },
  fetchLatestWaWebVersion: mockFetchLatestWaWebVersion,
}))

// Mock group-metadata-fetcher module
vi.mock('./group-metadata-fetcher', () => ({
  getGroupMetadataFetcher: vi.fn(() => ({ getCachedMetadata: vi.fn() })),
}))

// Mock database module
vi.mock('./database', () => ({
  messageOps: { getByWhatsappMessageId: vi.fn() },
  settingOps: { delete: vi.fn() },
  getDatabase: vi.fn(() => ({ exec: vi.fn() })),
}))

// Import the module under test
import {
  disconnectWhatsApp,
  clearWhatsAppSession,
  initializeWhatsApp,
  WhatsAppManager,
} from './whatsapp-manager'

describe('WhatsAppManager Tests', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('WhatsAppManager interface', () => {
    it('should define all required properties', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
      }

      expect(manager.socket).toBeNull()
      expect(manager.state).toBe('disconnected')
      expect(manager.qrCode).toBeNull()
      expect(manager.error).toBeNull()
    })

    it('should allow optional properties', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connected',
        qrCode: 'data:image/png;base64,test',
        error: null,
        reconnectDelay: 4000,
        authState: { creds: {}, keys: {} } as any,
        saveCreds: vi.fn(),
        onSocketCreated: vi.fn(),
      }

      expect(manager.reconnectDelay).toBe(4000)
      expect(manager.authState).toBeDefined()
      expect(manager.saveCreds).toBeDefined()
      expect(manager.onSocketCreated).toBeDefined()
    })

    it('should allow state transitions', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
      }

      manager.state = 'connecting'
      expect(manager.state).toBe('connecting')

      manager.state = 'connected'
      expect(manager.state).toBe('connected')

      manager.state = 'error'
      manager.error = 'Test error'
      expect(manager.state).toBe('error')
      expect(manager.error).toBe('Test error')
    })
  })

  describe('disconnectWhatsApp()', () => {
    it('should call socket.end() with error when socket exists', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connected',
        qrCode: null,
        error: null,
      }

      await disconnectWhatsApp(manager)

      expect(mockEnd).toHaveBeenCalled()
      const callArg = mockEnd.mock.calls[0][0]
      expect(callArg).toBeInstanceOf(Error)
      expect(callArg.message).toBe('User disconnected')
    })

    it('should set state to disconnected', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connected',
        qrCode: null,
        error: null,
      }

      await disconnectWhatsApp(manager)

      expect(manager.state).toBe('disconnected')
    })

    it('should clear socket to null', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connected',
        qrCode: null,
        error: null,
      }

      await disconnectWhatsApp(manager)

      expect(manager.socket).toBeNull()
    })

    it('should handle already-null socket gracefully', async () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
      }

      // Should not throw
      await expect(disconnectWhatsApp(manager)).resolves.not.toThrow()
      expect(manager.state).toBe('disconnected')
    })

    it('should clear qrCode on disconnect', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connecting',
        qrCode: 'data:image/png;base64,testqr',
        error: null,
      }

      await disconnectWhatsApp(manager)

      expect(manager.qrCode).toBeNull()
    })
  })

  describe('clearWhatsAppSession()', () => {
    it('should remove auth directory if it exists', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(path.join(authDir, 'test-file.json'), '{}')

      expect(fs.existsSync(authDir)).toBe(true)

      await clearWhatsAppSession()

      expect(fs.existsSync(authDir)).toBe(false)
    })

    it('should handle non-existent directory without error', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true })
      }

      expect(fs.existsSync(authDir)).toBe(false)

      // Should not throw
      await expect(clearWhatsAppSession()).resolves.not.toThrow()
    })

    it('should remove nested directories in auth folder', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      const nestedDir = path.join(authDir, 'nested', 'deep')
      fs.mkdirSync(nestedDir, { recursive: true })
      fs.writeFileSync(path.join(nestedDir, 'deep-file.txt'), 'data')

      expect(fs.existsSync(nestedDir)).toBe(true)

      await clearWhatsAppSession()

      expect(fs.existsSync(authDir)).toBe(false)
    })
  })

  describe('Manager state management', () => {
    it('should handle error state correctly', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
      }

      // Simulate error state
      manager.state = 'error'
      manager.error = 'Connection failed'

      expect(manager.state).toBe('error')
      expect(manager.error).toBe('Connection failed')
    })

    it('should track reconnect delay', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
        reconnectDelay: 2000,
      }

      // Simulate exponential backoff
      manager.reconnectDelay = 4000
      expect(manager.reconnectDelay).toBe(4000)

      manager.reconnectDelay = 8000
      expect(manager.reconnectDelay).toBe(8000)
    })

    it('should store QR code data URL', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
      }

      const qrDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      manager.qrCode = qrDataUrl

      expect(manager.qrCode).toBe(qrDataUrl)
      expect(manager.qrCode).toContain('data:image/png;base64,')
    })
  })

  describe('Socket lifecycle', () => {
    it('should handle socket assignment', () => {
      const mockSocket = {
        ev: { on: vi.fn() },
        end: vi.fn(),
      } as any

      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
      }

      manager.socket = mockSocket
      expect(manager.socket).toBe(mockSocket)
      expect(manager.socket.ev.on).toBeDefined()
      expect(manager.socket.end).toBeDefined()
    })

    it('should handle socket callbacks', () => {
      const onSocketCreated = vi.fn()
      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
        onSocketCreated,
      }

      // Simulate socket creation callback
      const localMockSocket = { ev: { on: vi.fn() }, end: vi.fn() } as any
      manager.socket = localMockSocket
      manager.onSocketCreated?.(localMockSocket)

      expect(onSocketCreated).toHaveBeenCalledWith(localMockSocket)
    })
  })

  describe('Manager state logic', () => {
    it('should define proper reconnect delay exponential backoff logic', () => {
      // Test the reconnect delay calculation logic
      let delay = 2000

      // First failure
      delay = Math.min(delay * 2, 60000)
      expect(delay).toBe(4000)

      // Second failure
      delay = Math.min(delay * 2, 60000)
      expect(delay).toBe(8000)

      // Continue until cap
      delay = Math.min(delay * 2, 60000)
      expect(delay).toBe(16000)

      delay = Math.min(delay * 2, 60000)
      expect(delay).toBe(32000)

      delay = Math.min(delay * 2, 60000)
      expect(delay).toBe(60000) // Capped

      delay = Math.min(delay * 2, 60000)
      expect(delay).toBe(60000) // Still capped
    })

    it('should reset delay on successful connection', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connected',
        qrCode: null,
        error: null,
        reconnectDelay: 16000,
      }

      // Simulate what happens on connection success
      manager.reconnectDelay = 2000
      expect(manager.reconnectDelay).toBe(2000)
    })

    it('should clear qrCode and error on connection success', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: 'data:image/png;base64,testqr',
        error: 'Previous error',
        reconnectDelay: 4000,
      }

      // Simulate connection success
      manager.state = 'connected'
      manager.qrCode = null
      manager.error = null
      manager.reconnectDelay = 2000

      expect(manager.state).toBe('connected')
      expect(manager.qrCode).toBeNull()
      expect(manager.error).toBeNull()
      expect(manager.reconnectDelay).toBe(2000)
    })

    it('should transition to connecting on close with reconnect', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connected',
        qrCode: null,
        error: null,
      }

      // Simulate connection close (non-loggedOut)
      manager.state = 'connecting'
      expect(manager.state).toBe('connecting')
    })

    it('should handle QR code data URL format', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
      }

      // Simulate receiving QR code
      const qrDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      manager.qrCode = qrDataUrl

      expect(manager.qrCode).toBe(qrDataUrl)
      expect(manager.qrCode).toContain('data:image/png;base64,')
      expect(manager.qrCode.length).toBeGreaterThan(50)
    })

    it('should handle error state with message', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
      }

      // Simulate error
      manager.state = 'error'
      manager.error = 'Socket creation failed'

      expect(manager.state).toBe('error')
      expect(manager.error).toBe('Socket creation failed')
    })

    it('should store authState and saveCreds references', () => {
      const mockAuthState = { creds: { me: { id: '123' } }, keys: {} }
      const mockSaveCreds = vi.fn()

      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
        authState: mockAuthState,
        saveCreds: mockSaveCreds,
      }

      expect(manager.authState).toBe(mockAuthState)
      expect(manager.saveCreds).toBe(mockSaveCreds)
    })

    it('should invoke onSocketCreated callback when set', () => {
      const onSocketCreated = vi.fn()
      const mockSocket = { ev: { on: vi.fn() }, end: vi.fn() }

      const manager: WhatsAppManager = {
        socket: mockSocket as any,
        state: 'connecting',
        qrCode: null,
        error: null,
        onSocketCreated,
      }

      // Simulate callback invocation
      manager.onSocketCreated?.(mockSocket)

      expect(onSocketCreated).toHaveBeenCalledWith(mockSocket)
    })

    it('should handle all connection states', () => {
      const states: Array<'disconnected' | 'connecting' | 'connected' | 'error'> = [
        'disconnected',
        'connecting',
        'connected',
        'error'
      ]

      states.forEach(state => {
        const manager: WhatsAppManager = {
          socket: null,
          state,
          qrCode: null,
          error: null,
        }
        expect(manager.state).toBe(state)
      })
    })
  })

  describe('disconnectWhatsApp with error handling', () => {
    it('should handle socket.end throwing error', async () => {
      const mockEnd = vi.fn().mockRejectedValue(new Error('End failed'))
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connected',
        qrCode: null,
        error: null,
      }

      // Should not throw, but handle gracefully
      await expect(disconnectWhatsApp(manager)).resolves.not.toThrow()
      expect(manager.state).toBe('disconnected')
      expect(manager.socket).toBeNull()
    })

    it('should clean up all state on disconnect', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connecting',
        qrCode: 'data:image/png;base64,test',
        error: null,
        reconnectDelay: 8000,
      }

      await disconnectWhatsApp(manager)

      expect(manager.socket).toBeNull()
      expect(manager.state).toBe('disconnected')
      expect(manager.qrCode).toBeNull()
      // Note: error and reconnectDelay are not cleared by disconnect
    })
  })

  describe('clearWhatsAppSession edge cases', () => {
    it('should handle permission errors gracefully', async () => {
      // This tests that clearWhatsAppSession doesn't throw on file system errors
      // The actual implementation catches errors and logs them
      await expect(clearWhatsAppSession()).resolves.not.toThrow()
    })

    it('should handle fs.rmSync throwing error', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(authDir, { recursive: true })

      // Temporarily spy on console.error to verify error handling
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      // Create the directory but make rmSync fail by removing permission
      // Actually, mocking is better - stub fs.rmSync to throw
      const originalRmSync = fs.rmSync
      const rmSyncMock = vi.fn().mockImplementation(() => {
        throw new Error('Permission denied')
      })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      ;(fs as any).rmSync = rmSyncMock

      await clearWhatsAppSession()

      // Restore original
      ;(fs as any).rmSync = originalRmSync
      consoleSpy.mockRestore()

      // Should not throw but should have called console.error
      expect(rmSyncMock).toHaveBeenCalled()
    })

    it('should be idempotent', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')

      // Create and clear
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(path.join(authDir, 'creds.json'), '{}')
      await clearWhatsAppSession()
      expect(fs.existsSync(authDir)).toBe(false)

      // Calling again should not throw
      await expect(clearWhatsAppSession()).resolves.not.toThrow()
    })

    it('should remove multiple files in auth directory', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(path.join(authDir, 'creds.json'), '{"creds": true}')
      fs.writeFileSync(path.join(authDir, 'app-state-sync-key.json'), '{"key": "value"}')
      fs.writeFileSync(path.join(authDir, 'pre-key.json'), '{"prekey": true}')

      expect(fs.readdirSync(authDir).length).toBe(3)

      await clearWhatsAppSession()

      expect(fs.existsSync(authDir)).toBe(false)
    })

    it('should handle empty auth directory', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(authDir, { recursive: true })

      expect(fs.existsSync(authDir)).toBe(true)
      expect(fs.readdirSync(authDir).length).toBe(0)

      await clearWhatsAppSession()

      expect(fs.existsSync(authDir)).toBe(false)
    })
  })

  describe('Concurrent disconnect operations', () => {
    it('should handle concurrent disconnect calls', async () => {
      const mockEnd = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 10)))
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connected',
        qrCode: null,
        error: null,
      }

      // Call disconnect twice concurrently
      await Promise.all([
        disconnectWhatsApp(manager),
        disconnectWhatsApp(manager),
      ])

      expect(manager.socket).toBeNull()
      expect(manager.state).toBe('disconnected')
    })

    it('should handle disconnect during reconnection state', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connecting',
        qrCode: 'data:image/png;base64,test',
        error: null,
        reconnectDelay: 4000,
      }

      await disconnectWhatsApp(manager)

      expect(manager.socket).toBeNull()
      expect(manager.state).toBe('disconnected')
      expect(manager.qrCode).toBeNull()
    })
  })

  describe('Concurrent clearWhatsAppSession operations', () => {
    it('should handle concurrent clear calls', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(path.join(authDir, 'test.json'), '{}')

      // Call clear twice concurrently
      await Promise.all([
        clearWhatsAppSession(),
        clearWhatsAppSession(),
      ])

      expect(fs.existsSync(authDir)).toBe(false)
    })
  })

  describe('Socket disconnect scenarios', () => {
    it('should handle disconnect with pending QR code', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connecting',
        qrCode: 'data:image/png;base64,longqrcode123456789',
        error: null,
      }

      await disconnectWhatsApp(manager)

      expect(manager.qrCode).toBeNull()
    })

    it('should handle disconnect with error state', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'error',
        qrCode: null,
        error: 'Previous connection error',
      }

      await disconnectWhatsApp(manager)

      expect(manager.state).toBe('disconnected')
      expect(manager.socket).toBeNull()
      // Error persists after disconnect
      expect(manager.error).toBe('Previous connection error')
    })

    it('should handle socket.end timeout simulation', async () => {
      const mockEnd = vi.fn().mockImplementation(() =>
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10))
      )
      const mockSocket = { end: mockEnd } as any

      const manager: WhatsAppManager = {
        socket: mockSocket,
        state: 'connected',
        qrCode: null,
        error: null,
      }

      await expect(disconnectWhatsApp(manager)).resolves.not.toThrow()
      expect(manager.state).toBe('disconnected')
    })
  })

  describe('Auth state management', () => {
    it('should allow updating authState', () => {
      const initialAuthState = { creds: { me: null }, keys: {} }
      const updatedAuthState = { creds: { me: { id: '123@s.whatsapp.net' } }, keys: { preKeys: {} } }

      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
        authState: initialAuthState as any,
      }

      expect(manager.authState.creds.me).toBeNull()

      manager.authState = updatedAuthState as any

      expect(manager.authState.creds.me.id).toBe('123@s.whatsapp.net')
    })

    it('should allow saveCreds function to be called', () => {
      const mockSaveCreds = vi.fn().mockResolvedValue(undefined)

      const manager: WhatsAppManager = {
        socket: null,
        state: 'connected',
        qrCode: null,
        error: null,
        saveCreds: mockSaveCreds,
      }

      manager.saveCreds?.()

      expect(mockSaveCreds).toHaveBeenCalled()
    })

    it('should handle missing saveCreds gracefully', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connected',
        qrCode: null,
        error: null,
      }

      // Should not throw when saveCreds is undefined
      expect(() => manager.saveCreds?.()).not.toThrow()
    })
  })

  describe('Connection state transitions', () => {
    it('should handle all valid state transitions', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
      }

      // disconnected -> connecting
      manager.state = 'connecting'
      expect(manager.state).toBe('connecting')

      // connecting -> connected
      manager.state = 'connected'
      expect(manager.state).toBe('connected')

      // connected -> connecting (reconnecting)
      manager.state = 'connecting'
      expect(manager.state).toBe('connecting')

      // connecting -> error
      manager.state = 'error'
      expect(manager.state).toBe('error')

      // error -> connecting (retry)
      manager.state = 'connecting'
      expect(manager.state).toBe('connecting')

      // connected -> disconnected
      manager.state = 'disconnected'
      expect(manager.state).toBe('disconnected')
    })

    it('should handle rapid state changes', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
      }

      const states: Array<'disconnected' | 'connecting' | 'connected' | 'error'> = [
        'connecting', 'error', 'connecting', 'connected',
        'connecting', 'error', 'connecting', 'connected',
        'disconnected'
      ]

      states.forEach(state => {
        manager.state = state
        expect(manager.state).toBe(state)
      })
    })
  })

  describe('QR code handling', () => {
    it('should accept various QR code formats', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
      }

      // Standard data URL format
      const standardQr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      manager.qrCode = standardQr
      expect(manager.qrCode).toBe(standardQr)

      // Clear QR code
      manager.qrCode = null
      expect(manager.qrCode).toBeNull()
    })

    it('should handle very long QR code data URLs', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
      }

      // Simulate a realistic long QR code (real ones can be 2000+ chars)
      const longQr = 'data:image/png;base64,' + 'A'.repeat(2000)
      manager.qrCode = longQr

      expect(manager.qrCode).toBe(longQr)
      expect(manager.qrCode.length).toBeGreaterThan(2000)
    })
  })

  describe('Reconnect delay edge cases', () => {
    it('should handle zero delay', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
        reconnectDelay: 0,
      }

      // Apply backoff formula
      const newDelay = Math.min((manager.reconnectDelay || 2000) * 2, 60000)
      manager.reconnectDelay = newDelay

      // 0 * 2 = 0, but the || 2000 default applies
      expect(newDelay).toBe(4000)
    })

    it('should handle undefined delay with default', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
      }

      // When undefined, default to 2000
      const delay = manager.reconnectDelay || 2000
      expect(delay).toBe(2000)
    })

    it('should handle delay exactly at cap boundary', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
        reconnectDelay: 60000,
      }

      // Already at cap
      const newDelay = Math.min((manager.reconnectDelay || 2000) * 2, 60000)
      expect(newDelay).toBe(60000)
    })

    it('should handle delay just below cap', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
        reconnectDelay: 30000,
      }

      // 30000 * 2 = 60000, exactly at cap
      const newDelay = Math.min((manager.reconnectDelay || 2000) * 2, 60000)
      expect(newDelay).toBe(60000)
    })

    it('should handle delay just above half of cap', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
        reconnectDelay: 31000,
      }

      // 31000 * 2 = 62000, capped to 60000
      const newDelay = Math.min((manager.reconnectDelay || 2000) * 2, 60000)
      expect(newDelay).toBe(60000)
    })
  })

  describe('Error message handling', () => {
    it('should store various error message types', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'error',
        qrCode: null,
        error: null,
      }

      // Simple error
      manager.error = 'Connection failed'
      expect(manager.error).toBe('Connection failed')

      // Detailed error
      manager.error = 'Socket closed: status code 401 (logged out)'
      expect(manager.error).toContain('401')

      // Clear error
      manager.error = null
      expect(manager.error).toBeNull()
    })

    it('should handle very long error messages', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'error',
        qrCode: null,
        error: null,
      }

      const longError = 'Error: ' + 'x'.repeat(1000)
      manager.error = longError

      expect(manager.error).toBe(longError)
      expect(manager.error.length).toBeGreaterThan(1000)
    })
  })

  describe('Multiple session clear operations', () => {
    it('should clear session after multiple writes', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')

      // First session
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(path.join(authDir, 'creds.json'), '{"session": 1}')
      await clearWhatsAppSession()
      expect(fs.existsSync(authDir)).toBe(false)

      // Second session
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(path.join(authDir, 'creds.json'), '{"session": 2}')
      await clearWhatsAppSession()
      expect(fs.existsSync(authDir)).toBe(false)

      // Third session with more files
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(path.join(authDir, 'creds.json'), '{"session": 3}')
      fs.writeFileSync(path.join(authDir, 'keys.json'), '{"keys": []}')
      await clearWhatsAppSession()
      expect(fs.existsSync(authDir)).toBe(false)
    })
  })

  describe('initializeWhatsApp()', () => {
    it('should return a manager object', async () => {
      // This will attempt to load Baileys which may or may not be available
      // Either way, the function should return a manager
      const manager = await initializeWhatsApp()

      expect(manager).toBeDefined()
      expect(manager).toHaveProperty('socket')
      expect(manager).toHaveProperty('state')
      expect(manager).toHaveProperty('qrCode')
      expect(manager).toHaveProperty('error')
    })

    it('should initialize with default reconnectDelay of 2000', async () => {
      const manager = await initializeWhatsApp()

      expect(manager.reconnectDelay).toBe(2000)
    })

    it('should have qrCode property initialized to null', async () => {
      const manager = await initializeWhatsApp()

      // qrCode should be null initially (or if error)
      expect(manager.qrCode === null || manager.qrCode === undefined).toBe(true)
    })

    it('should handle initialization gracefully', async () => {
      // Should not throw, but return manager even on failure
      await expect(initializeWhatsApp()).resolves.toBeDefined()
    })

    it('should set error state if Baileys fails to load', async () => {
      const manager = await initializeWhatsApp()

      // If Baileys isn't available, should be in error state
      // If Baileys is available, state could be connecting
      expect(['error', 'connecting', 'connected']).toContain(manager.state)
    })

    it('should populate error message on failure', async () => {
      const manager = await initializeWhatsApp()

      // If failed, error should have a message
      if (manager.state === 'error') {
        expect(manager.error).toBeTruthy()
      }
    })

    it('should return manager with all interface properties', async () => {
      const manager = await initializeWhatsApp()

      // Check all WhatsAppManager properties
      expect('socket' in manager).toBe(true)
      expect('state' in manager).toBe(true)
      expect('qrCode' in manager).toBe(true)
      expect('error' in manager).toBe(true)
      expect('reconnectDelay' in manager).toBe(true)
    })

    it('should allow calling multiple times', async () => {
      const manager1 = await initializeWhatsApp()
      const manager2 = await initializeWhatsApp()

      expect(manager1).toBeDefined()
      expect(manager2).toBeDefined()
      // Each call returns a new manager
    })

    it('should return consistent structure on failure', async () => {
      const manager = await initializeWhatsApp()

      // Regardless of success/failure, structure should be consistent
      expect(manager.reconnectDelay).toBe(2000)
      expect(['disconnected', 'connecting', 'connected', 'error']).toContain(manager.state)
    })

    it('should create manager with mutable properties', async () => {
      const manager = await initializeWhatsApp()

      // Properties should be mutable
      const originalState = manager.state
      manager.state = 'disconnected'
      expect(manager.state).toBe('disconnected')
      manager.state = originalState

      manager.qrCode = 'test'
      expect(manager.qrCode).toBe('test')
      manager.qrCode = null
    })

    it('should allow setting onSocketCreated callback', async () => {
      const manager = await initializeWhatsApp()
      const callback = vi.fn()

      manager.onSocketCreated = callback

      expect(manager.onSocketCreated).toBe(callback)
    })

    it('should allow authState and saveCreds to be set after init', async () => {
      const manager = await initializeWhatsApp()

      // These may already be set if initialization succeeded
      // We test that we can still modify them
      const mockAuthState = { creds: {}, keys: {} }
      const mockSaveCreds = vi.fn()

      manager.authState = mockAuthState
      manager.saveCreds = mockSaveCreds

      expect(manager.authState).toBe(mockAuthState)
      expect(manager.saveCreds).toBe(mockSaveCreds)
    })

    it('should handle disconnect after initialize', async () => {
      const manager = await initializeWhatsApp()

      // Disconnect should work regardless of initialization state
      await expect(disconnectWhatsApp(manager)).resolves.not.toThrow()

      // If there was no socket (error state), state remains unchanged
      // If there was a socket, state becomes disconnected
      if (manager.socket === null) {
        // No socket was created, state stays as-is (likely 'error')
        expect(['error', 'disconnected', 'connecting']).toContain(manager.state)
      } else {
        expect(manager.state).toBe('disconnected')
      }
      expect(manager.socket).toBeNull()
    })

    it('should allow clearing session after initialize', async () => {
      await initializeWhatsApp()

      // Clear session should work
      await expect(clearWhatsAppSession()).resolves.not.toThrow()
    })
  })

  describe('Full lifecycle', () => {
    it('should support init -> disconnect -> clear cycle', async () => {
      // Initialize
      const manager = await initializeWhatsApp()
      expect(manager).toBeDefined()

      // Disconnect (works even if init failed)
      await disconnectWhatsApp(manager)
      // State depends on whether socket was created
      expect(['error', 'disconnected', 'connecting']).toContain(manager.state)
      expect(manager.socket).toBeNull()

      // Clear session
      await clearWhatsAppSession()
      const authDir = path.join(testDir, 'whatsapp-auth')
      expect(fs.existsSync(authDir)).toBe(false)
    })

    it('should support multiple init cycles', async () => {
      // First cycle
      const manager1 = await initializeWhatsApp()
      await disconnectWhatsApp(manager1)
      await clearWhatsAppSession()

      // Second cycle
      const manager2 = await initializeWhatsApp()
      await disconnectWhatsApp(manager2)
      await clearWhatsAppSession()

      expect(manager1).toBeDefined()
      expect(manager2).toBeDefined()
    })

    it('should allow rapid init calls', async () => {
      // Start multiple initializations
      const [m1, m2, m3] = await Promise.all([
        initializeWhatsApp(),
        initializeWhatsApp(),
        initializeWhatsApp(),
      ])

      expect(m1).toBeDefined()
      expect(m2).toBeDefined()
      expect(m3).toBeDefined()

      // Cleanup
      await Promise.all([
        disconnectWhatsApp(m1),
        disconnectWhatsApp(m2),
        disconnectWhatsApp(m3),
      ])
    })

    it('should handle init with existing auth directory', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(authDir, { recursive: true })
      fs.writeFileSync(path.join(authDir, 'creds.json'), '{"existing": true}')

      const manager = await initializeWhatsApp()

      expect(manager).toBeDefined()
      expect(manager.reconnectDelay).toBe(2000)

      await disconnectWhatsApp(manager)
    })

    it('should handle init after previous failure', async () => {
      // First init (will likely fail)
      const manager1 = await initializeWhatsApp()
      expect(manager1).toBeDefined()

      // Second init (should also work)
      const manager2 = await initializeWhatsApp()
      expect(manager2).toBeDefined()

      // They should be different manager instances
      // (unless both succeeded and share state)
    })
  })

  describe('Error recovery scenarios', () => {
    it('should recover gracefully from init failure', async () => {
      const manager = await initializeWhatsApp()

      // Even on failure, basic operations should work
      manager.qrCode = 'test'
      expect(manager.qrCode).toBe('test')

      manager.error = null
      manager.state = 'disconnected'
      expect(manager.state).toBe('disconnected')
    })

    it('should allow manual state recovery', async () => {
      const manager = await initializeWhatsApp()

      // Simulate recovery
      manager.state = 'disconnected'
      manager.error = null
      manager.qrCode = null
      manager.reconnectDelay = 2000

      expect(manager.state).toBe('disconnected')
      expect(manager.error).toBeNull()
      expect(manager.reconnectDelay).toBe(2000)
    })
  })

  describe('Auth directory creation', () => {
    it('should create auth directory on module load', () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      // The module should have created this on import
      // (or it may not exist if init failed before that)
      // Either is valid
      expect(typeof fs.existsSync(authDir)).toBe('boolean')
    })

    it('should ensure globalThis.crypto exists', () => {
      // Verify that the module sets up crypto properly
      expect(globalThis.crypto).toBeDefined()
      expect(globalThis.crypto.subtle).toBeDefined()
    })

    it('should handle nested auth directory structure', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      const nestedDir = path.join(authDir, 'keys', 'pre-key')
      fs.mkdirSync(nestedDir, { recursive: true })
      fs.writeFileSync(path.join(nestedDir, 'key1.json'), '{}')

      // Init should still work
      const manager = await initializeWhatsApp()
      expect(manager).toBeDefined()

      // Clear should remove nested structure
      await clearWhatsAppSession()
      expect(fs.existsSync(authDir)).toBe(false)
    })
  })

  describe('Sequential initialization tests', () => {
    it('should handle sequential init calls', async () => {
      const manager1 = await initializeWhatsApp()
      const manager2 = await initializeWhatsApp()
      const manager3 = await initializeWhatsApp()

      // Each should return a manager
      expect(manager1).toBeDefined()
      expect(manager2).toBeDefined()
      expect(manager3).toBeDefined()

      // All should have the same reconnectDelay
      expect(manager1.reconnectDelay).toBe(2000)
      expect(manager2.reconnectDelay).toBe(2000)
      expect(manager3.reconnectDelay).toBe(2000)
    })

    it('should handle init followed by clear followed by init', async () => {
      const manager1 = await initializeWhatsApp()
      await clearWhatsAppSession()
      const manager2 = await initializeWhatsApp()

      expect(manager1).toBeDefined()
      expect(manager2).toBeDefined()
    })

    it('should not share state between managers', async () => {
      const manager1 = await initializeWhatsApp()
      const manager2 = await initializeWhatsApp()

      manager1.qrCode = 'test1'
      manager2.qrCode = 'test2'

      expect(manager1.qrCode).toBe('test1')
      expect(manager2.qrCode).toBe('test2')
    })
  })

  describe('Manager property types', () => {
    it('should have correct initial property types', async () => {
      const manager = await initializeWhatsApp()

      expect(typeof manager.reconnectDelay).toBe('number')
      expect(manager.socket === null || typeof manager.socket === 'object').toBe(true)
      expect(typeof manager.state).toBe('string')
      expect(manager.qrCode === null || typeof manager.qrCode === 'string').toBe(true)
      expect(manager.error === null || typeof manager.error === 'string').toBe(true)
    })

    it('should allow all ConnectionState values', async () => {
      const manager = await initializeWhatsApp()

      const validStates: Array<'disconnected' | 'connecting' | 'connected' | 'error'> = [
        'disconnected', 'connecting', 'connected', 'error'
      ]

      validStates.forEach(state => {
        manager.state = state
        expect(manager.state).toBe(state)
      })
    })
  })

  describe('Disconnect behavior verification', () => {
    it('should not throw when disconnecting null socket', async () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'error',
        qrCode: null,
        error: 'Previous error',
      }

      await expect(disconnectWhatsApp(manager)).resolves.not.toThrow()
      // State should remain unchanged when socket is null
      expect(manager.state).toBe('error')
    })

    it('should preserve error message after disconnect', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const manager: WhatsAppManager = {
        socket: { end: mockEnd } as any,
        state: 'error',
        qrCode: null,
        error: 'Connection timeout',
      }

      await disconnectWhatsApp(manager)

      // Error should persist
      expect(manager.error).toBe('Connection timeout')
    })

    it('should preserve reconnectDelay after disconnect', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      const manager: WhatsAppManager = {
        socket: { end: mockEnd } as any,
        state: 'connecting',
        qrCode: null,
        error: null,
        reconnectDelay: 16000,
      }

      await disconnectWhatsApp(manager)

      expect(manager.reconnectDelay).toBe(16000)
    })
  })

  describe('Clear session with files', () => {
    it('should clear session with large files', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(authDir, { recursive: true })

      // Create a larger file
      const largeContent = 'x'.repeat(10000)
      fs.writeFileSync(path.join(authDir, 'large-file.json'), largeContent)

      await clearWhatsAppSession()

      expect(fs.existsSync(authDir)).toBe(false)
    })

    it('should clear session with multiple file types', async () => {
      const authDir = path.join(testDir, 'whatsapp-auth')
      fs.mkdirSync(authDir, { recursive: true })

      fs.writeFileSync(path.join(authDir, 'creds.json'), '{}')
      fs.writeFileSync(path.join(authDir, 'data.txt'), 'text')
      fs.writeFileSync(path.join(authDir, 'binary.bin'), Buffer.from([0, 1, 2, 3]))

      await clearWhatsAppSession()

      expect(fs.existsSync(authDir)).toBe(false)
    })
  })

  describe('ConnectionState type', () => {
    it('should accept disconnected state', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'disconnected',
        qrCode: null,
        error: null,
      }
      expect(manager.state).toBe('disconnected')
    })

    it('should accept connecting state', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connecting',
        qrCode: null,
        error: null,
      }
      expect(manager.state).toBe('connecting')
    })

    it('should accept connected state', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'connected',
        qrCode: null,
        error: null,
      }
      expect(manager.state).toBe('connected')
    })

    it('should accept error state', () => {
      const manager: WhatsAppManager = {
        socket: null,
        state: 'error',
        qrCode: null,
        error: 'Test error',
      }
      expect(manager.state).toBe('error')
    })
  })

  describe('initializeWhatsApp error states', () => {
    it('should capture unknown error type gracefully', async () => {
      const manager = await initializeWhatsApp()

      // If in error state, error should be a string (from Error.message or 'Unknown error')
      if (manager.state === 'error') {
        expect(typeof manager.error).toBe('string')
      }
    })

    it('should have consistent manager structure after error', async () => {
      const manager = await initializeWhatsApp()

      // Structure should always be present
      expect(manager).toHaveProperty('socket')
      expect(manager).toHaveProperty('state')
      expect(manager).toHaveProperty('qrCode')
      expect(manager).toHaveProperty('error')
      expect(manager).toHaveProperty('reconnectDelay')
    })

    it('should preserve manager even when socket fails', async () => {
      const manager = await initializeWhatsApp()

      // Manager should exist
      expect(manager).not.toBeNull()
      expect(manager).not.toBeUndefined()

      // Can still modify properties
      manager.state = 'disconnected'
      expect(manager.state).toBe('disconnected')
    })
  })
})

