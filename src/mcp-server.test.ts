import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import http from 'http'

// Create a unique temp directory - hoisted so mock can access it
const testDir = vi.hoisted(() => {
  const path = require('path')
  const os = require('os')
  return path.join(os.tmpdir(), 'mcp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
})

// Track random port for test isolation
let testPort = vi.hoisted(() => 50000 + Math.floor(Math.random() * 10000))

// Mock electron BEFORE importing modules that use it
vi.mock('electron', () => ({
  app: {
    getPath: () => testDir
  }
}))

// Now import modules - mocks are already in place
import { initializeDatabase, closeDatabase, chatOps, messageOps, contactOps, settingOps } from './database'
import {
  startMcpServer,
  stopMcpServer,
  isMcpServerRunning,
  getMcpPort,
  setMcpPort,
  setWhatsAppManager
} from './mcp-server'

// Helper to make HTTP requests
function makeRequest(options: http.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString()
        })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('MCP Server Tests', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(async () => {
    await stopMcpServer().catch(() => {})
    closeDatabase()
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    closeDatabase()
    const dbDir = path.join(testDir, 'nodexa-whatsapp')
    if (fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
    fs.mkdirSync(dbDir, { recursive: true })
    initializeDatabase()
    // Generate a new random port for each test
    testPort = 50000 + Math.floor(Math.random() * 10000)
  })

  afterEach(async () => {
    await stopMcpServer().catch(() => {})
  })

  describe('Port Settings', () => {
    it('should return default port 13491 when no setting exists', () => {
      const port = getMcpPort()
      expect(port).toBe(13491)
    })

    it('should round-trip port setting correctly', () => {
      setMcpPort(8080)
      expect(getMcpPort()).toBe(8080)

      setMcpPort(3000)
      expect(getMcpPort()).toBe(3000)
    })
  })

  describe('Server Lifecycle', () => {
    it('should start server and report running', async () => {
      expect(isMcpServerRunning()).toBe(false)

      await startMcpServer(testPort)

      expect(isMcpServerRunning()).toBe(true)
    })

    it('should stop server and report not running', async () => {
      await startMcpServer(testPort)
      expect(isMcpServerRunning()).toBe(true)

      await stopMcpServer()

      expect(isMcpServerRunning()).toBe(false)
    })

    it('should throw when starting server that is already running', async () => {
      await startMcpServer(testPort)

      await expect(startMcpServer(testPort + 1)).rejects.toThrow('MCP server is already running')
    })

    it('should handle stopMcpServer when server is not running', async () => {
      // Should not throw
      await stopMcpServer()
      expect(isMcpServerRunning()).toBe(false)
    })
  })

  describe('Health Endpoint', () => {
    it('should return status ok from /health endpoint', async () => {
      await startMcpServer(testPort)

      const response = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/health',
        method: 'GET'
      })

      expect(response.status).toBe(200)
      const json = JSON.parse(response.body)
      expect(json.status).toBe('ok')
    })
  })

  describe('HTTP Routing', () => {
    it('should return 404 for unknown endpoints', async () => {
      await startMcpServer(testPort)

      const response = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/unknown',
        method: 'GET'
      })

      expect(response.status).toBe(404)
    })

    it('should return 404 for GET /mcp', async () => {
      await startMcpServer(testPort)

      const response = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/mcp',
        method: 'GET'
      })

      expect(response.status).toBe(404)
    })

    it('should handle invalid JSON on POST /mcp', async () => {
      await startMcpServer(testPort)

      const response = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, 'not valid json')

      expect(response.status).toBe(400)
      const json = JSON.parse(response.body)
      expect(json.error).toBe('Invalid JSON')
    })
  })

  describe('setWhatsAppManager', () => {
    it('should accept manager without throwing', () => {
      // Just test that it doesn't throw
      expect(() => setWhatsAppManager(null as any)).not.toThrow()
    })
  })

  describe('Database Seeding for Tool Tests', () => {
    it('should insert and retrieve chats for search', () => {
      // Seed chats
      chatOps.insert('alice@s.whatsapp.net', 'dm', undefined, 'Alice Smith')
      chatOps.insert('bob@s.whatsapp.net', 'dm', undefined, 'Bob Jones')
      chatOps.insert('family@g.us', 'group', undefined, 'Family Group')

      const chats = chatOps.getAll() as any[]
      expect(chats).toHaveLength(3)
      expect(chats.find(c => c.name === 'Alice Smith')).toBeDefined()
    })

    it('should filter disabled chats', () => {
      chatOps.insert('enabled@s.whatsapp.net', 'dm', undefined, 'Enabled Chat')
      chatOps.insert('disabled@s.whatsapp.net', 'dm', undefined, 'Disabled Chat')

      // Disable the second chat
      const disabledChat = chatOps.getByWhatsappJid('disabled@s.whatsapp.net') as any
      chatOps.updateEnabled(disabledChat.id, false)

      // When MCP server searches, it should filter out disabled
      const allChats = chatOps.getAll() as any[]
      const enabledOnly = allChats.filter((c: any) => c.enabled)

      expect(enabledOnly).toHaveLength(1)
      expect(enabledOnly[0].name).toBe('Enabled Chat')
    })

    it('should insert messages and retrieve by chat ID', () => {
      chatOps.insert('msgchat@s.whatsapp.net', 'dm', undefined, 'Message Chat')
      const chat = chatOps.getByWhatsappJid('msgchat@s.whatsapp.net') as any

      const now = Date.now()
      messageOps.insert(chat.id, 'msg-1', now - 2000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message',
        messageId: 'msg-1',
        timestamp: new Date(now - 2000).toISOString(),
        text: 'Hello'
      }), false)

      messageOps.insert(chat.id, 'msg-2', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message',
        messageId: 'msg-2',
        timestamp: new Date(now - 1000).toISOString(),
        text: 'World'
      }), false)

      const messages = messageOps.getByChatId(chat.id) as any[]
      expect(messages).toHaveLength(2)
    })

    it('should filter messages by timestamp', () => {
      chatOps.insert('timechat@s.whatsapp.net', 'dm', undefined, 'Time Chat')
      const chat = chatOps.getByWhatsappJid('timechat@s.whatsapp.net') as any

      const now = Date.now()
      const oneHourAgo = now - 60 * 60 * 1000
      const twoHoursAgo = now - 2 * 60 * 60 * 1000

      messageOps.insert(chat.id, 'old-msg', twoHoursAgo, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message',
        messageId: 'old-msg',
        timestamp: new Date(twoHoursAgo).toISOString(),
        text: 'Old message'
      }), false)

      messageOps.insert(chat.id, 'new-msg', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message',
        messageId: 'new-msg',
        timestamp: new Date(now - 1000).toISOString(),
        text: 'New message'
      }), false)

      // Filter by timestamp (simulating "since" parameter)
      const allMessages = messageOps.getByChatId(chat.id) as any[]
      const filteredMessages = allMessages.filter((m: any) => m.timestamp >= oneHourAgo)

      expect(allMessages).toHaveLength(2)
      expect(filteredMessages).toHaveLength(1)
      expect(JSON.parse(filteredMessages[0].content_json).text).toBe('New message')
    })

    it('should insert and retrieve contacts by JID', () => {
      contactOps.insert('user@s.whatsapp.net', 'John Doe', '+1234567890')

      const contact = contactOps.getByJid('user@s.whatsapp.net') as any
      expect(contact).toBeDefined()
      expect(contact.name).toBe('John Doe')
      expect(contact.phone_number).toBe('+1234567890')
    })

    it('should retrieve contacts by phone number', () => {
      contactOps.insert('phone-user@s.whatsapp.net', 'Jane Doe', '+9876543210')

      const contact = contactOps.getByPhone('+9876543210') as any
      expect(contact).toBeDefined()
      expect(contact.name).toBe('Jane Doe')
    })

    it('should retrieve contacts by LID', () => {
      contactOps.insert('lid-user@lid', 'LID User', '+1111111111', 'lid-value-123')

      const contact = contactOps.getByLid('lid-value-123') as any
      expect(contact).toBeDefined()
      expect(contact.name).toBe('LID User')
    })
  })

  describe('Settings Operations', () => {
    it('should store and retrieve last_unread_check', () => {
      const timestamp = new Date().toISOString()
      settingOps.set('last_unread_check', timestamp)

      const stored = settingOps.get('last_unread_check')
      expect(stored).toBe(timestamp)
    })

    it('should store user identity settings', () => {
      settingOps.set('user_display_name', 'Test User')
      settingOps.set('user_phone', '+1234567890')

      expect(settingOps.get('user_display_name')).toBe('Test User')
      expect(settingOps.get('user_phone')).toBe('+1234567890')
    })
  })

  describe('Message Limit Parameter', () => {
    it('should respect limit parameter when getting messages', () => {
      chatOps.insert('limitchat@s.whatsapp.net', 'dm', undefined, 'Limit Chat')
      const chat = chatOps.getByWhatsappJid('limitchat@s.whatsapp.net') as any

      const now = Date.now()
      // Insert 10 messages
      for (let i = 0; i < 10; i++) {
        messageOps.insert(chat.id, `limit-msg-${i}`, now - (10 - i) * 1000, 'sender@s.whatsapp.net', JSON.stringify({
          type: 'message',
          messageId: `limit-msg-${i}`,
          timestamp: new Date(now - (10 - i) * 1000).toISOString(),
          text: `Message ${i}`
        }), false)
      }

      // Get with limit 5
      const limitedMessages = messageOps.getByChatId(chat.id, 5) as any[]
      expect(limitedMessages).toHaveLength(5)

      // Get all messages
      const allMessages = messageOps.getByChatId(chat.id, 100) as any[]
      expect(allMessages).toHaveLength(10)
    })
  })

  describe('Chat Search Logic', () => {
    it('should match chats by name substring', () => {
      chatOps.insert('alice1@s.whatsapp.net', 'dm', undefined, 'Alice Wonderland')
      chatOps.insert('bob1@s.whatsapp.net', 'dm', undefined, 'Bob Builder')
      chatOps.insert('alice2@s.whatsapp.net', 'dm', undefined, 'Alice Cooper')

      const allChats = chatOps.getAll() as any[]
      const query = 'alice'
      const results = allChats.filter((chat: any) => {
        if (!chat.enabled) return false
        const name = chat.name?.toLowerCase() || ''
        return name.includes(query.toLowerCase())
      })

      expect(results).toHaveLength(2)
      expect(results.every((c: any) => c.name.toLowerCase().includes('alice'))).toBe(true)
    })

    it('should match chats by JID/phone substring', () => {
      chatOps.insert('1234567890@s.whatsapp.net', 'dm', undefined, 'Phone User')
      chatOps.insert('9876543210@s.whatsapp.net', 'dm', undefined, 'Another User')

      const allChats = chatOps.getAll() as any[]
      const query = '12345'
      const results = allChats.filter((chat: any) => {
        if (!chat.enabled) return false
        const jid = chat.whatsapp_jid?.toLowerCase() || ''
        return jid.includes(query.toLowerCase())
      })

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Phone User')
    })

    it('should return empty array when no chats match', () => {
      chatOps.insert('test@s.whatsapp.net', 'dm', undefined, 'Test Chat')

      const allChats = chatOps.getAll() as any[]
      const query = 'nonexistent'
      const results = allChats.filter((chat: any) => {
        if (!chat.enabled) return false
        const name = chat.name?.toLowerCase() || ''
        const jid = chat.whatsapp_jid?.toLowerCase() || ''
        return name.includes(query.toLowerCase()) || jid.includes(query.toLowerCase())
      })

      expect(results).toHaveLength(0)
    })
  })

  describe('Port Conflict Handling', () => {
    it('should throw when port is in use', async () => {
      // Start a simple HTTP server on the test port
      const blockingServer = http.createServer()
      await new Promise<void>((resolve) => {
        blockingServer.listen(testPort, '127.0.0.1', resolve)
      })

      try {
        await expect(startMcpServer(testPort)).rejects.toThrow(`Port ${testPort} is already in use`)
      } finally {
        blockingServer.close()
      }
    })
  })

  describe('Health Endpoint Details', () => {
    it('should include whatsapp state in health response', async () => {
      await startMcpServer(testPort)

      const response = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/health',
        method: 'GET'
      })

      const json = JSON.parse(response.body)
      expect(json).toHaveProperty('status', 'ok')
      expect(json).toHaveProperty('whatsapp')
    })
  })
})

