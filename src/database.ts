import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import fs from 'fs'

const DATA_DIR = path.join(app.getPath('userData'), 'nodexa-whatsapp')
const DB_PATH = path.join(DATA_DIR, 'nodexa.db')

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

let db: Database.Database | null = null

export function initializeDatabase(): Database.Database {
  if (db) return db

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  // Run migrations
  runMigrations(db)

  return db
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.')
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

function runMigrations(database: Database.Database): void {
  // Create schema_version table if it doesn't exist
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

  const currentVersion = database.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number | null }
  const version = currentVersion.version || 0

  if (version < 1) {
    applyMigration1(database)
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1)
  }

  if (version < 2) {
    applyMigration2(database)
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2)
  }

  if (version < 3) {
    applyMigration3(database)
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3)
  }

  if (version < 4) {
    applyMigration4(database)
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(4)
  }

  if (version < 5) {
    applyMigration5(database)
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(5)
  }
}

function applyMigration1(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      whatsapp_message_id TEXT NOT NULL UNIQUE,
      timestamp INTEGER NOT NULL,
      sender_jid TEXT NOT NULL,
      content_json TEXT NOT NULL,
      has_attachment INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_message_id ON messages(whatsapp_message_id);

    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      whatsapp_jid TEXT NOT NULL UNIQUE,
      chat_type TEXT NOT NULL,
      backend_stream_uuid TEXT,
      name TEXT,
      last_pushed_message_id INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      participant_count INTEGER DEFAULT 0,
      last_activity DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      group_metadata_fetched INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS contacts (
      jid TEXT PRIMARY KEY,
      name TEXT,
      phone_number TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
  `)
}

function applyMigration2(database: Database.Database): void {
  try { database.exec('ALTER TABLE chats ADD COLUMN name TEXT') } catch (error) { }
  try { database.exec('ALTER TABLE chats ADD COLUMN participant_count INTEGER DEFAULT 0') } catch (error) { }
  try { database.exec('ALTER TABLE chats ADD COLUMN last_activity DATETIME') } catch (error) { }
}

function applyMigration3(database: Database.Database): void {
  try { database.exec('ALTER TABLE chats ADD COLUMN highest_chunk_order INTEGER DEFAULT 0') } catch (error) { }
}

function applyMigration4(database: Database.Database): void {
  try { database.exec('ALTER TABLE contacts ADD COLUMN lid TEXT') } catch (error) { }
  database.exec('CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid)')
}

function applyMigration5(database: Database.Database): void {
  try { database.exec('ALTER TABLE chats ADD COLUMN group_metadata_fetched INTEGER DEFAULT 0') } catch (error) { }
}


// CRUD Operations for messages
export const messageOps = {
  insert: (chatId: number, whatsappMessageId: string, timestamp: number, senderJid: string, contentJson: string, hasAttachment: boolean = false) => {
    const stmt = getDatabase().prepare(`
      INSERT INTO messages (chat_id, whatsapp_message_id, timestamp, sender_jid, content_json, has_attachment)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    return stmt.run(chatId, whatsappMessageId, timestamp, senderJid, contentJson, hasAttachment ? 1 : 0)
  },

  getById: (id: number) => {
    return getDatabase().prepare('SELECT * FROM messages WHERE id = ?').get(id)
  },

  getByWhatsappMessageId: (whatsappMessageId: string) => {
    return getDatabase().prepare('SELECT * FROM messages WHERE whatsapp_message_id = ?').get(whatsappMessageId)
  },

  getUnpushedByChatId: (chatId: number, lastPushedMessageId: number) => {
    return getDatabase().prepare('SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id ASC').all(chatId, lastPushedMessageId)
  },

  getByChatId: (chatId: number, limit: number = 100, offset: number = 0) => {
    return getDatabase().prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(chatId, limit, offset)
  },

  getCountByChatId: (chatId: number) => {
    const result = getDatabase().prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?').get(chatId) as { count: number }
    return result.count
  },

  delete: (id: number) => {
    return getDatabase().prepare('DELETE FROM messages WHERE id = ?').run(id)
  },

  getCount: () => {
    const result = getDatabase().prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }
    return result.count
  },

  updateContentJson: (whatsappMessageId: string, contentJson: string) => {
    const stmt = getDatabase().prepare('UPDATE messages SET content_json = ? WHERE whatsapp_message_id = ?')
    return stmt.run(contentJson, whatsappMessageId)
  },

  getLatestTimestamp: () => {
    const result = getDatabase().prepare('SELECT MAX(timestamp) as max_ts FROM messages').get() as { max_ts: number | null }
    return result?.max_ts || null
  }
}

