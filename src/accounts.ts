import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { setMcpPort, setMcpAutoStart } from './global-settings'

// Account slug: 1 lowercase letter, or 2-32 chars starting with letter,
// ending with letter/digit, body may contain letter/digit/hyphen.
export const SLUG_REGEX = /^(?:[a-z]|[a-z][a-z0-9-]{0,30}[a-z0-9])$/

export const DEFAULT_SLUG = 'default'
export const ACCOUNTS_SCHEMA_VERSION = 1

export interface Account {
  slug: string
  createdAt: string
  mcpEnabled: boolean
}

export interface AccountsRegistry {
  schemaVersion: number
  accounts: Account[]
  defaultSlug: string | null
}

// --- Path helpers (lazy so tests can mock app.getPath) ---

function userDataDir(): string {
  return app.getPath('userData')
}

export function accountsJsonPath(): string {
  return path.join(userDataDir(), 'accounts.json')
}

export function accountsRootDir(): string {
  return path.join(userDataDir(), 'accounts')
}

export function accountDir(slug: string): string {
  return path.join(accountsRootDir(), slug)
}

export function accountAuthDir(slug: string): string {
  return path.join(accountDir(slug), 'whatsapp-auth')
}

export function accountDbPath(slug: string): string {
  return path.join(accountDir(slug), 'nodexa.db')
}

// --- Slug validation ---

export function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_REGEX.test(slug)
}

