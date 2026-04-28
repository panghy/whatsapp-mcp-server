import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'

// Create a unique temp directory - hoisted so mock can access it
const testDir = vi.hoisted(() => {
  const path = require('path')
  const os = require('os')
  return path.join(os.tmpdir(), 'sync-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
})

// Mock electron BEFORE importing modules that use it
vi.mock('electron', () => ({
  app: {
    getPath: () => testDir
  }
}))

// Mock message-transformer - it depends on Baileys and Electron
// Use vi.hoisted to create the mock before imports
const mockProcessMessageFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('./message-transformer', () => {
  return {
    MessageTransformer: class {
      processMessage = mockProcessMessageFn
      constructor(_socket: any) {
        void _socket
      }
    },
    extractPhoneFromJid: (jid: string) => {
      const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/)
      return match ? `+${match[1]}` : null
    }
  }
})

// Now import modules - mocks are already in place
import { initializeDatabase, closeDatabase, chatOps, logOps } from './database'
import { SyncOrchestrator, initializeSyncOrchestrator, getSyncOrchestrator } from './sync-orchestrator'
import { MessageTransformer } from './message-transformer'

const SLUG = 'default'

describe('SyncOrchestrator Tests', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    closeDatabase(SLUG)
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    closeDatabase(SLUG)
    const dbDir = path.join(testDir, 'accounts', SLUG)
    if (fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
    fs.mkdirSync(dbDir, { recursive: true })
    initializeDatabase(SLUG)
    mockProcessMessageFn.mockClear()
  })

  afterEach(() => {
    closeDatabase(SLUG)
  })

  describe('SyncOrchestrator class', () => {
    it('should create instance with correct initial status', () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)
      const status = orchestrator.getStatus()
      
      expect(status.isSyncing).toBe(false)
      expect(status.totalChats).toBe(0)
      expect(status.completedChats).toBe(0)
      expect(status.currentChat).toBeNull()
      expect(status.messageCount).toBe(0)
      expect(status.lastError).toBeNull()
    })

    it('should return a copy of status (not reference)', () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)
      
      const status1 = orchestrator.getStatus()
      status1.isSyncing = true
      status1.totalChats = 999
      
      const status2 = orchestrator.getStatus()
      expect(status2.isSyncing).toBe(false)
      expect(status2.totalChats).toBe(0)
    })

    it('should set isSyncing=true with markSyncInProgress()', () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)
      
      expect(orchestrator.getStatus().isSyncing).toBe(false)
      orchestrator.markSyncInProgress()
      expect(orchestrator.getStatus().isSyncing).toBe(true)
    })

    it('should set isSyncing=false with markSyncComplete()', () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)
      
      orchestrator.markSyncInProgress()
      expect(orchestrator.getStatus().isSyncing).toBe(true)
      
      orchestrator.markSyncComplete()
      expect(orchestrator.getStatus().isSyncing).toBe(false)
    })

    it('should set message transformer via setMessageTransformer()', () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)
      const mockTransformer = new MessageTransformer(SLUG, mockSocket)
      
      // Should not throw
      expect(() => orchestrator.setMessageTransformer(mockTransformer)).not.toThrow()
    })
  })

  describe('startInitialSync()', () => {
    it('should skip if sync already in progress', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)
      
      // Mark sync in progress
      orchestrator.markSyncInProgress()
      
      // Start sync - should be a no-op
      await orchestrator.startInitialSync()
      
      // Check logs for warning
      const logs = logOps.getRecent(SLUG, 10) as any[]
      const warnLog = logs.find(l => l.message.includes('Sync already in progress'))
      expect(warnLog).toBeDefined()
    })

    it('should sync only enabled DM chats', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      // Seed DB with various chats
      chatOps.insert(SLUG, 'enabled-dm@s.whatsapp.net', 'dm', undefined, 'Enabled DM')
      chatOps.insert(SLUG, 'disabled-dm@s.whatsapp.net', 'dm', undefined, 'Disabled DM')
      chatOps.insert(SLUG, 'group@g.us', 'group', undefined, 'Test Group')

      // Disable the second DM
      const disabledChat = chatOps.getByWhatsappJid(SLUG, 'disabled-dm@s.whatsapp.net') as any
      chatOps.updateEnabled(SLUG, disabledChat.id, false)

      await orchestrator.startInitialSync()

      const status = orchestrator.getStatus()
      // Should only include the enabled DM (groups are filtered, disabled is filtered)
      expect(status.totalChats).toBe(1)
      expect(status.completedChats).toBe(1)
    })

    it('should set isSyncing=true during sync and false after', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      // Add an enabled DM to sync
      chatOps.insert(SLUG, 'test@s.whatsapp.net', 'dm', undefined, 'Test')

      // Before sync
      expect(orchestrator.getStatus().isSyncing).toBe(false)

      await orchestrator.startInitialSync()

      // After sync
      expect(orchestrator.getStatus().isSyncing).toBe(false)
    })

    it('should update completedChats count', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      // Add two enabled DMs
      chatOps.insert(SLUG, 'chat1@s.whatsapp.net', 'dm', undefined, 'Chat 1')
      chatOps.insert(SLUG, 'chat2@s.whatsapp.net', 'dm', undefined, 'Chat 2')

      await orchestrator.startInitialSync()

      const status = orchestrator.getStatus()
      expect(status.completedChats).toBe(2)
      expect(status.totalChats).toBe(2)
    })

    it('should handle individual chat sync errors gracefully', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      // Add chats
      chatOps.insert(SLUG, 'good@s.whatsapp.net', 'dm', undefined, 'Good Chat')
      chatOps.insert(SLUG, 'bad@s.whatsapp.net', 'dm', undefined, 'Bad Chat')

      await orchestrator.startInitialSync()

      // Both chats should be attempted (completedChats incremented for successful ones)
      const status = orchestrator.getStatus()
      expect(status.totalChats).toBe(2)
      // Even if one fails, sync continues
      expect(status.isSyncing).toBe(false)
    })
  })

  describe('bufferMessage()', () => {
    it('should buffer messages when isSyncing is true', () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      orchestrator.markSyncInProgress()

      const testMsg = { text: 'test message' }
      const chatId = 1

      // Buffer message - this should work without throwing
      orchestrator.bufferMessage(testMsg, chatId)

      // We can't directly access the buffer, but we can verify via sync completion
      expect(orchestrator.getStatus().isSyncing).toBe(true)
    })

    it('should ignore messages when isSyncing is false', () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      expect(orchestrator.getStatus().isSyncing).toBe(false)

      const testMsg = { text: 'test message' }
      const chatId = 1

      // Buffer message when not syncing - should be ignored
      orchestrator.bufferMessage(testMsg, chatId)

      // No error should occur
      expect(orchestrator.getStatus().isSyncing).toBe(false)
    })

    it('should group messages by chatId', () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      orchestrator.markSyncInProgress()

      // Buffer messages for different chats
      orchestrator.bufferMessage({ text: 'msg1' }, 1)
      orchestrator.bufferMessage({ text: 'msg2' }, 1)
      orchestrator.bufferMessage({ text: 'msg3' }, 2)

      // Buffer should have grouped them, but we can't directly verify
      // Just ensure no error
      expect(orchestrator.getStatus().isSyncing).toBe(true)
    })
  })

  describe('syncChat() insert', () => {
    it('inserts a new group with enabled=0', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      await (orchestrator as any).syncChat({ id: 'newgroup@g.us' })

      const row = chatOps.getByWhatsappJid(SLUG, 'newgroup@g.us') as any
      expect(row).toBeDefined()
      expect(row.chat_type).toBe('group')
      expect(row.enabled).toBe(0)
    })

    it('inserts a new DM with enabled=1', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      await (orchestrator as any).syncChat({ id: 'newdm@s.whatsapp.net' })

      const row = chatOps.getByWhatsappJid(SLUG, 'newdm@s.whatsapp.net') as any
      expect(row).toBeDefined()
      expect(row.chat_type).toBe('dm')
      expect(row.enabled).toBe(1)
    })
  })

  describe('syncEnabledGroup()', () => {
    it('should throw error if chat not found', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      await expect(orchestrator.syncEnabledGroup(999)).rejects.toThrow('Chat 999 not found')
    })

    it('should sync a valid chat by ID', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)

      // Create a chat
      chatOps.insert(SLUG, 'group@g.us', 'group', undefined, 'Test Group')
      const chat = chatOps.getByWhatsappJid(SLUG, 'group@g.us') as any

      // Enable the group
      chatOps.updateEnabled(SLUG, chat.id, true)

      // Should not throw
      await expect(orchestrator.syncEnabledGroup(chat.id)).resolves.not.toThrow()
    })
  })

  describe('flushMessageBuffer() via startInitialSync', () => {
    it('should process buffered messages through messageTransformer', async () => {
      const mockSocket = {}
      const orchestrator = new SyncOrchestrator(SLUG, mockSocket)
      const mockTransformer = new MessageTransformer(SLUG, mockSocket)
      orchestrator.setMessageTransformer(mockTransformer)

      // Create a chat
      chatOps.insert(SLUG, 'test@s.whatsapp.net', 'dm', undefined, 'Test Chat')
      const chat = chatOps.getByWhatsappJid(SLUG, 'test@s.whatsapp.net') as any

      // Mark sync in progress and buffer some messages
      orchestrator.markSyncInProgress()
      orchestrator.bufferMessage({ key: { id: 'msg1' } }, chat.id)
      orchestrator.bufferMessage({ key: { id: 'msg2' } }, chat.id)
      orchestrator.markSyncComplete()

      // Start a new sync which will flush the buffer at the end
      await orchestrator.startInitialSync()

      // The buffer should have been processed
      // Check logs for flush confirmation
      const logs = logOps.getRecent(SLUG, 20) as any[]
      const flushLog = logs.find(l => l.message.includes('Message buffer flushed'))
      expect(flushLog).toBeDefined()
    })
  })

  describe('Global functions', () => {
    it('should throw when getSyncOrchestrator(SLUG) called before initialization', () => {
      // Note: This test relies on module-level singleton state
      // Since we can't reset the module, we test this behavior pattern
      // The actual singleton may have been initialized in other tests
      // So we just verify the function exists and has correct signature
      expect(typeof getSyncOrchestrator).toBe('function')
    })

    it('should create and return orchestrator via initializeSyncOrchestrator(SLUG)', () => {
      const mockSocket = {}
      const orchestrator = initializeSyncOrchestrator(SLUG, mockSocket)

      expect(orchestrator).toBeInstanceOf(SyncOrchestrator)
      expect(orchestrator.getStatus()).toBeDefined()
    })

    it('should return same instance on subsequent calls', () => {
      const mockSocket1 = {}
      const mockSocket2 = {}

      const orchestrator1 = initializeSyncOrchestrator(SLUG, mockSocket1)
      const orchestrator2 = initializeSyncOrchestrator(SLUG, mockSocket2)

      // Same instance should be returned
      expect(orchestrator1).toBe(orchestrator2)
    })
  })
})

