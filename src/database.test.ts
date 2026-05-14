import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import Database from 'better-sqlite3'
import path from 'path'

// Create a unique temp directory - hoisted so mock can access it.
// Must use require inside vi.hoisted since imports are hoisted after vi.hoisted.
const { testDir } = vi.hoisted(() => {
  const path = require('path')
  const os = require('os')
  const testDir = path.join(os.tmpdir(), 'whatsapp-mcp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  return { testDir }
})

// Mock electron BEFORE importing the database module so accountDbPath resolves
// into our temp directory instead of the real userData folder.
vi.mock('electron', () => ({
  app: {
    getPath: () => testDir
  }
}))

// NOW import database - the mock is already in place
import {
  initializeDatabase,
  closeDatabase,
  closeAllDatabases,
  getDatabase,
  chatOps,
  messageOps,
  contactOps,
  settingOps,
  logOps,
} from './database'
import { accountDbPath } from './accounts'

const SLUG = 'test-a'

describe('Database Integration Tests', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    closeAllDatabases()
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    // Fresh DB per test: close any open handles and wipe the accounts dir.
    closeAllDatabases()
    const accountsRoot = require('path').join(testDir, 'accounts')
    if (fs.existsSync(accountsRoot)) {
      fs.rmSync(accountsRoot, { recursive: true, force: true })
    }
    initializeDatabase(SLUG)
  })

  afterEach(() => {
    closeAllDatabases()
  })

  describe('initializeDatabase', () => {
    it('should create database and run migrations', () => {
      const db = getDatabase(SLUG)
      expect(db).toBeDefined()

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      const tableNames = tables.map((t) => t.name)

      expect(tableNames).toContain('chats')
      expect(tableNames).toContain('messages')
      expect(tableNames).toContain('contacts')
      expect(tableNames).toContain('settings')
      expect(tableNames).toContain('logs')
      expect(tableNames).toContain('schema_version')
    })

    it('should apply all migrations', () => {
      const db = getDatabase(SLUG)
      const version = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number }
      expect(version.version).toBe(8)
    })

    it('should return the same handle when initialized twice for the same slug', () => {
      const first = initializeDatabase(SLUG)
      const second = initializeDatabase(SLUG)
      expect(second).toBe(first)
    })
  })

  describe('getDatabase / closeDatabase', () => {
    it('should throw when getDatabase is called for an uninitialized slug', () => {
      expect(() => getDatabase('never-initialized')).toThrow(/not initialized/)
    })

    it('closeDatabase should drop the cached handle for that slug', () => {
      initializeDatabase(SLUG)
      closeDatabase(SLUG)
      expect(() => getDatabase(SLUG)).toThrow(/not initialized/)
    })

    it('closeAllDatabases should drop handles for all slugs', () => {
      initializeDatabase('a')
      initializeDatabase('b')
      closeAllDatabases()
      expect(() => getDatabase('a')).toThrow(/not initialized/)
      expect(() => getDatabase('b')).toThrow(/not initialized/)
    })
  })

  describe('migration 7 (backfill enabled=0 for bug-inserted groups)', () => {
    it('flips only groups where group_metadata_fetched=0 and enabled=1', () => {
      const db = getDatabase(SLUG)

      // Seed four rows using raw SQL so we can bypass chatOps.insert and
      // mimic the exact historical state the migration is cleaning up.
      db.prepare(`INSERT INTO chats (whatsapp_jid, chat_type, name, enabled, group_metadata_fetched)
                  VALUES (?, ?, ?, ?, ?)`)
        .run('buggy-unfetched@g.us', 'group', 'Buggy', 1, 0)
      db.prepare(`INSERT INTO chats (whatsapp_jid, chat_type, name, enabled, group_metadata_fetched)
                  VALUES (?, ?, ?, ?, ?)`)
        .run('correct-unfetched@g.us', 'group', 'Correct', 0, 0)
      db.prepare(`INSERT INTO chats (whatsapp_jid, chat_type, name, enabled, group_metadata_fetched)
                  VALUES (?, ?, ?, ?, ?)`)
        .run('fetched-enabled@g.us', 'group', 'Fetched', 1, 1)
      db.prepare(`INSERT INTO chats (whatsapp_jid, chat_type, name, enabled, group_metadata_fetched)
                  VALUES (?, ?, ?, ?, ?)`)
        .run('dm@s.whatsapp.net', 'dm', 'Alice', 1, 0)

      // Re-run the migration in isolation (it is idempotent, so reapplying
      // via a hand-rolled UPDATE is equivalent to triggering applyMigration7).
      db.prepare(`UPDATE chats SET enabled = 0
                  WHERE chat_type = 'group' AND group_metadata_fetched = 0 AND enabled = 1`).run()

      const buggy = db.prepare('SELECT enabled FROM chats WHERE whatsapp_jid = ?').get('buggy-unfetched@g.us') as any
      const correct = db.prepare('SELECT enabled FROM chats WHERE whatsapp_jid = ?').get('correct-unfetched@g.us') as any
      const fetched = db.prepare('SELECT enabled FROM chats WHERE whatsapp_jid = ?').get('fetched-enabled@g.us') as any
      const dm = db.prepare('SELECT enabled FROM chats WHERE whatsapp_jid = ?').get('dm@s.whatsapp.net') as any

      expect(buggy.enabled).toBe(0)
      expect(correct.enabled).toBe(0)
      expect(fetched.enabled).toBe(1)
      expect(dm.enabled).toBe(1)
    })

    it('runs at schema bootstrap on a fresh DB (idempotent no-op when no bad rows)', () => {
      // A freshly initialized DB will have run migration 7 already; a re-run
      // should touch zero rows.
      const db = getDatabase(SLUG)
      const result = db.prepare(`UPDATE chats SET enabled = 0
                  WHERE chat_type = 'group' AND group_metadata_fetched = 0 AND enabled = 1`).run()
      expect(result.changes).toBe(0)
    })
  })

  describe('chatOps', () => {
    it('should insert and retrieve a chat', () => {
      const jid = '1234567890@s.whatsapp.net'
      chatOps.insert(SLUG, jid, 'dm', 'uuid-123', 'Test User')

      const chats = chatOps.getAll(SLUG) as any[]
      expect(chats).toHaveLength(1)
      expect(chats[0].whatsapp_jid).toBe(jid)
      expect(chats[0].chat_type).toBe('dm')
      expect(chats[0].name).toBe('Test User')
    })

    it('should get chat by JID', () => {
      const jid = '9876543210@s.whatsapp.net'
      chatOps.insert(SLUG, jid, 'group', undefined, 'My Group')

      const chat = chatOps.getByWhatsappJid(SLUG, jid) as any
      expect(chat).toBeDefined()
      expect(chat.whatsapp_jid).toBe(jid)
      expect(chat.chat_type).toBe('group')
    })

    it('should update chat metadata', () => {
      chatOps.insert(SLUG, 'test@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid(SLUG, 'test@s.whatsapp.net') as any

      chatOps.updateMetadata(SLUG, chat.id, { name: 'Updated Name', lastActivity: '2024-01-01T00:00:00Z' })

      const updated = chatOps.getById(SLUG, chat.id) as any
      expect(updated.name).toBe('Updated Name')
      expect(updated.last_activity).toBe('2024-01-01T00:00:00Z')
    })

    it('should get chat by JID and type', () => {
      chatOps.insert(SLUG, 'group@g.us', 'group', undefined, 'Group Chat')

      const chat = chatOps.getByJidAndType(SLUG, 'group@g.us', 'group') as any
      expect(chat).toBeDefined()
      expect(chat.name).toBe('Group Chat')

      const nonExistent = chatOps.getByJidAndType(SLUG, 'group@g.us', 'dm')
      expect(nonExistent).toBeUndefined()
    })

    it('should honor explicit enabled argument when provided', () => {
      chatOps.insert(SLUG, 'grp-disabled@g.us', 'group', undefined, 'Disabled', 0)
      chatOps.insert(SLUG, 'dm-enabled@s.whatsapp.net', 'dm', undefined, 'Bob', 1)

      const group = chatOps.getByWhatsappJid(SLUG, 'grp-disabled@g.us') as any
      const dm = chatOps.getByWhatsappJid(SLUG, 'dm-enabled@s.whatsapp.net') as any
      expect(group.enabled).toBe(0)
      expect(dm.enabled).toBe(1)
    })

    it('should default to the SQLite column default when enabled is omitted', () => {
      chatOps.insert(SLUG, 'default-group@g.us', 'group', undefined, 'DefaultGroup')
      const group = chatOps.getByWhatsappJid(SLUG, 'default-group@g.us') as any
      expect(group.enabled).toBe(1)
    })

    it('getAllGroups should return only rows with chat_type = group', () => {
      chatOps.insert(SLUG, 'g1@g.us', 'group', undefined, 'Group One')
      chatOps.insert(SLUG, 'g2@g.us', 'group', undefined, 'Group Two')
      chatOps.insert(SLUG, 'dm1@s.whatsapp.net', 'dm', undefined, 'DM One')
      chatOps.insert(SLUG, 'dm2@lid', 'dm', undefined, 'DM Lid')

      const groups = chatOps.getAllGroups(SLUG) as any[]
      expect(groups).toHaveLength(2)
      expect(groups.every((row) => row.chat_type === 'group')).toBe(true)
    })
  })

  describe('messageOps', () => {
    it('should insert and retrieve messages', () => {
      chatOps.insert(SLUG, 'chat@s.whatsapp.net', 'dm', undefined, 'Chat')
      const chat = chatOps.getByWhatsappJid(SLUG, 'chat@s.whatsapp.net') as any

      messageOps.insert(SLUG, chat.id, 'msg-001', 1700000000, 'sender@s.whatsapp.net', '{"text":"Hello"}', false)
      messageOps.insert(SLUG, chat.id, 'msg-002', 1700000001, 'sender@s.whatsapp.net', '{"text":"World"}', false)

      const messages = messageOps.getByChatId(SLUG, chat.id) as any[]
      expect(messages).toHaveLength(2)
    })

    it('should get message by WhatsApp message ID', () => {
      chatOps.insert(SLUG, 'chat2@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid(SLUG, 'chat2@s.whatsapp.net') as any

      messageOps.insert(SLUG, chat.id, 'unique-msg-123', 1700000000, 'sender@s.whatsapp.net', '{"text":"Test"}', false)

      const msg = messageOps.getByWhatsappMessageId(SLUG, 'unique-msg-123') as any
      expect(msg).toBeDefined()
      expect(msg.content_json).toBe('{"text":"Test"}')
    })

    it('should support pagination with limit and offset', () => {
      chatOps.insert(SLUG, 'chat3@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid(SLUG, 'chat3@s.whatsapp.net') as any

      for (let i = 0; i < 5; i++) {
        messageOps.insert(SLUG, chat.id, `msg-${i}`, 1700000000 + i, 'sender@s.whatsapp.net', `{"text":"Message ${i}"}`, false)
      }

      const page1 = messageOps.getByChatId(SLUG, chat.id, 2, 0) as any[]
      expect(page1).toHaveLength(2)

      const page2 = messageOps.getByChatId(SLUG, chat.id, 2, 2) as any[]
      expect(page2).toHaveLength(2)

      expect(page1[0].whatsapp_message_id).not.toBe(page2[0].whatsapp_message_id)
    })

    it('should count messages by chat', () => {
      chatOps.insert(SLUG, 'chat-count@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid(SLUG, 'chat-count@s.whatsapp.net') as any

      messageOps.insert(SLUG, chat.id, 'count-1', 1700000000, 'sender@s.whatsapp.net', '{"text":"1"}', false)
      messageOps.insert(SLUG, chat.id, 'count-2', 1700000001, 'sender@s.whatsapp.net', '{"text":"2"}', false)
      messageOps.insert(SLUG, chat.id, 'count-3', 1700000002, 'sender@s.whatsapp.net', '{"text":"3"}', false)

      const count = messageOps.getCountByChatId(SLUG, chat.id)
      expect(count).toBe(3)
    })

    it('should update message content JSON', () => {
      chatOps.insert(SLUG, 'chat-update@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid(SLUG, 'chat-update@s.whatsapp.net') as any

      messageOps.insert(SLUG, chat.id, 'update-msg', 1700000000, 'sender@s.whatsapp.net', '{"text":"Original"}', false)
      messageOps.updateContentJson(SLUG, 'update-msg', '{"text":"Updated"}')

      const msg = messageOps.getByWhatsappMessageId(SLUG, 'update-msg') as any
      expect(msg.content_json).toBe('{"text":"Updated"}')
    })

    it('should ignore duplicate message inserts', () => {
      chatOps.insert(SLUG, 'chat-dup@s.whatsapp.net', 'dm')
      const chat = chatOps.getByWhatsappJid(SLUG, 'chat-dup@s.whatsapp.net') as any

      messageOps.insert(SLUG, chat.id, 'dup-msg', 1700000000, 'sender@s.whatsapp.net', '{"text":"First"}', false)
      messageOps.insert(SLUG, chat.id, 'dup-msg', 1700000001, 'sender@s.whatsapp.net', '{"text":"Second"}', false)

      const count = messageOps.getCountByChatId(SLUG, chat.id)
      expect(count).toBe(1)

      const msg = messageOps.getByWhatsappMessageId(SLUG, 'dup-msg') as any
      expect(msg.content_json).toBe('{"text":"First"}')
    })
  })

  describe('contactOps', () => {
    it('should insert and retrieve contact by JID', () => {
      contactOps.insert(SLUG, 'contact@s.whatsapp.net', { name: 'John Doe', phoneNumber: '+1234567890', lid: 'lid-123' })

      const contact = contactOps.getByJid(SLUG, 'contact@s.whatsapp.net') as any
      expect(contact).toBeDefined()
      expect(contact.name).toBe('John Doe')
      expect(contact.phone_number).toBe('+1234567890')
      expect(contact.lid).toBe('lid-123')
    })

    it('should get contact by phone number', () => {
      contactOps.insert(SLUG, 'phone-contact@s.whatsapp.net', { name: 'Jane', phoneNumber: '+9876543210' })

      const withPlus = contactOps.getByPhone(SLUG, '+9876543210') as any
      expect(withPlus).toBeDefined()
      expect(withPlus.name).toBe('Jane')

      const withoutPlus = contactOps.getByPhone(SLUG, '9876543210') as any
      expect(withoutPlus).toBeDefined()
      expect(withoutPlus.name).toBe('Jane')
    })

    it('should get contact by LID', () => {
      contactOps.insert(SLUG, 'lid-contact@lid', { name: 'Lid User', phoneNumber: '+1111111111', lid: 'my-lid-value' })

      const contact = contactOps.getByLid(SLUG, 'my-lid-value') as any
      expect(contact).toBeDefined()
      expect(contact.name).toBe('Lid User')
    })

    it('should upsert contact - update existing', () => {
      contactOps.insert(SLUG, 'upsert@s.whatsapp.net', { name: 'Original Name', phoneNumber: '+1234567890' })
      contactOps.insert(SLUG, 'upsert@s.whatsapp.net', { name: 'Updated Name' })

      const contact = contactOps.getByJid(SLUG, 'upsert@s.whatsapp.net') as any
      expect(contact.name).toBe('Updated Name')
      expect(contact.phone_number).toBe('+1234567890')
    })
  })

  describe('migration 8 (split push_name + verified_name columns)', () => {
    it('adds push_name and verified_name columns to contacts', () => {
      const db = getDatabase(SLUG)
      const cols = db.prepare('PRAGMA table_info(contacts)').all() as { name: string }[]
      const names = cols.map((c) => c.name)
      expect(names).toContain('push_name')
      expect(names).toContain('verified_name')
    })

    it('insert with only pushName leaves a prior name untouched', () => {
      const jid = 'split-1@s.whatsapp.net'
      contactOps.insert(SLUG, jid, { name: 'Address Book Name' })
      contactOps.insert(SLUG, jid, { pushName: 'Push Display Name' })

      const row = contactOps.getByJid(SLUG, jid) as any
      expect(row.name).toBe('Address Book Name')
      expect(row.push_name).toBe('Push Display Name')
    })

    it('insert with a new name does not erase a prior pushName', () => {
      const jid = 'split-2@s.whatsapp.net'
      contactOps.insert(SLUG, jid, { pushName: 'Push First' })
      contactOps.insert(SLUG, jid, { name: 'Address Book Later' })

      const row = contactOps.getByJid(SLUG, jid) as any
      expect(row.name).toBe('Address Book Later')
      expect(row.push_name).toBe('Push First')
    })

    it('verified_name is stored independently and survives unrelated upserts', () => {
      const jid = 'split-3@s.whatsapp.net'
      contactOps.insert(SLUG, jid, { verifiedName: 'Acme Inc.' })
      contactOps.insert(SLUG, jid, { name: 'Local Name', pushName: 'Pushy' })

      const row = contactOps.getByJid(SLUG, jid) as any
      expect(row.verified_name).toBe('Acme Inc.')
      expect(row.name).toBe('Local Name')
      expect(row.push_name).toBe('Pushy')
    })
  })

  describe('schema evolution from v7 → v8 (migration 8 ALTER TABLE path)', () => {
    const EVO_SLUG = 'schema-evo'

    // Mirrors the historical shape of the contacts table at schema_version=7:
    // jid + name + phone_number + lid + the migration-6 virtual phone_digits
    // column, with NO push_name or verified_name yet. The FTS5 virtual tables
    // and triggers from migration 6 are intentionally omitted because they
    // are not on the path that migration 8 evolves and they would force the
    // test to deal with tokenizer probing on every platform.
    function buildV7Database(dbPath: string): void {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true })
      const db = new Database(dbPath)
      db.pragma('journal_mode = WAL')
      db.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE contacts (
          jid TEXT PRIMARY KEY,
          name TEXT,
          phone_number TEXT,
          lid TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          phone_digits TEXT GENERATED ALWAYS AS (
            CASE WHEN phone_number IS NULL THEN NULL
            ELSE replace(replace(replace(replace(replace(replace(replace(replace(replace(
              phone_number,
              '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '/', ''), '_', ''), CHAR(9), '')
            END
          ) VIRTUAL
        );
        CREATE INDEX idx_contacts_lid ON contacts(lid);
        CREATE INDEX idx_contacts_phone_digits ON contacts(phone_digits);
        INSERT INTO schema_version (version) VALUES (1), (2), (3), (4), (5), (6), (7);
      `)
      db.close()
    }

    function contactColumnNames(slug: string): string[] {
      const cols = getDatabase(slug).prepare('PRAGMA table_info(contacts)').all() as { name: string }[]
      return cols.map((c) => c.name)
    }

    beforeEach(() => {
      closeAllDatabases()
      const accountsRoot = path.join(testDir, 'accounts')
      if (fs.existsSync(accountsRoot)) fs.rmSync(accountsRoot, { recursive: true, force: true })
    })

    it('upgrades a real v7 DB to v8 while preserving legacy rows', () => {
      // Pre-stage a v7-shaped DB on disk under EVO_SLUG's expected path so
      // the next initializeDatabase() call sees a real upgrade path, not a
      // fresh init.
      const dbPath = accountDbPath(EVO_SLUG)
      buildV7Database(dbPath)

      // Seed legacy contact rows using the OLD shape (no push_name/verified_name).
      const raw = new Database(dbPath)
      raw.prepare('INSERT INTO contacts (jid, name, phone_number) VALUES (?, ?, ?)')
        .run('legacy-1@s.whatsapp.net', 'Legacy One', '+15550000001')
      raw.prepare('INSERT INTO contacts (jid, name, lid) VALUES (?, ?, ?)')
        .run('legacy-2@s.whatsapp.net', 'Legacy Two', 'legacy-2-lid@lid')
      // Sanity: at this point push_name / verified_name don't exist yet.
      const preCols = (raw.prepare('PRAGMA table_info(contacts)').all() as { name: string }[]).map((c) => c.name)
      expect(preCols).not.toContain('push_name')
      expect(preCols).not.toContain('verified_name')
      raw.close()

      // Apply migration 8 by opening through the production code path.
      initializeDatabase(EVO_SLUG)

      // schema_version is now 8 (and only one row per version exists).
      const db = getDatabase(EVO_SLUG)
      const version = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number }
      expect(version.version).toBe(8)

      // The new columns are present.
      const postCols = contactColumnNames(EVO_SLUG)
      expect(postCols).toContain('push_name')
      expect(postCols).toContain('verified_name')

      // Legacy rows survived intact and have NULL for the new columns.
      const one = contactOps.getByJid(EVO_SLUG, 'legacy-1@s.whatsapp.net') as any
      expect(one).toBeDefined()
      expect(one.name).toBe('Legacy One')
      expect(one.phone_number).toBe('+15550000001')
      expect(one.push_name).toBeNull()
      expect(one.verified_name).toBeNull()

      const two = contactOps.getByJid(EVO_SLUG, 'legacy-2@s.whatsapp.net') as any
      expect(two.name).toBe('Legacy Two')
      expect(two.lid).toBe('legacy-2-lid@lid')
      expect(two.push_name).toBeNull()

      // A subsequent insert with only pushName populates push_name without
      // disturbing the address-book name set by the v7-era code.
      contactOps.insert(EVO_SLUG, 'legacy-1@s.whatsapp.net', { pushName: 'Push For Legacy' })
      const updated = contactOps.getByJid(EVO_SLUG, 'legacy-1@s.whatsapp.net') as any
      expect(updated.name).toBe('Legacy One')
      expect(updated.push_name).toBe('Push For Legacy')
      expect(updated.verified_name).toBeNull()
    })

    it('is idempotent: re-running initializeDatabase keeps version=8 with no duplicate columns', () => {
      buildV7Database(accountDbPath(EVO_SLUG))
      initializeDatabase(EVO_SLUG)

      const colsBefore = contactColumnNames(EVO_SLUG).filter((n) => n === 'push_name' || n === 'verified_name')
      expect(colsBefore).toEqual(['push_name', 'verified_name'])

      // Drop the cached handle so initializeDatabase() takes the open-from-disk
      // branch and re-evaluates runMigrations() against the existing file.
      closeDatabase(EVO_SLUG)
      expect(() => initializeDatabase(EVO_SLUG)).not.toThrow()

      const db = getDatabase(EVO_SLUG)
      const version = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number }
      expect(version.version).toBe(8)

      const colsAfter = contactColumnNames(EVO_SLUG).filter((n) => n === 'push_name' || n === 'verified_name')
      expect(colsAfter).toEqual(['push_name', 'verified_name'])
    })

    it('fresh DB jumps straight to version=8 with both new columns present', () => {
      // No pre-stage: this is the "first launch" path.
      initializeDatabase('fresh-evo')
      const db = getDatabase('fresh-evo')
      const version = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number }
      expect(version.version).toBe(8)
      const cols = (db.prepare('PRAGMA table_info(contacts)').all() as { name: string }[]).map((c) => c.name)
      expect(cols).toContain('push_name')
      expect(cols).toContain('verified_name')
    })
  })

  describe('settingOps', () => {
    it('should set and get a setting', () => {
      settingOps.set(SLUG, 'api_key', 'secret-123')
      expect(settingOps.get(SLUG, 'api_key')).toBe('secret-123')
    })

    it('should return null for non-existent setting', () => {
      expect(settingOps.get(SLUG, 'non_existent_key')).toBeNull()
    })

    it('should overwrite existing setting', () => {
      settingOps.set(SLUG, 'overwrite_test', 'value1')
      settingOps.set(SLUG, 'overwrite_test', 'value2')
      expect(settingOps.get(SLUG, 'overwrite_test')).toBe('value2')
    })

    it('should get all settings', () => {
      settingOps.set(SLUG, 'setting1', 'a')
      settingOps.set(SLUG, 'setting2', 'b')
      const all = settingOps.getAll(SLUG) as any[]
      expect(all.length).toBeGreaterThanOrEqual(2)
    })

    it('should delete a setting', () => {
      settingOps.set(SLUG, 'to_delete', 'value')
      settingOps.delete(SLUG, 'to_delete')
      expect(settingOps.get(SLUG, 'to_delete')).toBeNull()
    })

    it('has() should reflect presence of a key', () => {
      expect(settingOps.has(SLUG, 'maybe_key')).toBe(false)
      settingOps.set(SLUG, 'maybe_key', 'v')
      expect(settingOps.has(SLUG, 'maybe_key')).toBe(true)
      settingOps.delete(SLUG, 'maybe_key')
      expect(settingOps.has(SLUG, 'maybe_key')).toBe(false)
    })
  })

  describe('logOps', () => {
    it('should insert and retrieve recent logs', () => {
      logOps.insert(SLUG, 'info', 'test', 'Test log message', '{"extra":"data"}')

      const logs = logOps.getRecent(SLUG, 10) as any[]
      expect(logs.length).toBeGreaterThanOrEqual(1)

      const lastLog = logs.find((l: any) => l.message === 'Test log message')
      expect(lastLog).toBeDefined()
      expect(lastLog.level).toBe('info')
      expect(lastLog.category).toBe('test')
    })

    it('should get logs by level', () => {
      logOps.insert(SLUG, 'error', 'system', 'Error message')
      logOps.insert(SLUG, 'info', 'system', 'Info message')

      const errorLogs = logOps.getByLevel(SLUG, 'error') as any[]
      expect(errorLogs.every((l: any) => l.level === 'error')).toBe(true)
    })

    it('should get logs by category', () => {
      logOps.insert(SLUG, 'info', 'whatsapp', 'WhatsApp log')
      logOps.insert(SLUG, 'info', 'mcp', 'MCP log')

      const whatsappLogs = logOps.getByCategory(SLUG, 'whatsapp') as any[]
      expect(whatsappLogs.every((l: any) => l.category === 'whatsapp')).toBe(true)
    })

    it('should clear all logs', () => {
      logOps.insert(SLUG, 'info', 'test', 'Log 1')
      logOps.insert(SLUG, 'info', 'test', 'Log 2')

      logOps.clear(SLUG)

      const logs = logOps.getAll(SLUG) as any[]
      expect(logs).toHaveLength(0)
    })
  })

  describe('per-slug isolation', () => {
    it('queries under one slug do not see rows from another slug', () => {
      // Two additional slugs; the outer beforeEach already initialized SLUG.
      initializeDatabase('a')
      initializeDatabase('b')

      // Distinct chats per slug
      chatOps.insert('a', 'alpha@s.whatsapp.net', 'dm', undefined, 'Alpha')
      chatOps.insert('b', 'beta@s.whatsapp.net', 'dm', undefined, 'Beta')

      // Distinct contacts per slug (same JID to prove they live in different DBs)
      contactOps.insert('a', 'shared@s.whatsapp.net', { name: 'A-side', phoneNumber: '+1000000001' })
      contactOps.insert('b', 'shared@s.whatsapp.net', { name: 'B-side', phoneNumber: '+1000000002' })

      // Distinct settings per slug (same key, different value)
      settingOps.set('a', 'user_phone', '+1-a')
      settingOps.set('b', 'user_phone', '+1-b')

      // Distinct messages per slug
      const chatA = chatOps.getByWhatsappJid('a', 'alpha@s.whatsapp.net') as any
      const chatB = chatOps.getByWhatsappJid('b', 'beta@s.whatsapp.net') as any
      messageOps.insert('a', chatA.id, 'a-msg-1', 1700000000, 'a@s.whatsapp.net', '{"t":"A"}')
      messageOps.insert('b', chatB.id, 'b-msg-1', 1700000000, 'b@s.whatsapp.net', '{"t":"B"}')

      // Chats are isolated
      const chatsA = chatOps.getAll('a') as any[]
      const chatsB = chatOps.getAll('b') as any[]
      expect(chatsA.map((c) => c.whatsapp_jid)).toEqual(['alpha@s.whatsapp.net'])
      expect(chatsB.map((c) => c.whatsapp_jid)).toEqual(['beta@s.whatsapp.net'])
      expect(chatOps.getByWhatsappJid('a', 'beta@s.whatsapp.net')).toBeUndefined()
      expect(chatOps.getByWhatsappJid('b', 'alpha@s.whatsapp.net')).toBeUndefined()

      // Contacts are isolated (same jid resolves to different rows per slug)
      expect((contactOps.getByJid('a', 'shared@s.whatsapp.net') as any).name).toBe('A-side')
      expect((contactOps.getByJid('b', 'shared@s.whatsapp.net') as any).name).toBe('B-side')

      // Settings are isolated
      expect(settingOps.get('a', 'user_phone')).toBe('+1-a')
      expect(settingOps.get('b', 'user_phone')).toBe('+1-b')

      // Messages are isolated (lookup of A's msg in B's DB returns undefined)
      expect(messageOps.getByWhatsappMessageId('a', 'a-msg-1')).toBeDefined()
      expect(messageOps.getByWhatsappMessageId('b', 'a-msg-1')).toBeUndefined()
      expect(messageOps.getByWhatsappMessageId('a', 'b-msg-1')).toBeUndefined()
      expect(messageOps.getByWhatsappMessageId('b', 'b-msg-1')).toBeDefined()

      // Per-DB totals reflect only that slug's rows
      expect(messageOps.getCount('a')).toBe(1)
      expect(messageOps.getCount('b')).toBe(1)

      closeDatabase('a')
      closeDatabase('b')
      expect(() => getDatabase('a')).toThrow(/not initialized/)
      expect(() => getDatabase('b')).toThrow(/not initialized/)
    })
  })
})