export function assertValidSlug(slug: string): void {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid account slug: ${JSON.stringify(slug)}. Must match ${SLUG_REGEX.toString()}.`
    )
  }
}

// --- Registry I/O ---

function emptyRegistry(): AccountsRegistry {
  return { schemaVersion: ACCOUNTS_SCHEMA_VERSION, accounts: [], defaultSlug: null }
}

export function loadAccounts(): AccountsRegistry {
  const p = accountsJsonPath()
  if (!fs.existsSync(p)) return emptyRegistry()
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AccountsRegistry>
    return {
      schemaVersion: parsed.schemaVersion ?? ACCOUNTS_SCHEMA_VERSION,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      defaultSlug: parsed.defaultSlug ?? null,
    }
  } catch (err) {
    throw new Error(`Failed to read ${p}: ${(err as Error).message}`)
  }
}

export function saveAccounts(registry: AccountsRegistry): void {
  const p = accountsJsonPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf-8')
  fs.renameSync(tmp, p)
}

// --- CRUD ---

export function listAccounts(): Account[] {
  return loadAccounts().accounts
}

export function getAccount(slug: string): Account | undefined {
  return loadAccounts().accounts.find((a) => a.slug === slug)
}

export function addAccount(slug: string): Account {
  assertValidSlug(slug)
  const registry = loadAccounts()
  if (registry.accounts.some((a) => a.slug === slug)) {
    throw new Error(`Account already exists: ${slug}`)
  }
  const account: Account = {
    slug,
    createdAt: new Date().toISOString(),
    mcpEnabled: true,
  }
  registry.accounts.push(account)
  if (registry.defaultSlug === null) registry.defaultSlug = slug
  fs.mkdirSync(accountAuthDir(slug), { recursive: true })
  saveAccounts(registry)
  return account
}

export function removeAccount(slug: string): void {
  const registry = loadAccounts()
  const idx = registry.accounts.findIndex((a) => a.slug === slug)
  if (idx === -1) throw new Error(`Account not found: ${slug}`)
  registry.accounts.splice(idx, 1)
  if (registry.defaultSlug === slug) {
    registry.defaultSlug = registry.accounts[0]?.slug ?? null
  }
  const dir = accountDir(slug)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  saveAccounts(registry)
}

export function renameAccount(oldSlug: string, newSlug: string): void {
  assertValidSlug(newSlug)
  if (oldSlug === newSlug) return
  const registry = loadAccounts()
  const account = registry.accounts.find((a) => a.slug === oldSlug)
  if (!account) throw new Error(`Account not found: ${oldSlug}`)
  if (registry.accounts.some((a) => a.slug === newSlug)) {
    throw new Error(`Account already exists: ${newSlug}`)
  }
  const oldDir = accountDir(oldSlug)
  const newDir = accountDir(newSlug)
  if (fs.existsSync(oldDir)) {
    fs.mkdirSync(path.dirname(newDir), { recursive: true })
    fs.renameSync(oldDir, newDir)
  } else {
    fs.mkdirSync(newDir, { recursive: true })
  }
  account.slug = newSlug
  if (registry.defaultSlug === oldSlug) registry.defaultSlug = newSlug
  saveAccounts(registry)
}

export function setMcpEnabled(slug: string, enabled: boolean): void {
  const registry = loadAccounts()
  const account = registry.accounts.find((a) => a.slug === slug)
  if (!account) throw new Error(`Account not found: ${slug}`)
  account.mcpEnabled = enabled
  saveAccounts(registry)
}

export function getDefaultSlug(): string | null {
  return loadAccounts().defaultSlug
}

export function setDefaultSlug(slug: string): void {
  const registry = loadAccounts()
  if (!registry.accounts.some((a) => a.slug === slug)) {
    throw new Error(`Account not found: ${slug}`)
  }
  registry.defaultSlug = slug
  saveAccounts(registry)
}

// --- Legacy migration ---

function legacyAuthDir(): string {
  return path.join(userDataDir(), 'whatsapp-auth')
}

function legacyDbPath(): string {
  return path.join(userDataDir(), 'nodexa-whatsapp', 'nodexa.db')
}

function legacyDbDir(): string {
  return path.join(userDataDir(), 'nodexa-whatsapp')
}

function migrationBackupDir(): string {
  return path.join(userDataDir(), 'migration-backup')
}

function dirHasContent(dir: string): boolean {
  if (!fs.existsSync(dir)) return false
  try {
    return fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}

function moveDirContents(src: string, dest: string): void {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src)) {
    fs.renameSync(path.join(src, entry), path.join(dest, entry))
  }
  // Remove the now-empty legacy dir itself
  try { fs.rmdirSync(src) } catch { /* ignore */ }
}

function readLegacyMcpSettings(dbPath: string): { port?: number; autoStart?: boolean } {
  const out: { port?: number; autoStart?: boolean } = {}
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
      .get()
    if (!tbl) return out
    const portRow = db.prepare("SELECT value FROM settings WHERE key='mcp_port'").get() as
      | { value: string }
      | undefined
    const autoRow = db.prepare("SELECT value FROM settings WHERE key='mcp_auto_start'").get() as
      | { value: string }
      | undefined
    if (portRow?.value !== undefined) {
      const n = Number(portRow.value)
      if (Number.isInteger(n) && n > 0 && n <= 65535) out.port = n
    }
    if (autoRow?.value !== undefined) {
      const v = autoRow.value
      if (v === 'true' || v === '1') out.autoStart = true
      else if (v === 'false' || v === '0') out.autoStart = false
    }
    return out
  } finally {
    if (db) db.close()
  }
}

function deleteLegacyMcpRows(dbPath: string): void {
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath)
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
      .get()
    if (!tbl) return
    db.prepare("DELETE FROM settings WHERE key IN ('mcp_port','mcp_auto_start')").run()
  } finally {
    if (db) db.close()
  }
}

function snapshotLegacyLayout(hasLegacyAuth: boolean, hasLegacyDb: boolean): void {
  const dir = migrationBackupDir()
  // Defensive: if a backup folder already exists (unexpected, since migration is
  // idempotency-gated on accounts.json), do not overwrite it.
  if (fs.existsSync(dir)) return
  fs.mkdirSync(dir, { recursive: true })
  if (hasLegacyAuth) {
    fs.cpSync(legacyAuthDir(), path.join(dir, 'whatsapp-auth'), { recursive: true })
  }
  if (hasLegacyDb) {
    fs.cpSync(legacyDbPath(), path.join(dir, 'nodexa.db'))
  }
}

function writeBackupReadme(movedAuth: boolean, movedDb: boolean): void {
  const dir = migrationBackupDir()
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    'WhatsApp MCP Server — legacy layout migration backup',
    '',
    `Performed at: ${new Date().toISOString()}`,
    '',
    'This folder contains a pre-migration snapshot of the legacy data. The',
    'originals have been moved into the new per-account layout under',
    'accounts/default/:',
    '',
    movedAuth
      ? '  - whatsapp-auth/           (copy of the pre-migration whatsapp-auth/)'
      : '  - whatsapp-auth/           (not present on this system)',
    movedDb
      ? '  - nodexa.db                (copy of the pre-migration nodexa-whatsapp/nodexa.db)'
      : '  - nodexa.db                (not present on this system)',
    '',
    'Global MCP settings (mcp_port, mcp_auto_start) were copied out of the',
    "legacy DB's settings table into electron-settings before the move, and",
    'then removed from the moved DB so the per-account settings table only',
    'holds per-account keys. The snapshot nodexa.db above still carries the',
    'original rows untouched.',
    '',
    'To restore from this backup:',
    '  1. Quit the app.',
    '  2. Remove (or move aside) accounts.json and the accounts/ directory in',
    "     this folder's parent (the app's userData directory).",
    '  3. Copy whatsapp-auth/ back to ../whatsapp-auth/ and nodexa.db back to',
    '     ../nodexa-whatsapp/nodexa.db.',
    '  4. Relaunch the app; the migration will run again against the restored',
    '     files.',
    '',
    'Once you are confident the migrated data is healthy, this folder is safe',
    'to delete.',
    '',
  ]
  fs.writeFileSync(path.join(dir, 'README.txt'), lines.join('\n'), 'utf-8')
}

export function migrateLegacyLayoutIfNeeded(): void {
  // Idempotent: if accounts.json already exists, migration has run.
  if (fs.existsSync(accountsJsonPath())) return

  const hasLegacyAuth = dirHasContent(legacyAuthDir())
  const hasLegacyDb = fs.existsSync(legacyDbPath())

  if (!hasLegacyAuth && !hasLegacyDb) {
    // Fresh install — write empty registry and return.
    saveAccounts(emptyRegistry())
    return
  }

  // Pre-read legacy MCP global settings from the legacy DB *before* moving it.
  if (hasLegacyDb) {
    const legacy = readLegacyMcpSettings(legacyDbPath())
    if (legacy.port !== undefined) setMcpPort(legacy.port)
    if (legacy.autoStart !== undefined) setMcpAutoStart(legacy.autoStart)
  }

  // Snapshot the legacy layout into migration-backup/ before any move, so the
  // user can restore from the backup if anything goes wrong.
  snapshotLegacyLayout(hasLegacyAuth, hasLegacyDb)

  // Create target account dirs and move contents.
  const targetAuth = accountAuthDir(DEFAULT_SLUG)
  fs.mkdirSync(targetAuth, { recursive: true })
  if (hasLegacyAuth) {
    moveDirContents(legacyAuthDir(), targetAuth)
  }

  if (hasLegacyDb) {
    const targetDb = accountDbPath(DEFAULT_SLUG)
    fs.mkdirSync(path.dirname(targetDb), { recursive: true })
    fs.renameSync(legacyDbPath(), targetDb)
    // Clean up empty legacy DB dir.
    try {
      if (fs.existsSync(legacyDbDir()) && fs.readdirSync(legacyDbDir()).length === 0) {
        fs.rmdirSync(legacyDbDir())
      }
    } catch { /* ignore */ }
    deleteLegacyMcpRows(targetDb)
  }

  writeBackupReadme(hasLegacyAuth, hasLegacyDb)

  const registry: AccountsRegistry = {
    schemaVersion: ACCOUNTS_SCHEMA_VERSION,
    accounts: [{ slug: DEFAULT_SLUG, createdAt: new Date().toISOString(), mcpEnabled: true }],
    defaultSlug: DEFAULT_SLUG,
  }
  saveAccounts(registry)
}

