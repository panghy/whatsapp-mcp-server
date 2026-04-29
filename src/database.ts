import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { accountDbPath } from './accounts'

// Per-account database connections keyed by slug.
// Callers (main.ts, sync-orchestrator.ts, mcp-server.ts, etc.) will be updated
// in a follow-up task to thread slugs through their call sites.
const dbs = new Map<string, Database.Database>()

export function initializeDatabase(slug: string): Database.Database {
  const existing = dbs.get(slug)
  if (existing) return existing

  const dbPath = accountDbPath(slug)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  runMigrations(db)
  dbs.set(slug, db)
  return db
}

export function getDatabase(slug: string): Database.Database {
  const db = dbs.get(slug)
  if (!db) {
    throw new Error(
      `Database not initialized for slug "${slug}". Call initializeDatabase("${slug}") first.`
    )
  }
  return db
}

export function closeDatabase(slug: string): void {
  const db = dbs.get(slug)
  if (db) {
    db.close()
    dbs.delete(slug)
  }
}

export function closeAllDatabases(): void {
  for (const db of dbs.values()) {
    db.close()
  }
  dbs.clear()
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

  if (version < 6) {
    applyMigration6(database)
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(6)
  }

  if (version < 7) {
    applyMigration7(database)
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(7)
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
  try { database.exec('ALTER TABLE chats ADD COLUMN name TEXT') } catch { }
  try { database.exec('ALTER TABLE chats ADD COLUMN participant_count INTEGER DEFAULT 0') } catch { }
  try { database.exec('ALTER TABLE chats ADD COLUMN last_activity DATETIME') } catch { }
}

function applyMigration3(database: Database.Database): void {
  try { database.exec('ALTER TABLE chats ADD COLUMN highest_chunk_order INTEGER DEFAULT 0') } catch { }
}

function applyMigration4(database: Database.Database): void {
  try { database.exec('ALTER TABLE contacts ADD COLUMN lid TEXT') } catch { }
  database.exec('CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid)')
}

function applyMigration5(database: Database.Database): void {
  try { database.exec('ALTER TABLE chats ADD COLUMN group_metadata_fetched INTEGER DEFAULT 0') } catch { }
}

// Exposes the tokenizer chosen by applyMigration6 for the most recently
// initialized database. `null` before the first migration runs.
let lastChosenFtsTokenizer: 'trigram' | 'unicode61' | null = null

export function getLastChosenFtsTokenizer(): 'trigram' | 'unicode61' | null {
  return lastChosenFtsTokenizer
}

function detectFtsTokenizer(database: Database.Database): 'trigram' | 'unicode61' {
  try {
    database.exec(`CREATE VIRTUAL TABLE _fts_trigram_probe USING fts5(x, tokenize='trigram')`)
    database.exec('DROP TABLE _fts_trigram_probe')
    return 'trigram'
  } catch {
    try { database.exec('DROP TABLE IF EXISTS _fts_trigram_probe') } catch { }
    return 'unicode61'
  }
}

function applyMigration6(database: Database.Database): void {
  const tokenizer = detectFtsTokenizer(database)
  lastChosenFtsTokenizer = tokenizer

  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
      name,
      tokenize='${tokenizer}'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
      name,
      jid UNINDEXED,
      tokenize='${tokenizer}'
    );
  `)

  const contactCols = database.prepare('PRAGMA table_info(contacts)').all() as { name: string }[]
  if (!contactCols.some((c) => c.name === 'phone_digits')) {
    database.exec(`
      ALTER TABLE contacts ADD COLUMN phone_digits TEXT GENERATED ALWAYS AS (
        CASE WHEN phone_number IS NULL THEN NULL
        ELSE replace(replace(replace(replace(replace(replace(replace(replace(replace(
          phone_number,
          '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '/', ''), '_', ''), CHAR(9), '')
        END
      ) VIRTUAL
    `)
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_contacts_phone_digits ON contacts(phone_digits)')

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS chats_fts_ai AFTER INSERT ON chats BEGIN
      INSERT INTO chats_fts(rowid, name) VALUES (NEW.id, COALESCE(NEW.name, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS chats_fts_au AFTER UPDATE OF name ON chats BEGIN
      DELETE FROM chats_fts WHERE rowid = OLD.id;
      INSERT INTO chats_fts(rowid, name) VALUES (NEW.id, COALESCE(NEW.name, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS chats_fts_ad AFTER DELETE ON chats BEGIN
      DELETE FROM chats_fts WHERE rowid = OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS contacts_fts_ai AFTER INSERT ON contacts BEGIN
      INSERT INTO contacts_fts(name, jid) VALUES (COALESCE(NEW.name, ''), NEW.jid);
    END;
    CREATE TRIGGER IF NOT EXISTS contacts_fts_au AFTER UPDATE OF name ON contacts BEGIN
      DELETE FROM contacts_fts WHERE jid = OLD.jid;
      INSERT INTO contacts_fts(name, jid) VALUES (COALESCE(NEW.name, ''), NEW.jid);
    END;
    CREATE TRIGGER IF NOT EXISTS contacts_fts_ad AFTER DELETE ON contacts BEGIN
      DELETE FROM contacts_fts WHERE jid = OLD.jid;
    END;
  `)

  database.exec(`
    DELETE FROM chats_fts;
    INSERT INTO chats_fts(rowid, name) SELECT id, COALESCE(name, '') FROM chats;

    DELETE FROM contacts_fts;
    INSERT INTO contacts_fts(name, jid) SELECT COALESCE(name, ''), jid FROM contacts;
  `)
}

// One-time backfill for groups inserted with enabled=1 due to the bug where
// the messages.upsert fallback relied on the SQLite column default instead of
// explicitly passing enabled=0. Only touches rows where group_metadata_fetched=0
// so we don't regress groups the user has already interacted with.
function applyMigration7(database: Database.Database): void {
  const result = database.prepare(`
    UPDATE chats
    SET enabled = 0
    WHERE chat_type = 'group' AND group_metadata_fetched = 0 AND enabled = 1
  `).run()
  console.log(`[Migration7] Backfilled enabled=0 on ${result.changes} buggy group row(s)`)
}


// CRUD Operations for messages
export const messageOps = {
  insert: (slug: string, chatId: number, whatsappMessageId: string, timestamp: number, senderJid: string, contentJson: string, hasAttachment: boolean = false) => {
    const stmt = getDatabase(slug).prepare(`
      INSERT OR IGNORE INTO messages (chat_id, whatsapp_message_id, timestamp, sender_jid, content_json, has_attachment)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    return stmt.run(chatId, whatsappMessageId, timestamp, senderJid, contentJson, hasAttachment ? 1 : 0)
  },

  getById: (slug: string, id: number) => {
    return getDatabase(slug).prepare('SELECT * FROM messages WHERE id = ?').get(id)
  },

  getByWhatsappMessageId: (slug: string, whatsappMessageId: string) => {
    return getDatabase(slug).prepare('SELECT * FROM messages WHERE whatsapp_message_id = ?').get(whatsappMessageId)
  },

  getUnpushedByChatId: (slug: string, chatId: number, lastPushedMessageId: number) => {
    return getDatabase(slug).prepare('SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id ASC').all(chatId, lastPushedMessageId)
  },

  getByChatId: (slug: string, chatId: number, limit: number = 100, offset: number = 0) => {
    return getDatabase(slug).prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(chatId, limit, offset)
  },

  getCountByChatId: (slug: string, chatId: number) => {
    const result = getDatabase(slug).prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?').get(chatId) as { count: number }
    return result.count
  },

  delete: (slug: string, id: number) => {
    return getDatabase(slug).prepare('DELETE FROM messages WHERE id = ?').run(id)
  },

  getCount: (slug: string) => {
    const result = getDatabase(slug).prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }
    return result.count
  },

  updateContentJson: (slug: string, whatsappMessageId: string, contentJson: string) => {
    const stmt = getDatabase(slug).prepare('UPDATE messages SET content_json = ? WHERE whatsapp_message_id = ?')
    return stmt.run(contentJson, whatsappMessageId)
  },

  getLatestTimestamp: (slug: string) => {
    const result = getDatabase(slug).prepare('SELECT MAX(timestamp) as max_ts FROM messages').get() as { max_ts: number | null }
    return result?.max_ts || null
  }
}

// CRUD Operations for chats
export const chatOps = {
  insert: (slug: string, whatsappJid: string, chatType: string, backendStreamUuid?: string, name?: string, enabled?: number) => {
    if (enabled !== undefined) {
      const stmt = getDatabase(slug).prepare(`
        INSERT INTO chats (whatsapp_jid, chat_type, backend_stream_uuid, name, enabled)
        VALUES (?, ?, ?, ?, ?)
      `)
      return stmt.run(whatsappJid, chatType, backendStreamUuid || null, name || null, enabled ? 1 : 0)
    }
    const stmt = getDatabase(slug).prepare(`
      INSERT INTO chats (whatsapp_jid, chat_type, backend_stream_uuid, name)
      VALUES (?, ?, ?, ?)
    `)
    return stmt.run(whatsappJid, chatType, backendStreamUuid || null, name || null)
  },

  getById: (slug: string, id: number) => {
    return getDatabase(slug).prepare('SELECT * FROM chats WHERE id = ?').get(id)
  },

  getByWhatsappJid: (slug: string, whatsappJid: string) => {
    return getDatabase(slug).prepare('SELECT * FROM chats WHERE whatsapp_jid = ?').get(whatsappJid)
  },

  getAll: (slug: string) => {
    return getDatabase(slug).prepare('SELECT * FROM chats').all()
  },

  getAllGroups: (slug: string) => {
    return getDatabase(slug).prepare("SELECT * FROM chats WHERE chat_type = 'group'").all()
  },

  updateLastPushedMessageId: (slug: string, chatId: number, messageId: number) => {
    return getDatabase(slug).prepare('UPDATE chats SET last_pushed_message_id = ? WHERE id = ?').run(messageId, chatId)
  },

  updateBackendStreamUuid: (slug: string, chatId: number, uuid: string) => {
    return getDatabase(slug).prepare('UPDATE chats SET backend_stream_uuid = ? WHERE id = ?').run(uuid, chatId)
  },

  updateEnabled: (slug: string, chatId: number, enabled: boolean) => {
    return getDatabase(slug).prepare('UPDATE chats SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, chatId)
  },

  updateName: (slug: string, chatId: number, name: string) => {
    return getDatabase(slug).prepare('UPDATE chats SET name = ? WHERE id = ?').run(name, chatId)
  },

  updateLastActivity: (slug: string, chatId: number, timestamp: string) => {
    return getDatabase(slug).prepare('UPDATE chats SET last_activity = ? WHERE id = ? AND (last_activity IS NULL OR last_activity < ?)').run(timestamp, chatId, timestamp)
  },

  updateHighestChunkOrder: (slug: string, chatId: number, order: number) => {
    return getDatabase(slug).prepare('UPDATE chats SET highest_chunk_order = ? WHERE id = ?').run(order, chatId)
  },

  updateMetadata: (slug: string, chatId: number, updates: { name?: string, lastActivity?: string }) => {
    const fields: string[] = []
    const values: any[] = []
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.lastActivity !== undefined) { fields.push('last_activity = ?'); values.push(updates.lastActivity) }
    if (fields.length === 0) { return { changes: 0 } }
    values.push(chatId)
    const query = `UPDATE chats SET ${fields.join(', ')} WHERE id = ?`
    return getDatabase(slug).prepare(query).run(...values)
  },

  delete: (slug: string, id: number) => {
    return getDatabase(slug).prepare('DELETE FROM chats WHERE id = ?').run(id)
  },

  backfillDmNames: (slug: string) => {
    const query = `
      UPDATE chats SET name = (
        SELECT c.name FROM contacts c WHERE c.jid = chats.whatsapp_jid
      )
      WHERE chat_type = 'dm' AND name IS NULL
      AND EXISTS (SELECT 1 FROM contacts c WHERE c.jid = chats.whatsapp_jid AND c.name IS NOT NULL)
    `
    return getDatabase(slug).prepare(query).run()
  },

  updateGroupMetadataFetched: (slug: string, chatId: number, fetched: boolean) => {
    return getDatabase(slug).prepare('UPDATE chats SET group_metadata_fetched = ? WHERE id = ?').run(fetched ? 1 : 0, chatId)
  },

  getGroupsNeedingMetadata: (slug: string) => {
    return getDatabase(slug).prepare(`
      SELECT * FROM chats
      WHERE chat_type = 'group' AND group_metadata_fetched = 0 AND enabled = 1
    `).all()
  },

  getGroupMetadataFetched: (slug: string, chatId: number): boolean => {
    const row = getDatabase(slug).prepare('SELECT group_metadata_fetched FROM chats WHERE id = ?').get(chatId) as any
    return row?.group_metadata_fetched === 1
  },

  getByJidAndType: (slug: string, whatsappJid: string, chatType: string) => {
    return getDatabase(slug).prepare('SELECT * FROM chats WHERE whatsapp_jid = ? AND chat_type = ?').get(whatsappJid, chatType)
  }
}

// CRUD Operations for contacts
export const contactOps = {
  insert: (slug: string, jid: string, name?: string, phoneNumber?: string, lid?: string) => {
    const stmt = getDatabase(slug).prepare(`
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

  getByJid: (slug: string, jid: string) => {
    return getDatabase(slug).prepare('SELECT * FROM contacts WHERE jid = ?').get(jid)
  },

  getByLid: (slug: string, lid: string) => {
    return getDatabase(slug).prepare('SELECT * FROM contacts WHERE lid = ?').get(lid)
  },

  getByPhone: (slug: string, phone: string) => {
    const normalized = phone.startsWith('+') ? phone.slice(1) : phone
    return getDatabase(slug).prepare(
      "SELECT * FROM contacts WHERE phone_number = ? OR phone_number = ? OR phone_number = ?"
    ).get(phone, normalized, `+${normalized}`)
  },

  getAll: (slug: string) => {
    return getDatabase(slug).prepare('SELECT * FROM contacts').all()
  },

  delete: (slug: string, jid: string) => {
    return getDatabase(slug).prepare('DELETE FROM contacts WHERE jid = ?').run(jid)
  },

  crossResolveLidNames: (slug: string) => {
    return getDatabase(slug).prepare(`
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

  crossResolveDmNames: (slug: string) => {
    return getDatabase(slug).prepare(`
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
  set: (slug: string, key: string, value: string) => {
    const stmt = getDatabase(slug).prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    return stmt.run(key, value)
  },

  get: (slug: string, key: string) => {
    const result = getDatabase(slug).prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return result?.value || null
  },

  getAll: (slug: string) => {
    return getDatabase(slug).prepare('SELECT * FROM settings').all()
  },

  delete: (slug: string, key: string) => {
    return getDatabase(slug).prepare('DELETE FROM settings WHERE key = ?').run(key)
  },

  has: (slug: string, key: string): boolean => {
    const result = getDatabase(slug).prepare('SELECT 1 FROM settings WHERE key = ?').get(key)
    return result !== undefined
  }
}

// CRUD Operations for logs
export const logOps = {
  insert: (slug: string, level: string, category: string, message: string, detailsJson?: string) => {
    const stmt = getDatabase(slug).prepare(`INSERT INTO logs (level, category, message, details_json) VALUES (?, ?, ?, ?)`)
    return stmt.run(level, category, message, detailsJson || null)
  },

  getAll: (slug: string, limit: number = 1000) => {
    return getDatabase(slug).prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?').all(limit)
  },

  getByLevel: (slug: string, level: string, limit: number = 1000) => {
    return getDatabase(slug).prepare('SELECT * FROM logs WHERE level = ? ORDER BY timestamp DESC LIMIT ?').all(level, limit)
  },

  getByCategory: (slug: string, category: string, limit: number = 1000) => {
    return getDatabase(slug).prepare('SELECT * FROM logs WHERE category = ? ORDER BY timestamp DESC LIMIT ?').all(category, limit)
  },

  delete: (slug: string, id: number) => {
    return getDatabase(slug).prepare('DELETE FROM logs WHERE id = ?').run(id)
  },

  deleteOlderThan: (slug: string, days: number) => {
    return getDatabase(slug).prepare(`DELETE FROM logs WHERE timestamp < datetime('now', '-' || ? || ' days')`).run(days)
  },

  getRecent: (slug: string, limit: number = 100) => {
    return getDatabase(slug).prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?').all(limit)
  },

  clear: (slug: string) => {
    return getDatabase(slug).prepare('DELETE FROM logs').run()
  }
}