// CRUD Operations for chats
export const chatOps = {
  insert: (whatsappJid: string, chatType: string, backendStreamUuid?: string, name?: string) => {
    const stmt = getDatabase().prepare(`
      INSERT INTO chats (whatsapp_jid, chat_type, backend_stream_uuid, name)
      VALUES (?, ?, ?, ?)
    `)
    return stmt.run(whatsappJid, chatType, backendStreamUuid || null, name || null)
  },

  getById: (id: number) => {
    return getDatabase().prepare('SELECT * FROM chats WHERE id = ?').get(id)
  },

  getByWhatsappJid: (whatsappJid: string) => {
    return getDatabase().prepare('SELECT * FROM chats WHERE whatsapp_jid = ?').get(whatsappJid)
  },

  getAll: () => {
    return getDatabase().prepare('SELECT * FROM chats').all()
  },

  updateLastPushedMessageId: (chatId: number, messageId: number) => {
    return getDatabase().prepare('UPDATE chats SET last_pushed_message_id = ? WHERE id = ?').run(messageId, chatId)
  },

  updateBackendStreamUuid: (chatId: number, uuid: string) => {
    return getDatabase().prepare('UPDATE chats SET backend_stream_uuid = ? WHERE id = ?').run(uuid, chatId)
  },

  updateEnabled: (chatId: number, enabled: boolean) => {
    return getDatabase().prepare('UPDATE chats SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, chatId)
  },

  updateName: (chatId: number, name: string) => {
    return getDatabase().prepare('UPDATE chats SET name = ? WHERE id = ?').run(name, chatId)
  },

  updateLastActivity: (chatId: number, timestamp: string) => {
    return getDatabase().prepare('UPDATE chats SET last_activity = ? WHERE id = ?').run(timestamp, chatId)
  },

  updateHighestChunkOrder: (chatId: number, order: number) => {
    return getDatabase().prepare('UPDATE chats SET highest_chunk_order = ? WHERE id = ?').run(order, chatId)
  },

  updateMetadata: (chatId: number, updates: { name?: string, lastActivity?: string }) => {
    const fields: string[] = []
    const values: any[] = []
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.lastActivity !== undefined) { fields.push('last_activity = ?'); values.push(updates.lastActivity) }
    if (fields.length === 0) { return { changes: 0 } }
    values.push(chatId)
    const query = `UPDATE chats SET ${fields.join(', ')} WHERE id = ?`
    return getDatabase().prepare(query).run(...values)
  },

  delete: (id: number) => {
    return getDatabase().prepare('DELETE FROM chats WHERE id = ?').run(id)
  },

  backfillDmNames: () => {
    const query = `
      UPDATE chats SET name = (
        SELECT c.name FROM contacts c WHERE c.jid = chats.whatsapp_jid
      )
      WHERE chat_type = 'dm' AND name IS NULL
      AND EXISTS (SELECT 1 FROM contacts c WHERE c.jid = chats.whatsapp_jid AND c.name IS NOT NULL)
    `
    return getDatabase().prepare(query).run()
  },

  updateGroupMetadataFetched: (chatId: number, fetched: boolean) => {
    return getDatabase().prepare('UPDATE chats SET group_metadata_fetched = ? WHERE id = ?').run(fetched ? 1 : 0, chatId)
  },

  getGroupsNeedingMetadata: () => {
    return getDatabase().prepare(`
      SELECT * FROM chats
      WHERE chat_type = 'group' AND group_metadata_fetched = 0 AND enabled = 1
    `).all()
  },

  getGroupMetadataFetched: (chatId: number): boolean => {
    const row = getDatabase().prepare('SELECT group_metadata_fetched FROM chats WHERE id = ?').get(chatId) as any
    return row?.group_metadata_fetched === 1
  },

  getByJidAndType: (whatsappJid: string, chatType: string) => {
    return getDatabase().prepare('SELECT * FROM chats WHERE whatsapp_jid = ? AND chat_type = ?').get(whatsappJid, chatType)
  }
}

