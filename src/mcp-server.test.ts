import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import http from 'http'

// Create a unique temp directory - hoisted so the electron mock can see it.
const testDir = vi.hoisted(() => {
  const p = require('path')
  const os = require('os')
  return p.join(os.tmpdir(), 'mcp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
})

// Track random port for test isolation
let testPort = vi.hoisted(() => 50000 + Math.floor(Math.random() * 10000))

vi.mock('electron', () => ({
  app: { getPath: () => testDir }
}))

// Imports happen after the mock is registered above.
import Settings from 'electron-settings'
import { initializeDatabase, closeAllDatabases, chatOps, messageOps, contactOps, settingOps } from './database'
import { addAccount, setMcpEnabled } from './accounts'
import { setManager, listManagers } from './whatsapp-manager'
import {
  startMcpServer,
  stopMcpServer,
  isMcpServerRunning,
  getMcpPort,
  setMcpPort,
  refreshAccount
} from './mcp-server'

const DEFAULT = 'default'

function makeRequest(options: http.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function callMcpTool(port: number, mcpPath: string, toolName: string, args: Record<string, unknown>): Promise<any> {
  const jsonRpcRequest = {
    jsonrpc: '2.0',
    id: Date.now() + Math.floor(Math.random() * 1000),
    method: 'tools/call',
    params: { name: toolName, arguments: args }
  }
  const response = await makeRequest({
    hostname: '127.0.0.1',
    port,
    path: mcpPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }
  }, JSON.stringify(jsonRpcRequest))

  const dataMatch = response.body.match(/data: (.+)\n/)
  if (dataMatch) return JSON.parse(dataMatch[1])
  return JSON.parse(response.body)
}

/**
 * Reset FS + settings + in-memory state between tests.
 */
function resetWorld(): void {
  closeAllDatabases()
  listManagers().clear()
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true })
  }
  fs.mkdirSync(testDir, { recursive: true })
  try { Settings.unsetSync() } catch { /* ignore */ }
  testPort = 50000 + Math.floor(Math.random() * 10000)
}

/**
 * Register an account and ensure its per-account DB is initialized.
 */
function makeAccount(slug: string): void {
  addAccount(slug)
  initializeDatabase(slug)
  refreshAccount(slug)
}

