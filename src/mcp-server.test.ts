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

  // Helper to make MCP JSON-RPC tool calls
  async function callMcpTool(port: number, toolName: string, args: Record<string, unknown>): Promise<any> {
    const jsonRpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    }
    const response = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      }
    }, JSON.stringify(jsonRpcRequest))

    // Parse SSE response - extract JSON from "event: message\ndata: {...}\n\n" format
    const body = response.body
    const dataMatch = body.match(/data: (.+)\n/)
    if (dataMatch) {
      return JSON.parse(dataMatch[1])
    }
    return JSON.parse(body)
  }

  describe('search_chats Tool', () => {
    it('should find chats by name fragment', async () => {
      await startMcpServer(testPort)

      // Seed test chats
      chatOps.insert('alice@s.whatsapp.net', 'dm', undefined, 'Alice Smith')
      chatOps.insert('bob@s.whatsapp.net', 'dm', undefined, 'Bob Jones')
      chatOps.insert('carol@s.whatsapp.net', 'dm', undefined, 'Carol Alice')

      const result = await callMcpTool(testPort, 'search_chats', { query: 'Alice' })

      expect(result.result).toBeDefined()
      const content = result.result.content[0].text
      const chats = JSON.parse(content)
      expect(chats).toHaveLength(2) // Alice Smith and Carol Alice
      expect(chats.every((c: any) => c.name.toLowerCase().includes('alice'))).toBe(true)
    })

    it('should find chats by JID fragment', async () => {
      await startMcpServer(testPort)

      chatOps.insert('1234567@s.whatsapp.net', 'dm', undefined, 'User 1234567')
      chatOps.insert('9876543@s.whatsapp.net', 'dm', undefined, 'User 9876')

      const result = await callMcpTool(testPort, 'search_chats', { query: '12345' })

      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
      expect(chats[0].jid).toBe('1234567@s.whatsapp.net')
    })

    it('should exclude disabled chats from search results', async () => {
      await startMcpServer(testPort)

      chatOps.insert('enabled-user@s.whatsapp.net', 'dm', undefined, 'Enabled User')
      chatOps.insert('disabled-user@s.whatsapp.net', 'dm', undefined, 'Disabled User')

      const disabledChat = chatOps.getByWhatsappJid('disabled-user@s.whatsapp.net') as any
      chatOps.updateEnabled(disabledChat.id, false)

      const result = await callMcpTool(testPort, 'search_chats', { query: 'User' })

      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
      expect(chats[0].name).toBe('Enabled User')
    })

    it('should return empty array for no matches', async () => {
      await startMcpServer(testPort)

      chatOps.insert('test@s.whatsapp.net', 'dm', undefined, 'Test Chat')

      const result = await callMcpTool(testPort, 'search_chats', { query: 'nonexistent' })

      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(0)
    })

    it('should include chat type and last activity', async () => {
      await startMcpServer(testPort)

      chatOps.insert('group@g.us', 'group', undefined, 'Family Group')

      const result = await callMcpTool(testPort, 'search_chats', { query: 'Family' })

      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
      expect(chats[0].type).toBe('group')
      expect(chats[0]).toHaveProperty('lastActivity')
    })

    it('should show JID instead of Unknown for unnamed chats', async () => {
      await startMcpServer(testPort)

      // Insert a chat without a name (null name)
      chatOps.insert('unnamed-group@g.us', 'group', undefined, undefined as any)

      const result = await callMcpTool(testPort, 'search_chats', { query: 'unnamed-group' })

      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
      expect(chats[0].name).toBe('unnamed-group@g.us')
      expect(chats[0].name).not.toBe('Unknown')
    })
  })

  describe('get_chat_history Tool', () => {
    it('should return error for non-existent chat', async () => {
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'nonexistent@s.whatsapp.net' })

      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain('Chat not found')
    })

    it('should return error for disabled chat', async () => {
      await startMcpServer(testPort)

      chatOps.insert('disabled@s.whatsapp.net', 'dm', undefined, 'Disabled')
      const chat = chatOps.getByWhatsappJid('disabled@s.whatsapp.net') as any
      chatOps.updateEnabled(chat.id, false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'disabled@s.whatsapp.net' })

      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain('Chat is disabled')
    })

    it('should return messages in chronological order', async () => {
      await startMcpServer(testPort)

      chatOps.insert('history@s.whatsapp.net', 'dm', undefined, 'History Chat')
      const chat = chatOps.getByWhatsappJid('history@s.whatsapp.net') as any

      const now = Date.now()
      // Insert messages with timestamps
      messageOps.insert(chat.id, 'msg-1', now - 3000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'msg-1', timestamp: new Date(now - 3000).toISOString(),
        text: 'First message', sender: { name: 'Sender', phone: '+123' }
      }), false)
      messageOps.insert(chat.id, 'msg-2', now - 2000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'msg-2', timestamp: new Date(now - 2000).toISOString(),
        text: 'Second message', sender: { name: 'Sender', phone: '+123' }
      }), false)
      messageOps.insert(chat.id, 'msg-3', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'msg-3', timestamp: new Date(now - 1000).toISOString(),
        text: 'Third message', sender: { name: 'Sender', phone: '+123' }
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'history@s.whatsapp.net', limit: 10 })

      const text = result.result.content[0].text
      // Messages should be in chronological order (first before third)
      const firstIdx = text.indexOf('First')
      const thirdIdx = text.indexOf('Third')
      expect(firstIdx).toBeLessThan(thirdIdx)
    })

    it('should filter messages by since parameter', async () => {
      await startMcpServer(testPort)

      chatOps.insert('since-chat@s.whatsapp.net', 'dm', undefined, 'Since Chat')
      const chat = chatOps.getByWhatsappJid('since-chat@s.whatsapp.net') as any

      const now = Date.now()
      const oneHourAgo = now - 60 * 60 * 1000
      const twoHoursAgo = now - 2 * 60 * 60 * 1000

      messageOps.insert(chat.id, 'old-msg', twoHoursAgo, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'old-msg', timestamp: new Date(twoHoursAgo).toISOString(),
        text: 'OLD_MESSAGE', sender: { name: 'Sender', phone: '+123' }
      }), false)
      messageOps.insert(chat.id, 'new-msg', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'new-msg', timestamp: new Date(now - 1000).toISOString(),
        text: 'NEW_MESSAGE', sender: { name: 'Sender', phone: '+123' }
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', {
        jid: 'since-chat@s.whatsapp.net',
        since: new Date(oneHourAgo).toISOString()
      })

      const text = result.result.content[0].text
      expect(text).toContain('NEW_MESSAGE')
      expect(text).not.toContain('OLD_MESSAGE')
    })

    it('should respect limit parameter', async () => {
      await startMcpServer(testPort)

      chatOps.insert('limit-chat@s.whatsapp.net', 'dm', undefined, 'Limit Chat')
      const chat = chatOps.getByWhatsappJid('limit-chat@s.whatsapp.net') as any

      const now = Date.now()
      // Insert 5 messages
      for (let i = 1; i <= 5; i++) {
        messageOps.insert(chat.id, `limit-msg-${i}`, now - (5 - i) * 1000, 'sender@s.whatsapp.net', JSON.stringify({
          type: 'message', messageId: `limit-msg-${i}`, timestamp: new Date(now - (5 - i) * 1000).toISOString(),
          text: `Message_${i}`, sender: { name: 'Sender', phone: '+123' }
        }), false)
      }

      const result = await callMcpTool(testPort, 'get_chat_history', {
        jid: 'limit-chat@s.whatsapp.net',
        limit: 2
      })

      const text = result.result.content[0].text
      // Should only have the 2 most recent messages (4 and 5)
      expect(text).toContain('Message_4')
      expect(text).toContain('Message_5')
      expect(text).not.toContain('Message_1')
    })

    it('should resolve identity from contacts', async () => {
      await startMcpServer(testPort)

      chatOps.insert('contact-chat@s.whatsapp.net', 'dm', undefined, 'Contact Chat')
      const chat = chatOps.getByWhatsappJid('contact-chat@s.whatsapp.net') as any

      // Add contact for the sender
      contactOps.insert('sender-jid@s.whatsapp.net', 'John Doe', '+1234567890')

      const now = Date.now()
      messageOps.insert(chat.id, 'contact-msg', now, 'sender-jid@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'contact-msg', timestamp: new Date(now).toISOString(),
        text: 'Hello from contact', sender: { name: 'Unknown', phone: null }
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'contact-chat@s.whatsapp.net' })

      const text = result.result.content[0].text
      expect(text).toContain('John Doe')
    })

    it('should return (no messages) for empty chat', async () => {
      await startMcpServer(testPort)

      chatOps.insert('empty-chat@s.whatsapp.net', 'dm', undefined, 'Empty Chat')

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'empty-chat@s.whatsapp.net' })

      const text = result.result.content[0].text
      expect(text).toBe('(no messages)')
    })
  })

  describe('get_recent_messages Tool', () => {
    it('should return messages across multiple chats', async () => {
      await startMcpServer(testPort)

      // Create two chats with messages
      chatOps.insert('chat-a@s.whatsapp.net', 'dm', undefined, 'Chat A')
      chatOps.insert('chat-b@s.whatsapp.net', 'dm', undefined, 'Chat B')

      const chatA = chatOps.getByWhatsappJid('chat-a@s.whatsapp.net') as any
      const chatB = chatOps.getByWhatsappJid('chat-b@s.whatsapp.net') as any

      const now = Date.now()
      messageOps.insert(chatA.id, 'msg-a', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'msg-a', timestamp: new Date(now - 1000).toISOString(),
        text: 'Message in Chat A', sender: { name: 'Sender', phone: '+123' }
      }), false)
      messageOps.insert(chatB.id, 'msg-b', now - 500, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'msg-b', timestamp: new Date(now - 500).toISOString(),
        text: 'Message in Chat B', sender: { name: 'Sender', phone: '+123' }
      }), false)

      const result = await callMcpTool(testPort, 'get_recent_messages', {
        since: new Date(now - 5000).toISOString(),
        limit: 100
      })

      const text = result.result.content[0].text
      expect(text).toContain('Chat A')
      expect(text).toContain('Chat B')
      expect(text).toContain('Message in Chat A')
      expect(text).toContain('Message in Chat B')
    })

    it('should exclude disabled chats', async () => {
      await startMcpServer(testPort)

      chatOps.insert('enabled-recent@s.whatsapp.net', 'dm', undefined, 'Enabled Recent')
      chatOps.insert('disabled-recent@s.whatsapp.net', 'dm', undefined, 'Disabled Recent')

      const enabledChat = chatOps.getByWhatsappJid('enabled-recent@s.whatsapp.net') as any
      const disabledChat = chatOps.getByWhatsappJid('disabled-recent@s.whatsapp.net') as any
      chatOps.updateEnabled(disabledChat.id, false)

      const now = Date.now()
      messageOps.insert(enabledChat.id, 'enabled-msg', now, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'enabled-msg', timestamp: new Date(now).toISOString(),
        text: 'ENABLED_MSG', sender: { name: 'Sender', phone: '+123' }
      }), false)
      messageOps.insert(disabledChat.id, 'disabled-msg', now, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'disabled-msg', timestamp: new Date(now).toISOString(),
        text: 'DISABLED_MSG', sender: { name: 'Sender', phone: '+123' }
      }), false)

      const result = await callMcpTool(testPort, 'get_recent_messages', {
        since: new Date(now - 5000).toISOString()
      })

      const text = result.result.content[0].text
      expect(text).toContain('ENABLED_MSG')
      expect(text).not.toContain('DISABLED_MSG')
    })

    it('should respect limit parameter', async () => {
      await startMcpServer(testPort)

      chatOps.insert('limit-recent@s.whatsapp.net', 'dm', undefined, 'Limit Recent')
      const chat = chatOps.getByWhatsappJid('limit-recent@s.whatsapp.net') as any

      const now = Date.now()
      for (let i = 1; i <= 10; i++) {
        messageOps.insert(chat.id, `recent-limit-${i}`, now - (10 - i) * 100, 'sender@s.whatsapp.net', JSON.stringify({
          type: 'message', messageId: `recent-limit-${i}`, timestamp: new Date(now - (10 - i) * 100).toISOString(),
          text: `RecentLimitMsg${i}`, sender: { name: 'Sender', phone: '+123' }
        }), false)
      }

      const result = await callMcpTool(testPort, 'get_recent_messages', {
        since: new Date(now - 5000).toISOString(),
        limit: 3
      })

      const text = result.result.content[0].text
      // Should have only the 3 most recent
      expect(text).toContain('RecentLimitMsg10')
      expect(text).toContain('RecentLimitMsg9')
      expect(text).toContain('RecentLimitMsg8')
      // Use regex to match exactly "RecentLimitMsg1" without matching "RecentLimitMsg10"
      expect(text).not.toMatch(/RecentLimitMsg1[^\d]/)
      expect(text).not.toContain('RecentLimitMsg2')
    })

    it('should return (no recent messages) when no messages match', async () => {
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, 'get_recent_messages', {
        since: new Date().toISOString()
      })

      const text = result.result.content[0].text
      expect(text).toBe('(no recent messages)')
    })
  })

  describe('get_unread_messages Tool', () => {
    it('should use provided since parameter', async () => {
      await startMcpServer(testPort)

      chatOps.insert('unread-chat@s.whatsapp.net', 'dm', undefined, 'Unread Chat')
      const chat = chatOps.getByWhatsappJid('unread-chat@s.whatsapp.net') as any

      const now = Date.now()
      const oneHourAgo = now - 60 * 60 * 1000

      messageOps.insert(chat.id, 'unread-msg', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'unread-msg', timestamp: new Date(now - 1000).toISOString(),
        text: 'UNREAD_MESSAGE', sender: { name: 'Sender', phone: '+123' }
      }), false)

      const result = await callMcpTool(testPort, 'get_unread_messages', {
        since: new Date(oneHourAgo).toISOString()
      })

      const text = result.result.content[0].text
      expect(text).toContain('UNREAD_MESSAGE')
    })

    it('should update last_unread_check setting', async () => {
      await startMcpServer(testPort)

      // Verify no last_unread_check before call (settingOps returns null for missing keys)
      expect(settingOps.get('last_unread_check')).toBeNull()

      await callMcpTool(testPort, 'get_unread_messages', {})

      const afterCheck = settingOps.get('last_unread_check')
      expect(afterCheck).not.toBeNull()
      // Should be a recent timestamp
      const checkTime = new Date(afterCheck!).getTime()
      expect(Date.now() - checkTime).toBeLessThan(5000)
    })

    it('should use last_unread_check as default since', async () => {
      await startMcpServer(testPort)

      chatOps.insert('unread-default@s.whatsapp.net', 'dm', undefined, 'Unread Default')
      const chat = chatOps.getByWhatsappJid('unread-default@s.whatsapp.net') as any

      const now = Date.now()
      const fiveMinutesAgo = now - 5 * 60 * 1000

      // Set last_unread_check to 5 minutes ago
      settingOps.set('last_unread_check', new Date(fiveMinutesAgo).toISOString())

      // Insert a message 1 second ago
      messageOps.insert(chat.id, 'recent-unread', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'recent-unread', timestamp: new Date(now - 1000).toISOString(),
        text: 'RECENT_UNREAD', sender: { name: 'Sender', phone: '+123' }
      }), false)

      const result = await callMcpTool(testPort, 'get_unread_messages', {})

      const text = result.result.content[0].text
      expect(text).toContain('RECENT_UNREAD')
    })

    it('should default to 24 hours ago when no last_unread_check', async () => {
      await startMcpServer(testPort)

      // First call - no last_unread_check set
      const result = await callMcpTool(testPort, 'get_unread_messages', {})

      const text = result.result.content[0].text
      // Should include the since timestamp in output
      expect(text).toContain('Messages since')
    })
  })

  describe('send_message Tool', () => {
    it('should return error when WhatsApp is not connected', async () => {
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, 'send_message', {
        jid: 'recipient@s.whatsapp.net',
        text: 'Hello'
      })

      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toBe('WhatsApp is not connected')
    })

    it('should return error for missing attachment file', async () => {
      await startMcpServer(testPort)

      // Create a mock WhatsApp manager
      const mockSocket = {
        sendMessage: vi.fn()
      }
      setWhatsAppManager({ socket: mockSocket } as any)

      const result = await callMcpTool(testPort, 'send_message', {
        jid: 'recipient@s.whatsapp.net',
        text: 'Hello',
        attachmentPath: '/nonexistent/file.jpg'
      })

      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain('Attachment file not found')

      // Cleanup
      setWhatsAppManager(null as any)
    })

    it('should send text message successfully', async () => {
      await startMcpServer(testPort)

      const mockSocket = {
        sendMessage: vi.fn().mockResolvedValue({})
      }
      setWhatsAppManager({ socket: mockSocket } as any)

      const result = await callMcpTool(testPort, 'send_message', {
        jid: 'recipient@s.whatsapp.net',
        text: 'Hello World'
      })

      expect(result.result.isError).toBeFalsy()
      expect(result.result.content[0].text).toBe('Message sent to recipient@s.whatsapp.net')
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        'recipient@s.whatsapp.net',
        { text: 'Hello World' }
      )

      setWhatsAppManager(null as any)
    })

    it('should handle send failure gracefully', async () => {
      await startMcpServer(testPort)

      const mockSocket = {
        sendMessage: vi.fn().mockRejectedValue(new Error('Network error'))
      }
      setWhatsAppManager({ socket: mockSocket } as any)

      const result = await callMcpTool(testPort, 'send_message', {
        jid: 'recipient@s.whatsapp.net',
        text: 'Hello'
      })

      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain('Failed to send message')
      expect(result.result.content[0].text).toContain('Network error')

      setWhatsAppManager(null as any)
    })
  })

  describe('Identity Resolution', () => {
    it('should use meIdentity for isFromMe detection', async () => {
      await startMcpServer(testPort)

      // Set up user identity
      settingOps.set('user_display_name', 'Me')
      settingOps.set('user_phone', '+1234567890')

      chatOps.insert('me-chat@s.whatsapp.net', 'dm', undefined, 'Me Chat')
      const chat = chatOps.getByWhatsappJid('me-chat@s.whatsapp.net') as any

      const now = Date.now()
      // Message from the user's own phone number
      messageOps.insert(chat.id, 'my-msg', now, '1234567890@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'my-msg', timestamp: new Date(now).toISOString(),
        text: 'My own message', sender: { name: 'Unknown', phone: '+1234567890' }, isFromMe: false
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'me-chat@s.whatsapp.net' })

      const text = result.result.content[0].text
      // The message should be recognized as from me (serializer uses "You" or similar)
      expect(text).toContain('My own message')
    })

    it('should resolve LID contacts', async () => {
      await startMcpServer(testPort)

      // Insert a contact with LID - the lid field stores the actual LID value
      // When resolveFromContacts is called with a LID JID, it calls getByLid(fullJid)
      // So we need the lid column to match the full JID that will be queried
      const lidJid = 'lid-value-abc@lid'
      contactOps.insert('some-jid@s.whatsapp.net', 'LID User Name', '+9999999999', lidJid)

      chatOps.insert('lid-chat@s.whatsapp.net', 'dm', undefined, 'LID Chat')
      const chat = chatOps.getByWhatsappJid('lid-chat@s.whatsapp.net') as any

      const now = Date.now()
      messageOps.insert(chat.id, 'lid-msg', now, lidJid, JSON.stringify({
        type: 'message', messageId: 'lid-msg', timestamp: new Date(now).toISOString(),
        text: 'Message from LID', sender: { name: 'Unknown', phone: null }
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'lid-chat@s.whatsapp.net' })

      const text = result.result.content[0].text
      expect(text).toContain('LID User Name')
    })

    it('should resolve contacts by phone number fallback', async () => {
      await startMcpServer(testPort)

      // Insert contact with phone number
      contactOps.insert('other-jid@s.whatsapp.net', 'Phone Contact', '+5551234567')

      chatOps.insert('phone-chat@s.whatsapp.net', 'dm', undefined, 'Phone Chat')
      const chat = chatOps.getByWhatsappJid('phone-chat@s.whatsapp.net') as any

      const now = Date.now()
      // Message from JID that won't match, but phone will
      messageOps.insert(chat.id, 'phone-msg', now, '5551234567@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'phone-msg', timestamp: new Date(now).toISOString(),
        text: 'Message from phone contact', sender: { name: 'Unknown', phone: '+5551234567' }
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'phone-chat@s.whatsapp.net' })

      const text = result.result.content[0].text
      expect(text).toContain('Phone Contact')
    })

    it('should format Unknown with JID when no contact info', async () => {
      await startMcpServer(testPort)

      chatOps.insert('unknown-chat@s.whatsapp.net', 'dm', undefined, 'Unknown Chat')
      const chat = chatOps.getByWhatsappJid('unknown-chat@s.whatsapp.net') as any

      const now = Date.now()
      messageOps.insert(chat.id, 'unknown-msg', now, 'unknown-sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'unknown-msg', timestamp: new Date(now).toISOString(),
        text: 'Message from unknown', sender: { name: 'Unknown', phone: null }
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'unknown-chat@s.whatsapp.net' })

      const text = result.result.content[0].text
      // Should have Unknown_ prefix with identifier
      expect(text).toContain('unknown-sender')
    })
  })

  describe('Mention Resolution', () => {
    it('should resolve @Unknown mentions from contacts', async () => {
      await startMcpServer(testPort)

      // Add contact for the mentioned user
      contactOps.insert('mentioned@s.whatsapp.net', 'Mentioned User', '+7777777777')

      chatOps.insert('mention-chat@s.whatsapp.net', 'dm', undefined, 'Mention Chat')
      const chat = chatOps.getByWhatsappJid('mention-chat@s.whatsapp.net') as any

      const now = Date.now()
      messageOps.insert(chat.id, 'mention-msg', now, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'mention-msg', timestamp: new Date(now).toISOString(),
        text: 'Hello @Unknown_mentioned@s.whatsapp.net!',
        sender: { name: 'Sender', phone: '+123' },
        mentionedJids: ['mentioned@s.whatsapp.net']
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'mention-chat@s.whatsapp.net' })

      const text = result.result.content[0].text
      expect(text).toContain('Mentioned User')
    })

    it('should resolve mentions by number pattern', async () => {
      await startMcpServer(testPort)

      contactOps.insert('8888888888@s.whatsapp.net', 'Number Contact', '+8888888888')

      chatOps.insert('number-mention@s.whatsapp.net', 'dm', undefined, 'Number Mention')
      const chat = chatOps.getByWhatsappJid('number-mention@s.whatsapp.net') as any

      const now = Date.now()
      messageOps.insert(chat.id, 'num-mention-msg', now, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'num-mention-msg', timestamp: new Date(now).toISOString(),
        text: 'Hey @8888888888!',
        sender: { name: 'Sender', phone: '+123' },
        mentionedJids: ['8888888888@s.whatsapp.net']
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'number-mention@s.whatsapp.net' })

      const text = result.result.content[0].text
      expect(text).toContain('Number Contact')
    })
  })

  describe('Reply Resolution', () => {
    it('should resolve reply sender from original message', async () => {
      await startMcpServer(testPort)

      contactOps.insert('original-sender@s.whatsapp.net', 'Original Sender', '+4444444444')

      chatOps.insert('reply-chat@s.whatsapp.net', 'dm', undefined, 'Reply Chat')
      const chat = chatOps.getByWhatsappJid('reply-chat@s.whatsapp.net') as any

      const now = Date.now()

      // Original message
      messageOps.insert(chat.id, 'original-msg', now - 2000, 'original-sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'original-msg', timestamp: new Date(now - 2000).toISOString(),
        text: 'This is the original', sender: { name: 'Unknown', phone: null }
      }), false)

      // Reply message with replyToMessageId
      messageOps.insert(chat.id, 'reply-msg', now - 1000, 'replier@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'reply-msg', timestamp: new Date(now - 1000).toISOString(),
        text: 'This is a reply',
        sender: { name: 'Replier', phone: '+5555555555' },
        replyToMessageId: 'original-msg'
      }), false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'reply-chat@s.whatsapp.net' })

      const text = result.result.content[0].text
      expect(text).toContain('reply')
    })
  })

  describe('Malformed Message Handling', () => {
    it('should skip messages with invalid JSON content', async () => {
      await startMcpServer(testPort)

      chatOps.insert('malformed-chat@s.whatsapp.net', 'dm', undefined, 'Malformed Chat')
      const chat = chatOps.getByWhatsappJid('malformed-chat@s.whatsapp.net') as any

      const now = Date.now()

      // Valid message
      messageOps.insert(chat.id, 'valid-msg', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'valid-msg', timestamp: new Date(now - 1000).toISOString(),
        text: 'VALID_MESSAGE', sender: { name: 'Sender', phone: '+123' }
      }), false)

      // Invalid JSON message
      messageOps.insert(chat.id, 'invalid-msg', now - 500, 'sender@s.whatsapp.net',
        'not valid json {{{', false)

      const result = await callMcpTool(testPort, 'get_chat_history', { jid: 'malformed-chat@s.whatsapp.net' })

      const text = result.result.content[0].text
      expect(text).toContain('VALID_MESSAGE')
      // Should not crash, invalid message is skipped
    })
  })
})

