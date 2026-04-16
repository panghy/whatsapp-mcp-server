import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'

// Create a unique temp directory for isolation - hoisted so mock can access it
const testDir = vi.hoisted(() => {
  const path = require('path')
  const os = require('os')
  return path.join(os.tmpdir(), 'wa-manager-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
})

// Mock electron BEFORE importing whatsapp-manager module
vi.mock('electron', () => ({
  app: {
    getPath: () => testDir
  }
}))

// Import the module under test
import {
  disconnectWhatsApp,
  clearWhatsAppSession,
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
      const mockSocket = { ev: { on: vi.fn() }, end: vi.fn() } as any
      manager.socket = mockSocket
      manager.onSocketCreated?.(mockSocket)

      expect(onSocketCreated).toHaveBeenCalledWith(mockSocket)
    })
  })
})