describe('MCP Server', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true })
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
  })

  afterAll(async () => {
    await stopMcpServer().catch(() => { /* ignore */ })
    closeAllDatabases()
    try { Settings.reset() } catch { /* ignore */ }
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    resetWorld()
  })

  afterEach(async () => {
    await stopMcpServer().catch(() => { /* ignore */ })
  })

  describe('Port Settings', () => {
    it('returns default port 13491 when unset', () => {
      expect(getMcpPort()).toBe(13491)
    })

    it('round-trips port through global-settings', () => {
      setMcpPort(8080)
      expect(getMcpPort()).toBe(8080)
      setMcpPort(3000)
      expect(getMcpPort()).toBe(3000)
    })
  })

  describe('Server Lifecycle', () => {
    it('starts and reports running', async () => {
      expect(isMcpServerRunning()).toBe(false)
      await startMcpServer(testPort)
      expect(isMcpServerRunning()).toBe(true)
    })

    it('stops and reports not running', async () => {
      await startMcpServer(testPort)
      await stopMcpServer()
      expect(isMcpServerRunning()).toBe(false)
    })

    it('throws when starting a server that is already running', async () => {
      await startMcpServer(testPort)
      await expect(startMcpServer(testPort + 1)).rejects.toThrow('MCP server is already running')
    })

    it('stopMcpServer is a no-op when nothing is running', async () => {
      await stopMcpServer()
      expect(isMcpServerRunning()).toBe(false)
    })
  })

  describe('Health Endpoint', () => {
    it('returns status ok', async () => {
      makeAccount(DEFAULT)
      await startMcpServer(testPort)

      const response = await makeRequest({
        hostname: '127.0.0.1', port: testPort, path: '/health', method: 'GET'
      })

      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' })
    })
  })

  describe('HTTP Routing', () => {
    it('returns 404 for non-/mcp endpoints', async () => {
      makeAccount(DEFAULT)
      await startMcpServer(testPort)
      const response = await makeRequest({
        hostname: '127.0.0.1', port: testPort, path: '/unknown', method: 'GET'
      })
      expect(response.status).toBe(404)
    })

    it('returns 404 for GET /mcp', async () => {
      makeAccount(DEFAULT)
      await startMcpServer(testPort)
      const response = await makeRequest({
        hostname: '127.0.0.1', port: testPort, path: '/mcp', method: 'GET'
      })
      expect(response.status).toBe(404)
    })

    it('returns 400 for invalid JSON on POST /mcp', async () => {
      makeAccount(DEFAULT)
      await startMcpServer(testPort)
      const response = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, 'not valid json')
      expect(response.status).toBe(400)
      expect(JSON.parse(response.body).error).toBe('Invalid JSON')
    })

    it('returns 404 when no default account is configured', async () => {
      // No accounts added — hitting /mcp should fail route resolution.
      await startMcpServer(testPort)
      const response = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body).error).toMatch(/default account/i)
    })

    it('returns 404 for an unknown slug', async () => {
      makeAccount(DEFAULT)
      await startMcpServer(testPort)
      const response = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/mcp/ghost',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body).error).toMatch(/Unknown account: ghost/)
    })

    it('returns 503 when the account has mcpEnabled === false', async () => {
      makeAccount(DEFAULT)
      setMcpEnabled(DEFAULT, false)
      refreshAccount(DEFAULT)
      await startMcpServer(testPort)
      const response = await makeRequest({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      expect(response.status).toBe(503)
      expect(JSON.parse(response.body).error).toMatch(/disabled/i)
    })

    it('/mcp aliases the default account', async () => {
      makeAccount(DEFAULT)
      chatOps.insert(DEFAULT, 'alice@s.whatsapp.net', 'dm', undefined, 'Alice')
      await startMcpServer(testPort)
      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Alice' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
      expect(chats[0].name).toBe('Alice')
    })

    it('/mcp/<slug> routes to the matching account', async () => {
      makeAccount(DEFAULT)
      makeAccount('other')
      chatOps.insert('other', 'bob@s.whatsapp.net', 'dm', undefined, 'Bob')
      await startMcpServer(testPort)
      const result = await callMcpTool(testPort, '/mcp/other', 'search_chats', { query: 'Bob' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
      expect(chats[0].name).toBe('Bob')
    })

    it('/mcp/ and /mcp both alias the default account', async () => {
      makeAccount(DEFAULT)
      chatOps.insert(DEFAULT, 'trailing@s.whatsapp.net', 'dm', undefined, 'Trailing')
      await startMcpServer(testPort)
      const result = await callMcpTool(testPort, '/mcp/', 'search_chats', { query: 'Trailing' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
    })
  })

  describe('Account Isolation', () => {
    it('keeps chat data separate between accounts', async () => {
      makeAccount(DEFAULT)
      makeAccount('work')
      chatOps.insert(DEFAULT, 'home@s.whatsapp.net', 'dm', undefined, 'Home Chat')
      chatOps.insert('work', 'work@s.whatsapp.net', 'dm', undefined, 'Work Chat')
      await startMcpServer(testPort)

      const defaultResult = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Chat' })
      const defaultChats = JSON.parse(defaultResult.result.content[0].text)
      expect(defaultChats).toHaveLength(1)
      expect(defaultChats[0].name).toBe('Home Chat')

      const workResult = await callMcpTool(testPort, '/mcp/work', 'search_chats', { query: 'Chat' })
      const workChats = JSON.parse(workResult.result.content[0].text)
      expect(workChats).toHaveLength(1)
      expect(workChats[0].name).toBe('Work Chat')
    })

    it('dispatches send_message to the slug-specific manager', async () => {
      makeAccount(DEFAULT)
      makeAccount('work')

      const defaultSocket = { sendMessage: vi.fn().mockResolvedValue({}) }
      const workSocket = { sendMessage: vi.fn().mockResolvedValue({}) }
      setManager(DEFAULT, { socket: defaultSocket } as any)
      setManager('work', { socket: workSocket } as any)

      await startMcpServer(testPort)

      await callMcpTool(testPort, '/mcp', 'send_message', { jid: 'x@s.whatsapp.net', text: 'hi-default' })
      await callMcpTool(testPort, '/mcp/work', 'send_message', { jid: 'y@s.whatsapp.net', text: 'hi-work' })

      expect(defaultSocket.sendMessage).toHaveBeenCalledTimes(1)
      expect(defaultSocket.sendMessage).toHaveBeenCalledWith('x@s.whatsapp.net', { text: 'hi-default' })
      expect(workSocket.sendMessage).toHaveBeenCalledTimes(1)
      expect(workSocket.sendMessage).toHaveBeenCalledWith('y@s.whatsapp.net', { text: 'hi-work' })
    })
  })

  describe('Port Conflict Handling', () => {
    it('throws when port is already in use', async () => {
      const blocking = http.createServer()
      await new Promise<void>((resolve) => blocking.listen(testPort, '127.0.0.1', resolve))
      try {
        await expect(startMcpServer(testPort)).rejects.toThrow(`Port ${testPort} is already in use`)
      } finally {
        blocking.close()
      }
    })
  })

  describe('search_chats Tool', () => {
    beforeEach(() => {
      makeAccount(DEFAULT)
    })

    it('finds chats by name fragment', async () => {
      chatOps.insert(DEFAULT, 'alice@s.whatsapp.net', 'dm', undefined, 'Alice Smith')
      chatOps.insert(DEFAULT, 'bob@s.whatsapp.net', 'dm', undefined, 'Bob Jones')
      chatOps.insert(DEFAULT, 'carol@s.whatsapp.net', 'dm', undefined, 'Carol Alice')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Alice' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(2)
      expect(chats.every((c: any) => c.name.toLowerCase().includes('alice'))).toBe(true)
    })

    it('finds chats by JID fragment', async () => {
      chatOps.insert(DEFAULT, '1234567@s.whatsapp.net', 'dm', undefined, 'User 1234567')
      chatOps.insert(DEFAULT, '9876543@s.whatsapp.net', 'dm', undefined, 'User 9876')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: '12345' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
      expect(chats[0].jid).toBe('1234567@s.whatsapp.net')
    })

    it('excludes disabled chats', async () => {
      chatOps.insert(DEFAULT, 'enabled-user@s.whatsapp.net', 'dm', undefined, 'Enabled User')
      chatOps.insert(DEFAULT, 'disabled-user@s.whatsapp.net', 'dm', undefined, 'Disabled User')
      const disabled = chatOps.getByWhatsappJid(DEFAULT, 'disabled-user@s.whatsapp.net') as any
      chatOps.updateEnabled(DEFAULT, disabled.id, false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'User' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
      expect(chats[0].name).toBe('Enabled User')
    })

    it('returns empty array for no matches', async () => {
      chatOps.insert(DEFAULT, 'test@s.whatsapp.net', 'dm', undefined, 'Test Chat')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'nonexistent' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(0)
    })

    it('includes chat type and last activity', async () => {
      chatOps.insert(DEFAULT, 'group@g.us', 'group', undefined, 'Family Group')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Family' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats).toHaveLength(1)
      expect(chats[0].type).toBe('group')
      expect(chats[0]).toHaveProperty('lastActivity')
    })
  })

  describe('search_chats FTS fuzzy search', () => {
    beforeEach(() => {
      makeAccount(DEFAULT)
    })

    it('grouped-AND: chats matching all query words win over single-word matches', async () => {
      chatOps.insert(DEFAULT, 'family-staff@g.us', 'group', undefined, 'Family Staff')
      chatOps.insert(DEFAULT, 'pang-family@g.us', 'group', undefined, 'Pang Family')
      chatOps.insert(DEFAULT, 'household-staff@g.us', 'group', undefined, 'Household Staff')
      chatOps.insert(DEFAULT, 'noise1@g.us', 'group', undefined, 'Random Group')
      chatOps.insert(DEFAULT, 'noise2@g.us', 'group', undefined, 'Book Lovers')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'family staff' })
      const chats = JSON.parse(result.result.content[0].text)
      const names = chats.map((c: any) => c.name)
      expect(names[0]).toBe('Family Staff')
      const famStaff = chats.find((c: any) => c.name === 'Family Staff')
      expect(famStaff).toBeDefined()
      expect(famStaff.matchedVia).toBe('name')
      for (const other of chats.filter((c: any) => c.name !== 'Family Staff')) {
        expect(famStaff.rank).toBeLessThanOrEqual(other.rank)
      }
      expect(names).not.toContain('Random Group')
      expect(names).not.toContain('Book Lovers')
    })

    it('rank-gap filter prunes weak FTS hits when a strong match exists', async () => {
      chatOps.insert(DEFAULT, 'pang-staff@g.us', 'group', undefined, 'Pang Household Staff')
      chatOps.insert(DEFAULT, 'stanley@g.us', 'group', undefined, 'Stanley')
      chatOps.insert(DEFAULT, 'stanford@g.us', 'group', undefined, 'Stanford')
      chatOps.insert(DEFAULT, 'kevin@g.us', 'group', undefined, 'Kevin Bautista')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'staff' })
      const chats = JSON.parse(result.result.content[0].text)
      const names = chats.map((c: any) => c.name)
      expect(names).toContain('Pang Household Staff')
      expect(names).not.toContain('Stanley')
      expect(names).not.toContain('Stanford')
      expect(names).not.toContain('Kevin Bautista')
    })

    it('tolerates typos via trigram fuzzy matching', async () => {
      chatOps.insert(DEFAULT, 'family@g.us', 'group', undefined, 'Family')
      chatOps.insert(DEFAULT, 'familiar@g.us', 'group', undefined, 'Familiar Faces')
      chatOps.insert(DEFAULT, 'other@g.us', 'group', undefined, 'Soccer Club')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Familly' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats.length).toBeGreaterThan(0)
      expect(chats.map((c: any) => c.name)).toContain('Family')
      expect(chats.map((c: any) => c.name)).not.toContain('Soccer Club')
    })

    it('matches normalized phone numbers (digit-only ≥5 chars)', async () => {
      contactOps.insert(DEFAULT, 'dialed@s.whatsapp.net', 'Dialed Contact', '+1 (650) 223-4510')
      chatOps.insert(DEFAULT, 'dialed@s.whatsapp.net', 'dm', undefined, 'Old Name')
      contactOps.insert(DEFAULT, 'other@s.whatsapp.net', 'Other', '+1 (415) 555-1212')
      chatOps.insert(DEFAULT, 'other@s.whatsapp.net', 'dm', undefined, 'Other Chat')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: '6502234510' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats.length).toBe(1)
      expect(chats[0].jid).toBe('dialed@s.whatsapp.net')
      expect(chats[0].matchedVia).toBe('phone')
    })

    it('matches DM chats via contact name even when chat name is stale', async () => {
      contactOps.insert(DEFAULT, 'stale-dm@s.whatsapp.net', 'Zebra Longhorn', '+1234567000')
      // Chat name is a stale/null value; contact has the searchable name.
      chatOps.insert(DEFAULT, 'stale-dm@s.whatsapp.net', 'dm', undefined, null as any)
      chatOps.insert(DEFAULT, 'other-dm@s.whatsapp.net', 'dm', undefined, 'Somebody Else')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Zebra' })
      const chats = JSON.parse(result.result.content[0].text)
      const stale = chats.find((c: any) => c.jid === 'stale-dm@s.whatsapp.net')
      expect(stale).toBeDefined()
      expect(stale.matchedVia).toBe('contact')
    })

    it('ranks results with last_activity DESC as tiebreaker', async () => {
      chatOps.insert(DEFAULT, 'old-family@g.us', 'group', undefined, 'Family')
      chatOps.insert(DEFAULT, 'new-family@g.us', 'group', undefined, 'Family')
      const oldChat = chatOps.getByWhatsappJid(DEFAULT, 'old-family@g.us') as any
      const newChat = chatOps.getByWhatsappJid(DEFAULT, 'new-family@g.us') as any
      chatOps.updateLastActivity(DEFAULT, oldChat.id, '2020-01-01T00:00:00Z')
      chatOps.updateLastActivity(DEFAULT, newChat.id, '2025-01-01T00:00:00Z')
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Family' })
      const chats = JSON.parse(result.result.content[0].text)
      expect(chats.length).toBe(2)
      expect(chats[0].jid).toBe('new-family@g.us')
      expect(chats[1].jid).toBe('old-family@g.us')
    })

    it('excludes disabled chats from FTS and phone results', async () => {
      chatOps.insert(DEFAULT, 'enabled@g.us', 'group', undefined, 'Family Enabled')
      chatOps.insert(DEFAULT, 'disabled@g.us', 'group', undefined, 'Family Disabled')
      const disabled = chatOps.getByWhatsappJid(DEFAULT, 'disabled@g.us') as any
      chatOps.updateEnabled(DEFAULT, disabled.id, false)

      contactOps.insert(DEFAULT, 'disabled-dm@s.whatsapp.net', 'Disabled DM', '+9998887777')
      chatOps.insert(DEFAULT, 'disabled-dm@s.whatsapp.net', 'dm', undefined, 'Disabled DM Chat')
      const disabledDm = chatOps.getByWhatsappJid(DEFAULT, 'disabled-dm@s.whatsapp.net') as any
      chatOps.updateEnabled(DEFAULT, disabledDm.id, false)
      await startMcpServer(testPort)

      const nameRes = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Family' })).result.content[0].text)
      expect(nameRes).toHaveLength(1)
      expect(nameRes[0].name).toBe('Family Enabled')

      const phoneRes = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: '9998887777' })).result.content[0].text)
      expect(phoneRes).toHaveLength(0)
    })

    it('returns empty array for an empty query', async () => {
      chatOps.insert(DEFAULT, 'any@g.us', 'group', undefined, 'Any Chat')
      await startMcpServer(testPort)

      const emptyRes = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: '' })).result.content[0].text)
      expect(emptyRes).toHaveLength(0)

      const tinyRes = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'a' })).result.content[0].text)
      expect(tinyRes).toHaveLength(0)
    })

    it('respects the limit parameter and caps it at 100', async () => {
      for (let i = 0; i < 30; i++) {
        chatOps.insert(DEFAULT, `many-${i}@g.us`, 'group', undefined, `Family Chat ${i}`)
      }
      await startMcpServer(testPort)

      const defaulted = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Family' })).result.content[0].text)
      expect(defaulted).toHaveLength(20)

      const custom = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Family', limit: 5 })).result.content[0].text)
      expect(custom).toHaveLength(5)

      const huge = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Family', limit: 5000 })).result.content[0].text)
      expect(huge.length).toBeLessThanOrEqual(100)
    })

    it('updates FTS indexes when chat name or contact name changes', async () => {
      chatOps.insert(DEFAULT, 'renamable@g.us', 'group', undefined, 'Initial Name')
      await startMcpServer(testPort)

      const initialRes = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Initial' })).result.content[0].text)
      expect(initialRes).toHaveLength(1)

      const chat = chatOps.getByWhatsappJid(DEFAULT, 'renamable@g.us') as any
      chatOps.updateName(DEFAULT, chat.id, 'Renamed Topic')

      const afterOld = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Initial' })).result.content[0].text)
      expect(afterOld).toHaveLength(0)
      const afterNew = JSON.parse((await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Renamed' })).result.content[0].text)
      expect(afterNew).toHaveLength(1)
    })
  })

  describe('get_chat_history Tool', () => {
    beforeEach(() => {
      makeAccount(DEFAULT)
    })

    it('returns error for non-existent chat', async () => {
      await startMcpServer(testPort)
      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'nonexistent@s.whatsapp.net' })
      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain('Chat not found')
    })

    it('returns error for disabled chat', async () => {
      chatOps.insert(DEFAULT, 'disabled@s.whatsapp.net', 'dm', undefined, 'Disabled')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'disabled@s.whatsapp.net') as any
      chatOps.updateEnabled(DEFAULT, chat.id, false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'disabled@s.whatsapp.net' })
      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain('Chat is disabled')
    })

    it('returns messages in chronological order', async () => {
      chatOps.insert(DEFAULT, 'history@s.whatsapp.net', 'dm', undefined, 'History Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'history@s.whatsapp.net') as any
      const now = Date.now()
      for (const [id, off, txt] of [['msg-1', 3000, 'First message'], ['msg-2', 2000, 'Second message'], ['msg-3', 1000, 'Third message']] as const) {
        messageOps.insert(DEFAULT, chat.id, id, now - (off as number), 'sender@s.whatsapp.net', JSON.stringify({
          type: 'message', messageId: id, timestamp: new Date(now - (off as number)).toISOString(),
          text: txt, sender: { name: 'Sender', phone: '+123' }
        }), false)
      }
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'history@s.whatsapp.net', limit: 10 })
      const text = result.result.content[0].text
      expect(text.indexOf('First')).toBeLessThan(text.indexOf('Third'))
    })

    it('filters by since parameter', async () => {
      chatOps.insert(DEFAULT, 'since-chat@s.whatsapp.net', 'dm', undefined, 'Since Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'since-chat@s.whatsapp.net') as any
      const now = Date.now()
      const oneHourAgo = now - 60 * 60 * 1000
      const twoHoursAgo = now - 2 * 60 * 60 * 1000
      messageOps.insert(DEFAULT, chat.id, 'old-msg', twoHoursAgo, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'old-msg', timestamp: new Date(twoHoursAgo).toISOString(),
        text: 'OLD_MESSAGE', sender: { name: 'Sender', phone: '+123' }
      }), false)
      messageOps.insert(DEFAULT, chat.id, 'new-msg', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'new-msg', timestamp: new Date(now - 1000).toISOString(),
        text: 'NEW_MESSAGE', sender: { name: 'Sender', phone: '+123' }
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', {
        jid: 'since-chat@s.whatsapp.net',
        since: new Date(oneHourAgo).toISOString()
      })
      const text = result.result.content[0].text
      expect(text).toContain('NEW_MESSAGE')
      expect(text).not.toContain('OLD_MESSAGE')
    })

    it('respects the limit parameter', async () => {
      chatOps.insert(DEFAULT, 'limit-chat@s.whatsapp.net', 'dm', undefined, 'Limit Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'limit-chat@s.whatsapp.net') as any
      const now = Date.now()
      for (let i = 1; i <= 5; i++) {
        messageOps.insert(DEFAULT, chat.id, `limit-msg-${i}`, now - (5 - i) * 1000, 'sender@s.whatsapp.net', JSON.stringify({
          type: 'message', messageId: `limit-msg-${i}`, timestamp: new Date(now - (5 - i) * 1000).toISOString(),
          text: `Message_${i}`, sender: { name: 'Sender', phone: '+123' }
        }), false)
      }
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'limit-chat@s.whatsapp.net', limit: 2 })
      const text = result.result.content[0].text
      expect(text).toContain('Message_4')
      expect(text).toContain('Message_5')
      expect(text).not.toContain('Message_1')
    })

    it('returns (no messages) for an empty chat', async () => {
      chatOps.insert(DEFAULT, 'empty-chat@s.whatsapp.net', 'dm', undefined, 'Empty Chat')
      await startMcpServer(testPort)
      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'empty-chat@s.whatsapp.net' })
      expect(result.result.content[0].text).toBe('(no messages)')
    })
  })

  describe('get_recent_messages Tool', () => {
    beforeEach(() => { makeAccount(DEFAULT) })

    it('returns messages across multiple chats', async () => {
      chatOps.insert(DEFAULT, 'chat-a@s.whatsapp.net', 'dm', undefined, 'Chat A')
      chatOps.insert(DEFAULT, 'chat-b@s.whatsapp.net', 'dm', undefined, 'Chat B')
      const chatA = chatOps.getByWhatsappJid(DEFAULT, 'chat-a@s.whatsapp.net') as any
      const chatB = chatOps.getByWhatsappJid(DEFAULT, 'chat-b@s.whatsapp.net') as any
      const now = Date.now()
      messageOps.insert(DEFAULT, chatA.id, 'msg-a', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'msg-a', timestamp: new Date(now - 1000).toISOString(),
        text: 'Message in Chat A', sender: { name: 'Sender', phone: '+123' }
      }), false)
      messageOps.insert(DEFAULT, chatB.id, 'msg-b', now - 500, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'msg-b', timestamp: new Date(now - 500).toISOString(),
        text: 'Message in Chat B', sender: { name: 'Sender', phone: '+123' }
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_recent_messages', {
        since: new Date(now - 5000).toISOString(), limit: 100
      })
      const text = result.result.content[0].text
      expect(text).toContain('Chat A')
      expect(text).toContain('Chat B')
      expect(text).toContain('Message in Chat A')
      expect(text).toContain('Message in Chat B')
    })

    it('excludes disabled chats', async () => {
      chatOps.insert(DEFAULT, 'enabled-recent@s.whatsapp.net', 'dm', undefined, 'Enabled Recent')
      chatOps.insert(DEFAULT, 'disabled-recent@s.whatsapp.net', 'dm', undefined, 'Disabled Recent')
      const enabled = chatOps.getByWhatsappJid(DEFAULT, 'enabled-recent@s.whatsapp.net') as any
      const disabled = chatOps.getByWhatsappJid(DEFAULT, 'disabled-recent@s.whatsapp.net') as any
      chatOps.updateEnabled(DEFAULT, disabled.id, false)
      const now = Date.now()
      messageOps.insert(DEFAULT, enabled.id, 'enabled-msg', now, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'enabled-msg', timestamp: new Date(now).toISOString(),
        text: 'ENABLED_MSG', sender: { name: 'Sender', phone: '+123' }
      }), false)
      messageOps.insert(DEFAULT, disabled.id, 'disabled-msg', now, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'disabled-msg', timestamp: new Date(now).toISOString(),
        text: 'DISABLED_MSG', sender: { name: 'Sender', phone: '+123' }
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_recent_messages', { since: new Date(now - 5000).toISOString() })
      const text = result.result.content[0].text
      expect(text).toContain('ENABLED_MSG')
      expect(text).not.toContain('DISABLED_MSG')
    })

    it('respects the limit parameter', async () => {
      chatOps.insert(DEFAULT, 'limit-recent@s.whatsapp.net', 'dm', undefined, 'Limit Recent')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'limit-recent@s.whatsapp.net') as any
      const now = Date.now()
      for (let i = 1; i <= 10; i++) {
        messageOps.insert(DEFAULT, chat.id, `rlimit-${i}`, now - (10 - i) * 100, 'sender@s.whatsapp.net', JSON.stringify({
          type: 'message', messageId: `rlimit-${i}`, timestamp: new Date(now - (10 - i) * 100).toISOString(),
          text: `RecentLimitMsg${i}`, sender: { name: 'Sender', phone: '+123' }
        }), false)
      }
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_recent_messages', {
        since: new Date(now - 5000).toISOString(), limit: 3
      })
      const text = result.result.content[0].text
      expect(text).toContain('RecentLimitMsg10')
      expect(text).toContain('RecentLimitMsg9')
      expect(text).toContain('RecentLimitMsg8')
      expect(text).not.toMatch(/RecentLimitMsg1[^\d]/)
      expect(text).not.toContain('RecentLimitMsg2')
    })

    it('returns (no recent messages) when nothing matches', async () => {
      await startMcpServer(testPort)
      const result = await callMcpTool(testPort, '/mcp', 'get_recent_messages', { since: new Date().toISOString() })
      expect(result.result.content[0].text).toBe('(no recent messages)')
    })
  })

  describe('get_unread_messages Tool', () => {
    beforeEach(() => { makeAccount(DEFAULT) })

    it('respects the provided since parameter', async () => {
      chatOps.insert(DEFAULT, 'unread-chat@s.whatsapp.net', 'dm', undefined, 'Unread Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'unread-chat@s.whatsapp.net') as any
      const now = Date.now()
      const oneHourAgo = now - 60 * 60 * 1000
      messageOps.insert(DEFAULT, chat.id, 'unread-msg', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'unread-msg', timestamp: new Date(now - 1000).toISOString(),
        text: 'UNREAD_MESSAGE', sender: { name: 'Sender', phone: '+123' }
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_unread_messages', { since: new Date(oneHourAgo).toISOString() })
      expect(result.result.content[0].text).toContain('UNREAD_MESSAGE')
    })

    it('updates the last_unread_check setting', async () => {
      expect(settingOps.get(DEFAULT, 'last_unread_check')).toBeNull()
      await startMcpServer(testPort)
      await callMcpTool(testPort, '/mcp', 'get_unread_messages', {})
      const after = settingOps.get(DEFAULT, 'last_unread_check')
      expect(after).not.toBeNull()
      expect(Date.now() - new Date(after!).getTime()).toBeLessThan(5000)
    })

    it('uses last_unread_check as the default since', async () => {
      chatOps.insert(DEFAULT, 'unread-default@s.whatsapp.net', 'dm', undefined, 'Unread Default')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'unread-default@s.whatsapp.net') as any
      const now = Date.now()
      settingOps.set(DEFAULT, 'last_unread_check', new Date(now - 5 * 60 * 1000).toISOString())
      messageOps.insert(DEFAULT, chat.id, 'recent-unread', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'recent-unread', timestamp: new Date(now - 1000).toISOString(),
        text: 'RECENT_UNREAD', sender: { name: 'Sender', phone: '+123' }
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_unread_messages', {})
      expect(result.result.content[0].text).toContain('RECENT_UNREAD')
    })

    it('defaults to 24h ago when no last_unread_check', async () => {
      await startMcpServer(testPort)
      const result = await callMcpTool(testPort, '/mcp', 'get_unread_messages', {})
      expect(result.result.content[0].text).toContain('Messages since')
    })
  })

  describe('send_message Tool', () => {
    beforeEach(() => { makeAccount(DEFAULT) })

    it('returns error when the account has no manager', async () => {
      await startMcpServer(testPort)
      const result = await callMcpTool(testPort, '/mcp', 'send_message', {
        jid: 'recipient@s.whatsapp.net', text: 'Hello'
      })
      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toBe('WhatsApp is not connected')
    })

    it('returns error for missing attachment', async () => {
      setManager(DEFAULT, { socket: { sendMessage: vi.fn() } } as any)
      await startMcpServer(testPort)
      const result = await callMcpTool(testPort, '/mcp', 'send_message', {
        jid: 'recipient@s.whatsapp.net', text: 'Hello', attachmentPath: '/nonexistent/file.jpg'
      })
      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain('Attachment file not found')
    })

    it('sends text messages successfully', async () => {
      const socket = { sendMessage: vi.fn().mockResolvedValue({}) }
      setManager(DEFAULT, { socket } as any)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'send_message', {
        jid: 'recipient@s.whatsapp.net', text: 'Hello World'
      })
      expect(result.result.isError).toBeFalsy()
      expect(result.result.content[0].text).toBe('Message sent to recipient@s.whatsapp.net')
      expect(socket.sendMessage).toHaveBeenCalledWith('recipient@s.whatsapp.net', { text: 'Hello World' })
    })

    it('propagates send failures as error content', async () => {
      const socket = { sendMessage: vi.fn().mockRejectedValue(new Error('Network error')) }
      setManager(DEFAULT, { socket } as any)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'send_message', {
        jid: 'recipient@s.whatsapp.net', text: 'Hello'
      })
      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain('Failed to send message')
      expect(result.result.content[0].text).toContain('Network error')
    })
  })

  describe('Identity Resolution', () => {
    beforeEach(() => { makeAccount(DEFAULT) })

    it('honors meIdentity for isFromMe detection', async () => {
      settingOps.set(DEFAULT, 'user_display_name', 'Me')
      settingOps.set(DEFAULT, 'user_phone', '+1234567890')
      chatOps.insert(DEFAULT, 'me-chat@s.whatsapp.net', 'dm', undefined, 'Me Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'me-chat@s.whatsapp.net') as any
      const now = Date.now()
      messageOps.insert(DEFAULT, chat.id, 'my-msg', now, '1234567890@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'my-msg', timestamp: new Date(now).toISOString(),
        text: 'My own message', sender: { name: 'Unknown', phone: '+1234567890' }, isFromMe: false
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'me-chat@s.whatsapp.net' })
      expect(result.result.content[0].text).toContain('My own message')
    })

    it('resolves LID contacts', async () => {
      const lidJid = 'lid-value-abc@lid'
      contactOps.insert(DEFAULT, 'some-jid@s.whatsapp.net', 'LID User Name', '+9999999999', lidJid)
      chatOps.insert(DEFAULT, 'lid-chat@s.whatsapp.net', 'dm', undefined, 'LID Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'lid-chat@s.whatsapp.net') as any
      const now = Date.now()
      messageOps.insert(DEFAULT, chat.id, 'lid-msg', now, lidJid, JSON.stringify({
        type: 'message', messageId: 'lid-msg', timestamp: new Date(now).toISOString(),
        text: 'Message from LID', sender: { name: 'Unknown', phone: null }
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'lid-chat@s.whatsapp.net' })
      expect(result.result.content[0].text).toContain('LID User Name')
    })

    it('falls back to contact lookup by phone number', async () => {
      contactOps.insert(DEFAULT, 'other-jid@s.whatsapp.net', 'Phone Contact', '+5551234567')
      chatOps.insert(DEFAULT, 'phone-chat@s.whatsapp.net', 'dm', undefined, 'Phone Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'phone-chat@s.whatsapp.net') as any
      const now = Date.now()
      messageOps.insert(DEFAULT, chat.id, 'phone-msg', now, '5551234567@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'phone-msg', timestamp: new Date(now).toISOString(),
        text: 'Message from phone contact', sender: { name: 'Unknown', phone: '+5551234567' }
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'phone-chat@s.whatsapp.net' })
      expect(result.result.content[0].text).toContain('Phone Contact')
    })

    it('formats Unknown with JID when no contact info exists', async () => {
      chatOps.insert(DEFAULT, 'unknown-chat@s.whatsapp.net', 'dm', undefined, 'Unknown Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'unknown-chat@s.whatsapp.net') as any
      const now = Date.now()
      messageOps.insert(DEFAULT, chat.id, 'unknown-msg', now, 'unknown-sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'unknown-msg', timestamp: new Date(now).toISOString(),
        text: 'Message from unknown', sender: { name: 'Unknown', phone: null }
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'unknown-chat@s.whatsapp.net' })
      expect(result.result.content[0].text).toContain('unknown-sender')
    })
  })

  describe('Mention Resolution', () => {
    beforeEach(() => { makeAccount(DEFAULT) })

    it('resolves @Unknown mentions from contacts', async () => {
      contactOps.insert(DEFAULT, 'mentioned@s.whatsapp.net', 'Mentioned User', '+7777777777')
      chatOps.insert(DEFAULT, 'mention-chat@s.whatsapp.net', 'dm', undefined, 'Mention Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'mention-chat@s.whatsapp.net') as any
      const now = Date.now()
      messageOps.insert(DEFAULT, chat.id, 'mention-msg', now, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'mention-msg', timestamp: new Date(now).toISOString(),
        text: 'Hello @Unknown_mentioned@s.whatsapp.net!',
        sender: { name: 'Sender', phone: '+123' },
        mentionedJids: ['mentioned@s.whatsapp.net']
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'mention-chat@s.whatsapp.net' })
      expect(result.result.content[0].text).toContain('Mentioned User')
    })

    it('resolves mentions by number pattern', async () => {
      contactOps.insert(DEFAULT, '8888888888@s.whatsapp.net', 'Number Contact', '+8888888888')
      chatOps.insert(DEFAULT, 'number-mention@s.whatsapp.net', 'dm', undefined, 'Number Mention')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'number-mention@s.whatsapp.net') as any
      const now = Date.now()
      messageOps.insert(DEFAULT, chat.id, 'num-mention-msg', now, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'num-mention-msg', timestamp: new Date(now).toISOString(),
        text: 'Hey @8888888888!',
        sender: { name: 'Sender', phone: '+123' },
        mentionedJids: ['8888888888@s.whatsapp.net']
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'number-mention@s.whatsapp.net' })
      expect(result.result.content[0].text).toContain('Number Contact')
    })
  })

  describe('Reply Resolution', () => {
    beforeEach(() => { makeAccount(DEFAULT) })

    it('resolves reply sender from the original message', async () => {
      contactOps.insert(DEFAULT, 'original-sender@s.whatsapp.net', 'Original Sender', '+4444444444')
      chatOps.insert(DEFAULT, 'reply-chat@s.whatsapp.net', 'dm', undefined, 'Reply Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'reply-chat@s.whatsapp.net') as any
      const now = Date.now()
      messageOps.insert(DEFAULT, chat.id, 'original-msg', now - 2000, 'original-sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'original-msg', timestamp: new Date(now - 2000).toISOString(),
        text: 'This is the original', sender: { name: 'Unknown', phone: null }
      }), false)
      messageOps.insert(DEFAULT, chat.id, 'reply-msg', now - 1000, 'replier@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'reply-msg', timestamp: new Date(now - 1000).toISOString(),
        text: 'This is a reply',
        sender: { name: 'Replier', phone: '+5555555555' },
        replyToMessageId: 'original-msg'
      }), false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'reply-chat@s.whatsapp.net' })
      expect(result.result.content[0].text).toContain('reply')
    })
  })

  describe('Malformed Message Handling', () => {
    beforeEach(() => { makeAccount(DEFAULT) })

    it('skips messages with invalid JSON content', async () => {
      chatOps.insert(DEFAULT, 'malformed-chat@s.whatsapp.net', 'dm', undefined, 'Malformed Chat')
      const chat = chatOps.getByWhatsappJid(DEFAULT, 'malformed-chat@s.whatsapp.net') as any
      const now = Date.now()
      messageOps.insert(DEFAULT, chat.id, 'valid-msg', now - 1000, 'sender@s.whatsapp.net', JSON.stringify({
        type: 'message', messageId: 'valid-msg', timestamp: new Date(now - 1000).toISOString(),
        text: 'VALID_MESSAGE', sender: { name: 'Sender', phone: '+123' }
      }), false)
      messageOps.insert(DEFAULT, chat.id, 'invalid-msg', now - 500, 'sender@s.whatsapp.net', 'not valid json {{{', false)
      await startMcpServer(testPort)

      const result = await callMcpTool(testPort, '/mcp', 'get_chat_history', { jid: 'malformed-chat@s.whatsapp.net' })
      expect(result.result.content[0].text).toContain('VALID_MESSAGE')
    })
  })

  describe('refreshAccount', () => {
    it('evicts the cached McpServer so a re-enabled account resumes serving', async () => {
      makeAccount(DEFAULT)
      await startMcpServer(testPort)

      // Seed + warm the cache.
      chatOps.insert(DEFAULT, 'before@s.whatsapp.net', 'dm', undefined, 'Before')
      await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Before' })

      // Disable → 503
      setMcpEnabled(DEFAULT, false)
      refreshAccount(DEFAULT)
      const disabled = await makeRequest({
        hostname: '127.0.0.1', port: testPort, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      expect(disabled.status).toBe(503)

      // Re-enable → back to 200
      setMcpEnabled(DEFAULT, true)
      refreshAccount(DEFAULT)
      const result = await callMcpTool(testPort, '/mcp', 'search_chats', { query: 'Before' })
      expect(JSON.parse(result.result.content[0].text)).toHaveLength(1)
    })
  })





})

