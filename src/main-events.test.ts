import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import http from 'http'

const { testDir } = vi.hoisted(() => {
  const p = require('path')
  const os = require('os')
  const testDir = p.join(
    os.tmpdir(),
    'wa-main-events-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  )
  return { testDir }
})

vi.mock('electron', () => {
  const app = {
    getPath: () => testDir,
    getVersion: () => '0.0.0-test',
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    quit: () => {},
    focus: () => {},
    dock: { hide: () => {}, show: () => {} },
  }
  const ipcMain = { handle: () => {} }
  const BrowserWindow: any = function () {
    return {
      webContents: { send: vi.fn(), once: vi.fn() },
      on: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn(),
      isVisible: vi.fn(() => false), isMinimized: vi.fn(() => false), isFocused: vi.fn(() => false),
      show: vi.fn(), hide: vi.fn(), focus: vi.fn(), restore: vi.fn(),
      moveTop: vi.fn(), setAlwaysOnTop: vi.fn(),
    }
  }
  const Menu = { buildFromTemplate: () => ({}) }
  const Tray: any = function () { return { setToolTip: () => {}, setContextMenu: () => {}, on: () => {} } }
  const nativeImage = { createFromPath: () => ({ resize: () => ({ setTemplateImage: () => {} }) }) }
  return { app, ipcMain, BrowserWindow, Menu, Tray, nativeImage, default: { app, ipcMain, BrowserWindow, Menu, Tray, nativeImage } }
})

vi.mock('electron-updater', () => {
  const autoUpdater = {
    autoDownload: true, autoInstallOnAppQuit: true,
    on: () => {}, checkForUpdates: async () => ({}), checkForUpdatesAndNotify: async () => ({}),
    quitAndInstall: () => {},
  }
  return { autoUpdater, default: { autoUpdater } }
})

import Settings from 'electron-settings'
import { addAccount } from './accounts'
import { chatOps, contactOps, logOps, messageOps, reactionOps, closeAllDatabases, initializeDatabase } from './database'
import { startMcpServer, stopMcpServer } from './mcp-server'
import { resetSyncOrchestrators } from './sync-orchestrator'
import { resetGroupMetadataFetchers } from './group-metadata-fetcher'

let registerHandlersForSlug: (slug: string, socket: any) => void

const SLUG = 'events-acct'
const LID = '111222333@lid'
const PN = '15551234567@s.whatsapp.net'

function buildFakeSocket() {
  let processCb: ((events: Record<string, any>) => Promise<void> | void) | null = null
  const onListeners: Record<string, ((arg: any) => void)[]> = {}
  return {
    user: { id: PN },
    ev: {
      on: (name: string, cb: (arg: any) => void) => {
        (onListeners[name] ||= []).push(cb)
      },
      process: (cb: (events: Record<string, any>) => Promise<void> | void) => {
        processCb = cb
      },
    },
    fire: async (events: Record<string, any>) => {
      if (!processCb) throw new Error('process() callback was not registered')
      await processCb(events)
    },
    onListeners,
  }
}

function resetUserData(): void {
  try { closeAllDatabases() } catch { /* ignore */ }
  resetSyncOrchestrators()
  resetGroupMetadataFetchers()
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  fs.mkdirSync(testDir, { recursive: true })
  try { Settings.unsetSync() } catch { /* ignore */ }
}

describe('main.ts realtime LID/PN harvesting', () => {
  beforeAll(async () => {
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    resetUserData()
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    const main = await import('./main')
    registerHandlersForSlug = main.registerHandlersForSlug
  })

  beforeEach(() => {
    resetUserData()
    Settings.configure({ dir: testDir, fileName: 'settings.json' })
    addAccount(SLUG)
    initializeDatabase(SLUG)
  })

  afterAll(() => {
    closeAllDatabases()
    Settings.reset()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('full message text preservation', () => {
    const jid = '15550001111@s.whatsapp.net'
    const phone = '+15550001111'
    const timestamp = 1790965860
    // Synthetic only. Distinct tails expose prefix-only comparisons; Unicode
    // covers surrogate pairs, ZWJ emoji, combining marks, and literal escapes.
    function longBody(label: string) {
      const lines = [
        `${label}：${'完整中文訊息測試'.repeat(20)}`,
        '繁體與简体文字 👩🏽‍💻 🧪 𠮷 e\u0301 café "引號" \\n \\路徑\t'.repeat(240),
        '第二段保留 CRLF',
        '第三段保留 CR',
        '',
        `${label}：最後一個字。終 🏁`
      ]
      return {
        text: `${lines[0]}\n${lines[1]}\r\n${lines[2]}\r${lines[3]}\n\n${lines[5]}`,
        compact: lines.join('\\n')
      }
    }

    function storedMessage(id: string) {
      const row = messageOps.getByWhatsappMessageId(SLUG, id) as { content_json: string }
      expect(row).toBeTruthy()
      return JSON.parse(row.content_json)
    }

    function incoming(id: string, message: Record<string, unknown>, offset = 0) {
      return { key: { remoteJid: jid, id, fromMe: false }, messageTimestamp: timestamp + offset, message }
    }

    let port: number
    beforeEach(async () => {
      // Let the OS choose a free port; observe the real server without mocking
      // its behavior or racing other suites for a randomly selected port.
      const createServer = vi.spyOn(http, 'createServer')
      try {
        await startMcpServer(0)
        port = createServer.mock.results[0].value.address().port
      } finally {
        createServer.mockRestore()
      }
    })
    afterEach(async () => { await stopMcpServer() })

    async function history(includeMessageIds = true) {
      // Force the history read to use persisted SQLite content after reopening.
      closeAllDatabases()
      initializeDatabase(SLUG)
      const response = await fetch(`http://127.0.0.1:${port}/mcp/${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'full-text-history', method: 'tools/call',
          params: { name: 'get_chat_history', arguments: { jid, includeMessageIds, limit: 128 } }
        }),
        signal: AbortSignal.timeout(2000)
      })
      expect(response.status).toBe(200)
      const body = await response.text()
      const events = body.replace(/\r\n/g, '\n').split('\n\n')
      expect(events.pop()).toBe('')
      const replies = events.flatMap(event => {
        const data = event.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n')
        return data ? [JSON.parse(data)] : []
      })
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ jsonrpc: '2.0', id: 'full-text-history' })
      expect(replies[0].error).toBeUndefined()
      expect(replies[0].result.isError).not.toBe(true)
      function expectWellFormedStrings(value: unknown): void {
        if (typeof value === 'string') expect(value).not.toMatch(/[\uD800-\uDFFF]/u)
        else if (value && typeof value === 'object') Object.values(value).forEach(expectWellFormedStrings)
      }
      expectWellFormedStrings(replies[0])
      return replies[0].result
    }

    it.each(['messages.upsert', 'messaging-history.set'])('preserves complete bodies from %s through storage and HTTP', async event => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      const bodies = [longBody('普通文字'), longBody('延伸文字'), longBody('限時文字')]
      const messages = [
        incoming('long-conversation', { conversation: bodies[0].text }),
        incoming('long-extended', { extendedTextMessage: { text: bodies[1].text } }, 1),
        incoming('long-ephemeral', { ephemeralMessage: { message: { extendedTextMessage: { text: bodies[2].text } } } }, 2)
      ]
      if (event === 'messaging-history.set') {
        const { proto, processHistoryMessage } = await import('@whiskeysockets/baileys')
        const sync = proto.HistorySync.fromObject({
          syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
          conversations: [{ id: jid, messages: messages.map(message => ({ message })) }]
        })
        const decoded = proto.HistorySync.decode(proto.HistorySync.encode(sync).finish())
        const processed = processHistoryMessage(decoded)
        await sock.fire({ [event]: { ...processed, isLatest: false, syncType: decoded.syncType } })
      } else {
        await sock.fire({ [event]: { type: 'notify', messages } })
      }

      expect(messageOps.getCount(SLUG)).toBe(3)
      for (const [index, message] of messages.entries()) {
        expect(storedMessage(message.key.id).text).toBe(bodies[index].text)
      }
      for (const includeIds of [false, true]) {
        const result = await history(includeIds)
        expect(result.structuredContent.messages.map((message: any) => message.text)).toEqual(bodies.map(body => body.text))
        expect(result.structuredContent.messages.map((message: any) => message.messageId))
          .toEqual(messages.map(message => includeIds ? message.key.id : undefined))
        expect(result.content[0].text.split('\n').slice(1)).toEqual(bodies.map(body => `${phone} > ${body.compact}`))
      }
    })

    it.each(['conversation', 'extendedTextMessage', 'editedMessage'])('preserves full original and replacement text for %s edits', async variant => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      const original = longBody('修改之前')
      const replacement = longBody('修改之後')
      const message = incoming('long-edit-target', { conversation: original.text })
      await sock.fire({ 'messages.upsert': { type: 'notify', messages: [message] } })
      expect(storedMessage(message.key.id).text).toBe(original.text)

      const edit = variant === 'conversation' ? { conversation: replacement.text }
        : variant === 'extendedTextMessage' ? { extendedTextMessage: { text: replacement.text } }
          : { editedMessage: { message: { extendedTextMessage: { text: replacement.text } } } }
      await sock.fire({ 'messages.update': [{ key: message.key, update: { message: edit } }] })
      expect(storedMessage(message.key.id).text).toBe(replacement.text)
      const chat = chatOps.getByWhatsappJid(SLUG, jid) as { id: number }
      const rows = messageOps.getByChatId(SLUG, chat.id, 10) as { content_json: string }[]
      expect(rows).toHaveLength(2)
      const storedEdit = rows.map(row => JSON.parse(row.content_json)).find(row => row.type === 'message_edited')
      expect(storedEdit.editedMessage).toMatchObject({ originalText: original.text, newText: replacement.text })

      const result = await history()
      expect(result.structuredContent.messages).toHaveLength(2)
      expect(result.structuredContent.messages[0]).toMatchObject({ messageId: message.key.id, text: replacement.text })
      expect(result.structuredContent.messages[1].editedMessage).toMatchObject({
        messageId: message.key.id, originalText: original.text, newText: replacement.text
      })
      const compactLines = result.content[0].text.split('\n')
      expect(compactLines).toContain(`${phone} > ${replacement.compact}`)
      expect(compactLines).toContain(`[edited] "${original.compact}" → "${replacement.compact}" (by ${phone})`)
    })

    it.each([18, 19, 20, 48, 49, 50].flatMap(prefixLength =>
      ['😀', '𠮷'].map(character => ({ prefixLength, character }))
    ))('preserves Unicode at preview boundaries: $prefixLength + $character', async ({ prefixLength, character }) => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      const prefix = 'a'.repeat(prefixLength)
      const original = prefix + character + 'z'.repeat(60)
      const reply = 'Complete reply 🧪 終'
      await sock.fire({ 'messages.upsert': { type: 'notify', messages: [
        incoming('unicode-original', { conversation: original }),
        incoming('unicode-reply', { extendedTextMessage: { text: reply, contextInfo: { stanzaId: 'unicode-original' } } }, 1)
      ] } })
      const result = await history()
      const expected50 = prefixLength === 49 ? prefix
        : prefixLength >= 50 ? 'a'.repeat(50)
          : prefix + character + 'z'.repeat(50 - prefixLength - 2)
      const expected20 = prefixLength === 19 ? prefix
        : prefixLength >= 20 ? 'a'.repeat(20) : prefix + character
      expect(result.structuredContent.messages.map((message: any) => [message.messageId, message.text]))
        .toEqual([['unicode-original', original], ['unicode-reply', reply]])
      expect(result.structuredContent.messages[1].replyTo).toMatchObject({ messageId: 'unicode-original', preview: expected50 })
      expect(result.content[0].text.split('\n').slice(1)).toEqual([
        `${phone} > ${original}`, `${phone} > [re ${phone}: "${expected20}..."] ${reply}`
      ])
      expect(storedMessage('unicode-original').text).toBe(original)
      expect(storedMessage('unicode-reply')).toMatchObject({ text: reply, replyToMessageId: 'unicode-original' })
    })

    it.each(['legacy split', 'complete pair', 'custom preview'])(
      'handles a populated %s without changing stored content', async variant => {
        const sock = buildFakeSocket()
        registerHandlersForSlug(SLUG, sock)
        const fullText = 'a'.repeat(49) + '😀tail'
        const preview = variant === 'legacy split' ? 'a'.repeat(49) + '\uD83D'
          : variant === 'complete pair' ? 'a'.repeat(48) + '😀' : 'Custom preview 🧪'
        await sock.fire({ 'messages.upsert': { type: 'notify', messages: [incoming('populated-reply', { conversation: 'Reply body 😀' })] } })
        const stored = storedMessage('populated-reply')
        stored.replyTo = { messageId: 'absent-original', senderName: 'Quoted', senderPhone: null, fullText, preview }
        messageOps.updateContentJson(SLUG, 'populated-reply', JSON.stringify(stored))
        const result = await history()
        expect(result.structuredContent.messages[0]).toMatchObject({
          messageId: 'populated-reply', text: stored.text,
          replyTo: { messageId: 'absent-original', preview: variant === 'legacy split' ? 'a'.repeat(49) : preview }
        })
        expect(storedMessage('populated-reply')).toEqual(stored)
      }
    )

    it('shortens only reply previews while retaining both full bodies', async () => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      const original = longBody('被引用的原文')
      const reply = longBody('完整回覆內容')
      await sock.fire({ 'messages.upsert': { type: 'notify', messages: [
        incoming('long-quoted', { conversation: original.text }),
        incoming('long-reply', { extendedTextMessage: { text: reply.text, contextInfo: { stanzaId: 'long-quoted' } } }, 1)
      ] } })
      expect(storedMessage('long-quoted').text).toBe(original.text)
      expect(storedMessage('long-reply')).toMatchObject({ text: reply.text, replyToMessageId: 'long-quoted' })

      const result = await history()
      expect(result.structuredContent.messages.map((message: any) => message.text)).toEqual([original.text, reply.text])
      expect(result.structuredContent.messages[1].replyTo).toMatchObject({
        messageId: 'long-quoted', preview: '被引用的原文：' + '完整中文訊息測試'.repeat(5) + '完整中'
      })
      expect(result.content[0].text.split('\n').slice(1)).toEqual([
        `${phone} > ${original.compact}`,
        `${phone} > [re ${phone}: "被引用的原文：完整中文訊息測試完整中文訊..."] ${reply.compact}`
      ])
      // Read-time preview construction must not replace the persisted body.
      expect(storedMessage('long-quoted').text).toBe(original.text)
      expect(storedMessage('long-reply').text).toBe(reply.text)
    })
  })

  it('persists rows from contacts.upsert', async () => {
    const sock = buildFakeSocket()
    registerHandlersForSlug(SLUG, sock)
    await sock.fire({
      'contacts.upsert': [{ id: PN, lid: LID, name: 'Carol' }],
    })
    const pnRow = contactOps.getByJid(SLUG, PN) as any
    expect(pnRow).toBeTruthy()
    expect(pnRow.lid).toBe(LID)
    expect(pnRow.name).toBe('Carol')
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
  })

  it('persists rows from contacts.update (Partial<Contact>)', async () => {
    const sock = buildFakeSocket()
    registerHandlersForSlug(SLUG, sock)
    await sock.fire({
      'contacts.update': [{ id: PN, lid: LID }],
    })
    expect((contactOps.getByJid(SLUG, PN) as any).lid).toBe(LID)
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
  })

  it('harvests LID↔PN from messages.upsert keys before processing', async () => {
    const sock = buildFakeSocket()
    registerHandlersForSlug(SLUG, sock)
    await sock.fire({
      'messages.upsert': {
        type: 'notify',
        messages: [{
          key: { remoteJid: 'group@g.us', participant: LID, participantAlt: PN, addressingMode: 'lid', id: 'M1' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        }],
      },
    })
    expect((contactOps.getByJid(SLUG, PN) as any)?.lid).toBe(LID)
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
  })

  it('persists pair on lid-mapping.update', async () => {
    const sock = buildFakeSocket()
    registerHandlersForSlug(SLUG, sock)
    await sock.fire({ 'lid-mapping.update': { lid: LID, pn: PN } })
    expect((contactOps.getByJid(SLUG, PN) as any)?.lid).toBe(LID)
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
  })

  it('contacts.update with notify does not overwrite the address-book name from a prior contacts.upsert', async () => {
    const sock = buildFakeSocket()
    registerHandlersForSlug(SLUG, sock)
    // First the address-book name arrives via contacts.upsert.
    await sock.fire({
      'contacts.upsert': [{ id: PN, name: 'Address Book' }],
    })
    // Later, the push-name arrives separately via contacts.update.
    await sock.fire({
      'contacts.update': [{ id: PN, notify: 'Cryptic Push' }],
    })
    const row = contactOps.getByJid(SLUG, PN) as any
    expect(row).toBeTruthy()
    expect(row.name).toBe('Address Book')
    expect(row.push_name).toBe('Cryptic Push')
  })

  describe('reaction ingestion', () => {
    const OTHER = '15559876543@s.whatsapp.net'
    const nowSec = () => Math.floor(Date.now() / 1000)

    function reactionMsg(id: string, targetId: string, text: string, opts: { fromMe?: boolean; remoteJid?: string; participant?: string } = {}) {
      return {
        key: { remoteJid: opts.remoteJid ?? OTHER, fromMe: opts.fromMe ?? false, id, participant: opts.participant },
        messageTimestamp: nowSec(),
        message: { reactionMessage: { key: { remoteJid: opts.remoteJid ?? OTHER, fromMe: false, id: targetId }, text, senderTimestampMs: Date.now() } },
      }
    }

    it('messages.upsert with a reactionMessage stores one reaction row and no messages row', async () => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      await sock.fire({
        'messages.upsert': {
          type: 'notify',
          messages: [{ key: { remoteJid: OTHER, fromMe: false, id: 'T1' }, messageTimestamp: nowSec(), message: { conversation: 'hi' } }],
        },
      })
      const before = messageOps.getCount(SLUG)

      await sock.fire({ 'messages.upsert': { type: 'notify', messages: [reactionMsg('R1', 'T1', '👍')] } })

      expect(messageOps.getCount(SLUG)).toBe(before)
      expect(messageOps.getByWhatsappMessageId(SLUG, 'R1')).toBeUndefined()
      const rows = reactionOps.getByTargetMessageIds(SLUG, ['T1'])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ target_message_id: 'T1', reactor_jid: OTHER, emoji: '👍', is_from_me: 0 })
    })

    it('from-me reaction in a DM is stored under the own JID with is_from_me = 1', async () => {
      const sock = buildFakeSocket()
      sock.user = { id: '15551234567:3@s.whatsapp.net' }
      registerHandlersForSlug(SLUG, sock)
      await sock.fire({ 'messages.upsert': { type: 'notify', messages: [reactionMsg('R1', 'T1', '❤️', { fromMe: true })] } })
      const rows = reactionOps.getByTargetMessageIds(SLUG, ['T1'])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ reactor_jid: PN, is_from_me: 1, emoji: '❤️' })
    })

    it('messaging-history.set with a reactionMessage in messages persists the reaction', async () => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      await sock.fire({
        'messaging-history.set': {
          chats: [], contacts: [], isLatest: false, syncType: 1, progress: 10,
          messages: [reactionMsg('R1', 'T-history', '🔥')],
        },
      })
      const rows = reactionOps.getByTargetMessageIds(SLUG, ['T-history'])
      expect(rows).toHaveLength(1)
      expect(rows[0].emoji).toBe('🔥')
      expect(messageOps.getCount(SLUG)).toBe(0)
    })

    it('messaging-history.set persists reactions embedded in WebMessageInfo.reactions[] (round-tripped through Baileys)', async () => {
      const { proto, processHistoryMessage } = await import('@whiskeysockets/baileys')
      const GROUP = 'group-1@g.us'
      const BOB = '15551112222@s.whatsapp.net'
      const historySync = proto.HistorySync.fromObject({
        syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
        conversations: [{
          id: GROUP,
          messages: [{
            message: {
              key: { remoteJid: GROUP, fromMe: false, id: 'T-EMB', participant: OTHER },
              messageTimestamp: 1700000000,
              message: { conversation: 'target' },
              reactions: [
                { key: { remoteJid: GROUP, fromMe: false, id: 'R-1', participant: BOB }, text: '👍', senderTimestampMs: 1700000001000 },
                { key: { remoteJid: GROUP, fromMe: true, id: 'R-2' }, text: '❤️', senderTimestampMs: 1700000002000 },
              ],
            },
          }],
        }],
      })
      const decoded = proto.HistorySync.decode(proto.HistorySync.encode(historySync).finish())
      const processed = processHistoryMessage(decoded)
      expect(processed.messages).toHaveLength(1)
      expect(processed.messages[0].reactions).toHaveLength(2)

      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      await sock.fire({
        'messaging-history.set': {
          chats: processed.chats, contacts: processed.contacts, messages: processed.messages,
          isLatest: false, syncType: decoded.syncType, progress: 10,
        },
      })

      expect(messageOps.getByWhatsappMessageId(SLUG, 'T-EMB')).toBeTruthy()
      expect(messageOps.getCount(SLUG)).toBe(1)
      const rows = reactionOps.getByTargetMessageIds(SLUG, ['T-EMB'])
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ reactor_jid: BOB, emoji: '👍', is_from_me: 0, timestamp: 1700000001000 })
      expect(rows[1]).toMatchObject({ reactor_jid: PN, emoji: '❤️', is_from_me: 1, timestamp: 1700000002000 })
    })
  })

  describe('sync-health diagnostics logging', () => {
    const syncHealthLogs = () => logOps.getByCategory(SLUG, 'sync-health') as any[]

    it('logs chats.update entries carrying unreadCount', async () => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      await sock.fire({
        'chats.update': [{ id: PN, unreadCount: 0 }, { id: 'other@s.whatsapp.net' }],
      })
      const logs = syncHealthLogs()
      expect(logs.length).toBe(1)
      expect(logs[0].level).toBe('info')
      expect(logs[0].message).toContain('chats.update: 1 unread-count change(s)')
      expect(logs[0].message).toContain(`${PN} -> 0`)
    })

    it('logs messages.update read-status changes', async () => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      await sock.fire({
        'messages.update': [
          { key: { remoteJid: PN, id: 'M1' }, update: { status: 4 } },
          { key: { remoteJid: PN, id: 'M2' }, update: { status: 3 } },
        ],
      })
      const logs = syncHealthLogs()
      expect(logs.length).toBe(1)
      expect(logs[0].message).toContain('messages.update: 2 delivery/read status change(s)')
      expect(logs[0].message).toContain('1 read')
    })

    it('logs message-receipt.update summaries', async () => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      await sock.fire({
        'message-receipt.update': [
          { key: { remoteJid: PN, id: 'M1' }, receipt: { userJid: PN, readTimestamp: 1234 } },
          { key: { remoteJid: PN, id: 'M2' }, receipt: { userJid: PN, receiptTimestamp: 1234 } },
        ],
      })
      const logs = syncHealthLogs()
      expect(logs.length).toBe(1)
      expect(logs[0].message).toContain('message-receipt.update: 2 receipt(s)')
      expect(logs[0].message).toContain('1 read')
    })

    it('rate-bounds repeated events of the same kind into a single log row', async () => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      await sock.fire({ 'chats.update': [{ id: PN, unreadCount: 2 }] })
      await sock.fire({ 'chats.update': [{ id: PN, unreadCount: 0 }] })
      await sock.fire({ 'chats.update': [{ id: PN, unreadCount: 1 }] })
      expect(syncHealthLogs().length).toBe(1)
    })

    it('logs connection close errors at warn', async () => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      for (const cb of sock.onListeners['connection.update'] || []) {
        await cb({ connection: 'close', lastDisconnect: { error: new Error('Connection Failure') } })
      }
      const logs = syncHealthLogs()
      expect(logs.length).toBe(1)
      expect(logs[0].level).toBe('warn')
      expect(logs[0].message).toContain('Connection Failure')
    })

    it('does not log a sync-health row on a clean connection close', async () => {
      const sock = buildFakeSocket()
      registerHandlersForSlug(SLUG, sock)
      for (const cb of sock.onListeners['connection.update'] || []) {
        await cb({ connection: 'close' })
      }
      expect(syncHealthLogs().length).toBe(0)
    })
  })
})

