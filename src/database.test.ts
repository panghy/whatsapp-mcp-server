import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Create a unique temp directory - hoisted so mock can access it
// Must use require inside vi.hoisted since imports are hoisted after vi.hoisted
const { testDir } = vi.hoisted(() => {
  const path = require('path')
  const os = require('os')
  const testDir = path.join(os.tmpdir(), 'whatsapp-mcp-test-' + Date.now())
  return { testDir }
})

// Mock electron BEFORE importing database module
vi.mock('electron', () => ({
  app: {
    getPath: () => testDir
  }
}))

// NOW import database - the mock is already in place
import { initializeDatabase, closeDatabase, getDatabase, chatOps, messageOps, contactOps, settingOps, logOps } from './database'

describe('Database Integration Tests', () => {
  beforeAll(() => {
    // Create the temp directory
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    // Close DB and clean up
    closeDatabase()
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    // Initialize fresh database for each test
    closeDatabase()
    // Remove any existing database file
    const dbDir = path.join(testDir, 'nodexa-whatsapp')
    if (fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
    fs.mkdirSync(dbDir, { recursive: true })
    initializeDatabase()
  })

  afterEach(() => {
    closeDatabase()
  })

  describe('initializeDatabase', () => {
    it('should create database and run migrations', () => {
      const db = getDatabase()
      expect(db).toBeDefined()
      
      // Verify tables exist by querying them
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      const tableNames = tables.map(t => t.name)
      
      expect(tableNames).toContain('chats')
      expect(tableNames).toContain('messages')
      expect(tableNames).toContain('contacts')
      expect(tableNames).toContain('settings')
      expect(tableNames).toContain('logs')
      expect(tableNames).toContain('schema_version')
    })

    it('should apply all migrations', () => {
      const db = getDatabase()
      const version = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number }
      expect(version.version).toBe(5) // Latest migration version
    })
  })

  describe('chatOps', () => {
    it('should insert and retrieve a chat', () => {
      const jid = '1234567890@s.whatsapp.net'
      chatOps.insert(jid, 'dm', 'uuid-123', 'Test User')
      
      const chats = chatOps.getAll() as any[]
      expect(chats).toHaveLength(1)
      expect(chats[0].whatsapp_jid).toBe(jid)
      expect(chats[0].chat_type).toBe('dm')
      expect(chats[0].name).toBe('Test User')
    })

    it('should get chat by JID', () => {
      const jid = '9876543210@s.whatsapp.net'
      chatOps.insert(jid, 'group', null, 'My Group')
      
      const chat = chatOps.getByWhatsappJid(jid) as any
      expect(chat).toBeDefined()
      expect(chat.whatsapp_jid).toBe(jid)
      expect(chat.chat_type).toBe('group')
    })

    it('should update chat metadata', () => {
      chatOps.insert('test@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid('test@s.whatsapp.net') as any
      
      chatOps.updateMetadata(chat.id, { name: 'Updated Name', lastActivity: '2024-01-01T00:00:00Z' })
      
      const updated = chatOps.getById(chat.id) as any
      expect(updated.name).toBe('Updated Name')
      expect(updated.last_activity).toBe('2024-01-01T00:00:00Z')
    })

    it('should get chat by JID and type', () => {
      chatOps.insert('group@g.us', 'group', null, 'Group Chat')
      
      const chat = chatOps.getByJidAndType('group@g.us', 'group') as any
      expect(chat).toBeDefined()
      expect(chat.name).toBe('Group Chat')
      
      const nonExistent = chatOps.getByJidAndType('group@g.us', 'dm')
      expect(nonExistent).toBeUndefined()
    })
  })

  describe('messageOps', () => {
    it('should insert and retrieve messages', () => {
      chatOps.insert('chat@s.whatsapp.net', 'dm', null, 'Chat')
      const chat = chatOps.getByWhatsappJid('chat@s.whatsapp.net') as any
      
      messageOps.insert(chat.id, 'msg-001', 1700000000, 'sender@s.whatsapp.net', '{"text":"Hello"}', false)
      messageOps.insert(chat.id, 'msg-002', 1700000001, 'sender@s.whatsapp.net', '{"text":"World"}', false)
      
      const messages = messageOps.getByChatId(chat.id) as any[]
      expect(messages).toHaveLength(2)
    })

    it('should get message by WhatsApp message ID', () => {
      chatOps.insert('chat2@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid('chat2@s.whatsapp.net') as any
      
      messageOps.insert(chat.id, 'unique-msg-123', 1700000000, 'sender@s.whatsapp.net', '{"text":"Test"}', false)
      
      const msg = messageOps.getByWhatsappMessageId('unique-msg-123') as any
      expect(msg).toBeDefined()
      expect(msg.content_json).toBe('{"text":"Test"}')
    })

    it('should support pagination with limit and offset', () => {
      chatOps.insert('chat3@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid('chat3@s.whatsapp.net') as any
      
      // Insert 5 messages
      for (let i = 0; i < 5; i++) {
        messageOps.insert(chat.id, `msg-${i}`, 1700000000 + i, 'sender@s.whatsapp.net', `{"text":"Message ${i}"}`, false)
      }
      
      // Get first 2 messages (most recent due to ORDER BY id DESC)
      const page1 = messageOps.getByChatId(chat.id, 2, 0) as any[]
      expect(page1).toHaveLength(2)
      
      // Get next 2 messages
      const page2 = messageOps.getByChatId(chat.id, 2, 2) as any[]
      expect(page2).toHaveLength(2)
      
      // Messages should be different
      expect(page1[0].whatsapp_message_id).not.toBe(page2[0].whatsapp_message_id)
    })

    it('should count messages by chat', () => {
      chatOps.insert('chat-count@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid('chat-count@s.whatsapp.net') as any

      messageOps.insert(chat.id, 'count-1', 1700000000, 'sender@s.whatsapp.net', '{"text":"1"}', false)
      messageOps.insert(chat.id, 'count-2', 1700000001, 'sender@s.whatsapp.net', '{"text":"2"}', false)
      messageOps.insert(chat.id, 'count-3', 1700000002, 'sender@s.whatsapp.net', '{"text":"3"}', false)

      const count = messageOps.getCountByChatId(chat.id)
      expect(count).toBe(3)
    })

    it('should update message content JSON', () => {
      chatOps.insert('chat-update@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid('chat-update@s.whatsapp.net') as any

      messageOps.insert(chat.id, 'update-msg', 1700000000, 'sender@s.whatsapp.net', '{"text":"Original"}', false)
      messageOps.updateContentJson('update-msg', '{"text":"Updated"}')

      const msg = messageOps.getByWhatsappMessageId('update-msg') as any
      expect(msg.content_json).toBe('{"text":"Updated"}')
    })

    it('should ignore duplicate message inserts', () => {
      chatOps.insert('chat-dup@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid('chat-dup@s.whatsapp.net') as any

      messageOps.insert(chat.id, 'dup-msg', 1700000000, 'sender@s.whatsapp.net', '{"text":"First"}', false)
      messageOps.insert(chat.id, 'dup-msg', 1700000001, 'sender@s.whatsapp.net', '{"text":"Second"}', false)

      const count = messageOps.getCountByChatId(chat.id)
      expect(count).toBe(1)

      const msg = messageOps.getByWhatsappMessageId('dup-msg') as any
      expect(msg.content_json).toBe('{"text":"First"}')
    })
  })

  describe('contactOps', () => {
    it('should insert and retrieve contact by JID', () => {
      contactOps.insert('contact@s.whatsapp.net', 'John Doe', '+1234567890', 'lid-123')

      const contact = contactOps.getByJid('contact@s.whatsapp.net') as any
      expect(contact).toBeDefined()
      expect(contact.name).toBe('John Doe')
      expect(contact.phone_number).toBe('+1234567890')
      expect(contact.lid).toBe('lid-123')
    })

    it('should get contact by phone number', () => {
      contactOps.insert('phone-contact@s.whatsapp.net', 'Jane', '+9876543210')

      // Test with different phone formats
      const withPlus = contactOps.getByPhone('+9876543210') as any
      expect(withPlus).toBeDefined()
      expect(withPlus.name).toBe('Jane')

      const withoutPlus = contactOps.getByPhone('9876543210') as any
      expect(withoutPlus).toBeDefined()
      expect(withoutPlus.name).toBe('Jane')
    })

    it('should get contact by LID', () => {
      contactOps.insert('lid-contact@lid', 'Lid User', '+1111111111', 'my-lid-value')

      const contact = contactOps.getByLid('my-lid-value') as any
      expect(contact).toBeDefined()
      expect(contact.name).toBe('Lid User')
    })

    it('should upsert contact - update existing', () => {
      contactOps.insert('upsert@s.whatsapp.net', 'Original Name', '+1234567890')
      contactOps.insert('upsert@s.whatsapp.net', 'Updated Name')

      const contact = contactOps.getByJid('upsert@s.whatsapp.net') as any
      expect(contact.name).toBe('Updated Name')
      expect(contact.phone_number).toBe('+1234567890') // Should be preserved
    })
  })

  describe('settingOps', () => {
    it('should set and get a setting', () => {
      settingOps.set('api_key', 'secret-123')

      const value = settingOps.get('api_key')
      expect(value).toBe('secret-123')
    })

    it('should return null for non-existent setting', () => {
      const value = settingOps.get('non_existent_key')
      expect(value).toBeNull()
    })

    it('should overwrite existing setting', () => {
      settingOps.set('overwrite_test', 'value1')
      settingOps.set('overwrite_test', 'value2')

      const value = settingOps.get('overwrite_test')
      expect(value).toBe('value2')
    })

    it('should get all settings', () => {
      settingOps.set('setting1', 'a')
      settingOps.set('setting2', 'b')

      const all = settingOps.getAll() as any[]
      expect(all.length).toBeGreaterThanOrEqual(2)
    })

    it('should delete a setting', () => {
      settingOps.set('to_delete', 'value')
      settingOps.delete('to_delete')

      const value = settingOps.get('to_delete')
      expect(value).toBeNull()
    })
  })

  describe('logOps', () => {
    it('should insert and retrieve recent logs', () => {
      logOps.insert('info', 'test', 'Test log message', '{"extra":"data"}')

      const logs = logOps.getRecent(10) as any[]
      expect(logs.length).toBeGreaterThanOrEqual(1)

      const lastLog = logs.find((l: any) => l.message === 'Test log message')
      expect(lastLog).toBeDefined()
      expect(lastLog.level).toBe('info')
      expect(lastLog.category).toBe('test')
    })

    it('should get logs by level', () => {
      logOps.insert('error', 'system', 'Error message')
      logOps.insert('info', 'system', 'Info message')

      const errorLogs = logOps.getByLevel('error') as any[]
      expect(errorLogs.every((l: any) => l.level === 'error')).toBe(true)
    })

    it('should get logs by category', () => {
      logOps.insert('info', 'whatsapp', 'WhatsApp log')
      logOps.insert('info', 'mcp', 'MCP log')

      const whatsappLogs = logOps.getByCategory('whatsapp') as any[]
      expect(whatsappLogs.every((l: any) => l.category === 'whatsapp')).toBe(true)
    })

    it('should clear all logs', () => {
      logOps.insert('info', 'test', 'Log 1')
      logOps.insert('info', 'test', 'Log 2')

      logOps.clear()

      const logs = logOps.getAll() as any[]
      expect(logs).toHaveLength(0)
    })
  })
})