// CRUD Operations for contacts
export const contactOps = {
  insert: (jid: string, name?: string, phoneNumber?: string, lid?: string) => {
    const stmt = getDatabase().prepare(`
      INSERT INTO contacts (jid, name, phone_number, lid, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        phone_number = COALESCE(excluded.phone_number, phone_number),
        lid = COALESCE(excluded.lid, lid),
        updated_at = CURRENT_TIMESTAMP
    `)
    return stmt.run(jid, name || null, phoneNumber || null, lid || null)
  },

  getByJid: (jid: string) => {
    return getDatabase().prepare('SELECT * FROM contacts WHERE jid = ?').get(jid)
  },

  getByLid: (lid: string) => {
    return getDatabase().prepare('SELECT * FROM contacts WHERE lid = ?').get(lid)
  },

  getByPhone: (phone: string) => {
    const normalized = phone.startsWith('+') ? phone.slice(1) : phone
    return getDatabase().prepare(
      "SELECT * FROM contacts WHERE phone_number = ? OR phone_number = ? OR phone_number = ?"
    ).get(phone, normalized, `+${normalized}`)
  },

  getAll: () => {
    return getDatabase().prepare('SELECT * FROM contacts').all()
  },

  delete: (jid: string) => {
    return getDatabase().prepare('DELETE FROM contacts WHERE jid = ?').run(jid)
  },

  crossResolveLidNames: () => {
    return getDatabase().prepare(`
      UPDATE contacts
      SET name = (
        SELECT dm.name FROM contacts dm
        WHERE dm.phone_number = contacts.phone_number
          AND dm.jid LIKE '%@s.whatsapp.net' AND dm.name IS NOT NULL
      )
      WHERE jid LIKE '%@lid' AND name IS NULL AND phone_number IS NOT NULL
        AND EXISTS (SELECT 1 FROM contacts dm WHERE dm.phone_number = contacts.phone_number
          AND dm.jid LIKE '%@s.whatsapp.net' AND dm.name IS NOT NULL)
    `).run()
  },

  crossResolveDmNames: () => {
    return getDatabase().prepare(`
      UPDATE contacts
      SET name = (
        SELECT lid_c.name FROM contacts lid_c
        WHERE lid_c.phone_number = contacts.phone_number
          AND (lid_c.jid LIKE '%@lid' OR lid_c.jid LIKE '%@hosted.lid')
          AND lid_c.name IS NOT NULL
      )
      WHERE jid LIKE '%@s.whatsapp.net' AND name IS NULL AND phone_number IS NOT NULL
        AND EXISTS (SELECT 1 FROM contacts lid_c WHERE lid_c.phone_number = contacts.phone_number
          AND (lid_c.jid LIKE '%@lid' OR lid_c.jid LIKE '%@hosted.lid') AND lid_c.name IS NOT NULL)
    `).run()
  }
}

// CRUD Operations for settings
export const settingOps = {
  set: (key: string, value: string) => {
    const stmt = getDatabase().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    return stmt.run(key, value)
  },

  get: (key: string) => {
    const result = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return result?.value || null
  },

  getAll: () => {
    return getDatabase().prepare('SELECT * FROM settings').all()
  },

  delete: (key: string) => {
    return getDatabase().prepare('DELETE FROM settings WHERE key = ?').run(key)
  }
}

// CRUD Operations for logs
export const logOps = {
  insert: (level: string, category: string, message: string, detailsJson?: string) => {
    const stmt = getDatabase().prepare(`INSERT INTO logs (level, category, message, details_json) VALUES (?, ?, ?, ?)`)
    return stmt.run(level, category, message, detailsJson || null)
  },

  getAll: (limit: number = 1000) => {
    return getDatabase().prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?').all(limit)
  },

  getByLevel: (level: string, limit: number = 1000) => {
    return getDatabase().prepare('SELECT * FROM logs WHERE level = ? ORDER BY timestamp DESC LIMIT ?').all(level, limit)
  },

  getByCategory: (category: string, limit: number = 1000) => {
    return getDatabase().prepare('SELECT * FROM logs WHERE category = ? ORDER BY timestamp DESC LIMIT ?').all(category, limit)
  },

  delete: (id: number) => {
    return getDatabase().prepare('DELETE FROM logs WHERE id = ?').run(id)
  },

  deleteOlderThan: (days: number) => {
    return getDatabase().prepare(`DELETE FROM logs WHERE timestamp < datetime('now', '-' || ? || ' days')`).run(days)
  },

  getRecent: (limit: number = 100) => {
    return getDatabase().prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?').all(limit)
  },

  clear: () => {
    return getDatabase().prepare('DELETE FROM logs').run()
  }
}

