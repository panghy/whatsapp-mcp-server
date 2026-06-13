import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import http from 'http'
import crypto from 'crypto'

// Hoisted tmpdir so the electron mock (also hoisted) can see it.
const testDir = vi.hoisted(() => {
  const p = require('path')
  const os = require('os')
  return p.join(os.tmpdir(), 'mcp-media-int-' + Date.now() + '-' + Math.random().toString(36).slice(2))
})

// Use a port range disjoint from src/mcp-server.test.ts (50000-60000) so the
// two files don't race for the same port when vitest runs them in parallel.
let testPort = vi.hoisted(() => 62000 + Math.floor(Math.random() * 3000))

vi.mock('electron', () => ({
  app: { getPath: () => testDir }
}))

const mockDownloadMediaMessage = vi.fn(async () => Buffer.from('mock-media-bytes'))
vi.mock('@whiskeysockets/baileys', () => ({
  proto: {},
  downloadMediaMessage: mockDownloadMediaMessage
}))

// Imports happen after the mocks are registered above.
import Settings from 'electron-settings'
import { initializeDatabase, closeAllDatabases, chatOps, messageOps } from './database'
import { addAccount, accountDir } from './accounts'
import { setManager, listManagers } from './whatsapp-manager'
import {
  startMcpServer,
  stopMcpServer,
  refreshAccount,
  setMaxInlineToolBytesForTesting,
  resolveMedia
} from './mcp-server'

const DEFAULT = 'default'
const PATH = require('path')

// --- HTTP helpers ----------------------------------------------------------

function rawGet(port: number, p: string, method: string = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
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
  const response: { status: number; body: string } = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: mcpPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.write(JSON.stringify(jsonRpcRequest))
    req.end()
  })
  const dataMatch = response.body.match(/data: (.+)\n/)
  if (dataMatch) return JSON.parse(dataMatch[1])
  return JSON.parse(response.body)
}

// --- World reset + account helpers ----------------------------------------

function resetWorld(): void {
  closeAllDatabases()
  listManagers().clear()
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  fs.mkdirSync(testDir, { recursive: true })
  try { Settings.unsetSync() } catch { /* ignore */ }
  testPort = 62000 + Math.floor(Math.random() * 3000)
}

function makeAccount(slug: string): void {
  addAccount(slug)
  initializeDatabase(slug)
  refreshAccount(slug)
}

// --- Media fixture helpers ------------------------------------------------

type Kind = 'image' | 'voice' | 'audio' | 'video' | 'document' | 'sticker'

interface SeedOpts {
  /** When true, store the payload under `rawMessage` (v1.6.0 layout). When
   *  false, the row has no `*Message` field anywhere (legacy v1.5.x shape
   *  with no recoverable media metadata). */
  includeRawMessage?: boolean
  /** When provided, also write the bytes under `<accountDir>/attachments/<id>/<filename>`. */
  includeCachedFile?: { bytes: Buffer; filename: string } | null
  /** Overrides merged into the media payload (e.g. `fileLength`, `seconds`, `fileName`). */
  payloadOverrides?: Record<string, unknown>
}

const KIND_DEFAULTS: Record<Kind, { messageKey: string; mimetype: string; ext: string; extra?: Record<string, unknown> }> = {
  image:    { messageKey: 'imageMessage',    mimetype: 'image/jpeg', ext: 'jpg' },
  voice:    { messageKey: 'audioMessage',    mimetype: 'audio/ogg; codecs=opus', ext: 'ogg', extra: { ptt: true, seconds: 7 } },
  audio:    { messageKey: 'audioMessage',    mimetype: 'audio/mpeg', ext: 'mp3', extra: { seconds: 30 } },
  video:    { messageKey: 'videoMessage',    mimetype: 'video/mp4',  ext: 'mp4', extra: { seconds: 12 } },
  document: { messageKey: 'documentMessage', mimetype: 'application/pdf', ext: 'pdf' },
  sticker:  { messageKey: 'stickerMessage',  mimetype: 'image/webp', ext: 'webp' }
}

function defaultFilename(kind: Kind, msgId: string): string {
  return `${kind}_${msgId}.${KIND_DEFAULTS[kind].ext}`
}

function seedMediaRow(slug: string, msgId: string, kind: Kind, opts: SeedOpts = {}): void {
  const chatJid = `${kind}chat-${msgId}@s.whatsapp.net`
  chatOps.insert(slug, chatJid, 'dm', undefined, `Chat for ${msgId}`)
  const chat = chatOps.getByWhatsappJid(slug, chatJid) as any

  const meta = KIND_DEFAULTS[kind]
  const payload: Record<string, unknown> = {
    mimetype: meta.mimetype,
    fileLength: opts.payloadOverrides?.fileLength ?? (opts.includeCachedFile?.bytes.length ?? 1024),
    ...(meta.extra || {}),
    ...(opts.payloadOverrides || {})
  }

  const envelope: Record<string, unknown> = {
    type: 'message', messageId: msgId, timestamp: new Date().toISOString(),
    sender: { name: 'Sender', phone: '+15551234567' }
  }
  if (opts.includeRawMessage) {
    envelope.rawMessage = { [meta.messageKey]: payload }
  }

  messageOps.insert(slug, chat.id, msgId, Date.now(), 'sender@s.whatsapp.net', JSON.stringify(envelope), true)

  if (opts.includeCachedFile) {
    const dir = PATH.join(accountDir(slug), 'attachments', msgId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(PATH.join(dir, opts.includeCachedFile.filename), opts.includeCachedFile.bytes)
  }
}

/** Seed a row whose `content_json` is not valid JSON. */
function seedMalformedRow(slug: string, msgId: string): void {
  const chatJid = `malformed-${msgId}@s.whatsapp.net`
  chatOps.insert(slug, chatJid, 'dm', undefined, 'Malformed Chat')
  const chat = chatOps.getByWhatsappJid(slug, chatJid) as any
  messageOps.insert(slug, chat.id, msgId, Date.now(), 'sender@s.whatsapp.net', '{not-json', true)
}

// --- Suite ----------------------------------------------------------------

describe('resolveMedia + /media route — integration coverage', () => {
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
    makeAccount(DEFAULT)
    mockDownloadMediaMessage.mockClear()
    setMaxInlineToolBytesForTesting(null)
  })

  afterEach(async () => {
    setMaxInlineToolBytesForTesting(null)
    await stopMcpServer().catch(() => { /* ignore */ })
  })

  // 1. Happy path, image, cache hit (v1.6.0 row w/ rawMessage).
  it('case #1: image cache hit — direct resolveMedia + HTTP /media', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    seedMediaRow(DEFAULT, 'IMG1', 'image', {
      includeRawMessage: true,
      includeCachedFile: { bytes, filename: defaultFilename('image', 'IMG1') },
      payloadOverrides: { mimetype: 'image/jpeg', fileLength: bytes.length }
    })

    const direct = await resolveMedia(DEFAULT, 'IMG1')
    expect(direct.ok).toBe(true)
    if (direct.ok) {
      expect(direct.media.kind).toBe('image')
      expect(direct.media.mimeType).toBe('image/jpeg')
      expect(direct.media.fileSize).toBe(bytes.length)
      expect(direct.media.filename).toBe('image_IMG1.jpg')
    }
    expect(mockDownloadMediaMessage).not.toHaveBeenCalled()

    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/default/IMG1')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('image/jpeg')
    expect(r.headers['content-length']).toBe(String(bytes.length))
    expect(r.body.equals(bytes)).toBe(true)
    expect(mockDownloadMediaMessage).not.toHaveBeenCalled()
  })

  // 2. Voice note (audioMessage + ptt:true) cache hit.
  it('case #2: voice note cache hit → kind="voice", durationSeconds populated', async () => {
    const bytes = Buffer.from('ogg-voice-bytes')
    seedMediaRow(DEFAULT, 'VOX1', 'voice', {
      includeRawMessage: true,
      includeCachedFile: { bytes, filename: defaultFilename('voice', 'VOX1') },
      payloadOverrides: { seconds: 9, fileLength: bytes.length }
    })

    const direct = await resolveMedia(DEFAULT, 'VOX1')
    expect(direct.ok).toBe(true)
    if (direct.ok) {
      expect(direct.media.kind).toBe('voice')
      expect(direct.media.mimeType).toBe('audio/ogg; codecs=opus')
      expect(direct.media.durationSeconds).toBe(9)
    }

    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/default/VOX1')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('audio/ogg; codecs=opus')
    expect(r.body.equals(bytes)).toBe(true)
  })

  // 3. Video cache hit (well under 25 MB).
  it('case #3: video cache hit', async () => {
    const bytes = Buffer.alloc(4096, 0x42)
    seedMediaRow(DEFAULT, 'VID1', 'video', {
      includeRawMessage: true,
      includeCachedFile: { bytes, filename: defaultFilename('video', 'VID1') },
      payloadOverrides: { fileLength: bytes.length }
    })

    const direct = await resolveMedia(DEFAULT, 'VID1')
    expect(direct.ok).toBe(true)
    if (direct.ok) {
      expect(direct.media.kind).toBe('video')
      expect(direct.media.mimeType).toBe('video/mp4')
      expect(direct.media.fileSize).toBe(bytes.length)
    }

    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/default/VID1')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('video/mp4')
    expect(r.body.length).toBe(bytes.length)
  })

  // 4. Document with `fileName` preserved.
  it('case #4: document cache hit preserves fileName from payload', async () => {
    const bytes = Buffer.from('%PDF-1.4\n...')
    const filename = 'Q3-Report.pdf'
    seedMediaRow(DEFAULT, 'DOC1', 'document', {
      includeRawMessage: true,
      includeCachedFile: { bytes, filename },
      payloadOverrides: { fileName: filename, fileLength: bytes.length }
    })

    const direct = await resolveMedia(DEFAULT, 'DOC1')
    expect(direct.ok).toBe(true)
    if (direct.ok) {
      expect(direct.media.kind).toBe('document')
      expect(direct.media.filename).toBe(filename)
      expect(direct.media.mimeType).toBe('application/pdf')
    }

    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/default/DOC1')
    expect(r.status).toBe(200)
    expect(r.headers['content-disposition']).toContain('Q3-Report.pdf')
    expect(r.body.equals(bytes)).toBe(true)
  })

  // 5. Sticker cache hit → image/webp.
  it('case #5: sticker cache hit → mimeType image/webp', async () => {
    const bytes = Buffer.from('webp-sticker')
    seedMediaRow(DEFAULT, 'STK1', 'sticker', {
      includeRawMessage: true,
      includeCachedFile: { bytes, filename: defaultFilename('sticker', 'STK1') },
      payloadOverrides: { fileLength: bytes.length }
    })

    const direct = await resolveMedia(DEFAULT, 'STK1')
    expect(direct.ok).toBe(true)
    if (direct.ok) {
      expect(direct.media.kind).toBe('sticker')
      expect(direct.media.mimeType).toBe('image/webp')
    }

    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/default/STK1')
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('image/webp')
    expect(r.body.equals(bytes)).toBe(true)
  })

  // 6. Cache miss with rawMessage → lazy download writes file; second call is cache hit.
  it('case #6: cache miss with rawMessage triggers lazy download once; second call is cache hit; mediaKey BufferMarker is rehydrated', async () => {
    const mediaKeyB64 = Buffer.from([10, 20, 30, 40, 50]).toString('base64')
    seedMediaRow(DEFAULT, 'LAZY1', 'image', {
      includeRawMessage: true,
      includeCachedFile: null,
      payloadOverrides: {
        mimetype: 'image/jpeg',
        fileLength: 16,
        // BufferMarker shape that restoreBuffersInPlace must rehydrate.
        mediaKey: { type: 'Buffer', data: mediaKeyB64 },
        url: 'https://mmg.whatsapp.net/m/v/t62/lazy.enc',
        directPath: '/v/t62/lazy.enc'
      }
    })
    setManager(DEFAULT, { socket: { sendMessage: vi.fn() } } as any)

    let captured: any = null
    ;(mockDownloadMediaMessage as any).mockImplementationOnce(async (m: any) => {
      captured = m
      return Buffer.from('downloaded-image-bytes')
    })

    const first = await resolveMedia(DEFAULT, 'LAZY1')
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.media.kind).toBe('image')
      // File must now exist on disk under the cached attachments path.
      const cached = PATH.join(accountDir(DEFAULT), 'attachments', 'LAZY1', 'image_LAZY1.jpg')
      expect(fs.existsSync(cached)).toBe(true)
      expect(fs.readFileSync(cached).toString()).toBe('downloaded-image-bytes')
    }
    expect(mockDownloadMediaMessage).toHaveBeenCalledTimes(1)

    // The Baileys mock received a reconstructed message whose mediaKey is a real Buffer.
    expect(captured).not.toBeNull()
    const restoredKey = captured.message.imageMessage.mediaKey
    expect(Buffer.isBuffer(restoredKey)).toBe(true)
    expect(restoredKey.toString('base64')).toBe(mediaKeyB64)

    // Second call is a cache hit — no additional download.
    const second = await resolveMedia(DEFAULT, 'LAZY1')
    expect(second.ok).toBe(true)
    expect(mockDownloadMediaMessage).toHaveBeenCalledTimes(1)
  })

  // 7. Legacy row (no rawMessage), cache hit — exercises the v1.6.1 disk-cache fallback (Task A / PR #57).
  it('case #7: legacy row (no rawMessage) + cache hit → disk-cache fallback returns ok', async () => {
    const bytes = Buffer.from('legacy-cached-image')
    seedMediaRow(DEFAULT, 'LEG1', 'image', {
      includeRawMessage: false,
      includeCachedFile: { bytes, filename: defaultFilename('image', 'LEG1') }
    })

    const direct = await resolveMedia(DEFAULT, 'LEG1')
    expect(direct.ok).toBe(true)
    if (direct.ok) {
      expect(direct.media.fileSize).toBe(bytes.length)
    }

    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/default/LEG1')
    expect(r.status).toBe(200)
    expect(r.body.equals(bytes)).toBe(true)
  })

  // 8. Legacy row, no cache → no_media / 415 on main.
  it('case #8: legacy row without rawMessage and no cache → no_media / 415', async () => {
    seedMediaRow(DEFAULT, 'LEG2', 'image', { includeRawMessage: false, includeCachedFile: null })

    const direct = await resolveMedia(DEFAULT, 'LEG2')
    expect(direct.ok).toBe(false)
    if (!direct.ok) {
      expect(direct.failure.errorKind).toBe('no_media')
      expect(direct.failure.httpStatus).toBe(415)
    }

    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/default/LEG2')
    expect(r.status).toBe(415)
  })

  // 9. Over-cap in auto mode → get_message_media returns a file path (no base64).
  it('case #9: auto over-cap → get_message_media returns a file path with a file:// resource_link', async () => {
    const bytes = Buffer.alloc(2048, 0xab)
    seedMediaRow(DEFAULT, 'BIG1', 'image', {
      includeRawMessage: true,
      includeCachedFile: { bytes, filename: defaultFilename('image', 'BIG1') },
      payloadOverrides: { fileLength: bytes.length }
    })
    setMaxInlineToolBytesForTesting(1024)
    await startMcpServer(testPort)

    const result = await callMcpTool(testPort, '/mcp', 'get_message_media', { messageId: 'BIG1' })
    expect(result.result.isError).toBeFalsy()
    const blocks = result.result.content
    // No inline blob anywhere — only a text summary plus a file:// resource_link.
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('text')
    expect(blocks[1].type).toBe('resource_link')
    expect(blocks[1].uri).toMatch(/^file:\/\//)
    expect(blocks[1].uri).toMatch(/image_BIG1\.jpg$/)
    for (const block of blocks) {
      expect(block.data).toBeUndefined()
      if (block.resource) expect(block.resource.blob).toBeUndefined()
    }
    const sc = result.result.structuredContent
    expect(sc.returnedAs).toBe('file')
    expect(PATH.isAbsolute(sc.path)).toBe(true)
    expect(fs.statSync(sc.path).size).toBe(bytes.length)
    // The loopback /media URL is still carried alongside the path.
    expect(sc.url).toMatch(/\/media\/default\/BIG1$/)
  })

  // 10. Unknown messageId → message_not_found / 404 (both paths).
  it('case #10: unknown messageId → message_not_found / 404 on both paths', async () => {
    const direct = await resolveMedia(DEFAULT, 'NOPE')
    expect(direct.ok).toBe(false)
    if (!direct.ok) {
      expect(direct.failure.errorKind).toBe('message_not_found')
      expect(direct.failure.httpStatus).toBe(404)
    }

    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/default/NOPE')
    expect(r.status).toBe(404)
    expect(JSON.parse(r.body.toString()).error).toMatch(/not found/i)
  })

  // 11. Unknown slug → 404 on the HTTP route (tool path can't address it directly).
  it('case #11: unknown slug → HTTP /media returns 404 "Unknown account"', async () => {
    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/ghost/MSG1')
    expect(r.status).toBe(404)
    expect(JSON.parse(r.body.toString()).error).toMatch(/Unknown account: ghost/)
  })

  // 12. Malformed content_json → no_media / 415 on both paths (no crash).
  it('case #12: malformed content_json → no_media / 415 on both paths', async () => {
    seedMalformedRow(DEFAULT, 'MAL1')

    const direct = await resolveMedia(DEFAULT, 'MAL1')
    expect(direct.ok).toBe(false)
    if (!direct.ok) {
      expect(direct.failure.errorKind).toBe('no_media')
      expect(direct.failure.httpStatus).toBe(415)
    }

    await startMcpServer(testPort)
    const r = await rawGet(testPort, '/media/default/MAL1')
    expect(r.status).toBe(415)
  })

  // 13. output:"file" → real on-disk file, byteLength/SHA-256 match, no base64.
  it('case #13: output:"file" returns a path whose bytes match fileSize and the inline payload', async () => {
    const bytes = Buffer.alloc(4096, 0x37)
    seedMediaRow(DEFAULT, 'FILE13', 'image', {
      includeRawMessage: true,
      includeCachedFile: { bytes, filename: defaultFilename('image', 'FILE13') },
      payloadOverrides: { fileLength: bytes.length }
    })
    await startMcpServer(testPort)

    const fileRes = await callMcpTool(testPort, '/mcp', 'get_message_media', { messageId: 'FILE13', output: 'file' })
    expect(fileRes.result.isError).toBeFalsy()
    const sc = fileRes.result.structuredContent
    expect(sc.returnedAs).toBe('file')
    expect(PATH.isAbsolute(sc.path)).toBe(true)
    expect(sc.fileSize).toBe(bytes.length)

    // File on disk has byteLength === fileSize.
    const onDisk = fs.readFileSync(sc.path)
    expect(onDisk.length).toBe(sc.fileSize)

    // No base64 block anywhere; a file:// resource_link is present.
    const blocks = fileRes.result.content
    for (const block of blocks) {
      expect(block.data).toBeUndefined()
      if (block.resource) expect(block.resource.blob).toBeUndefined()
    }
    const link = blocks.find((b: any) => b.type === 'resource_link')
    expect(link).toBeDefined()
    expect(link.uri).toBe(`file://${sc.path}`)

    // Content SHA-256 equals the inline-decoded bytes.
    const inlineRes = await callMcpTool(testPort, '/mcp', 'get_message_media', { messageId: 'FILE13', output: 'inline' })
    const inlineBlock = inlineRes.result.content.find((b: any) => b.type === 'image')
    const inlineBytes = Buffer.from(inlineBlock.data, 'base64')
    const fileSha = crypto.createHash('sha256').update(onDisk).digest('hex')
    const inlineSha = crypto.createHash('sha256').update(inlineBytes).digest('hex')
    expect(fileSha).toBe(inlineSha)
  })

  // 14. inline mode is byte-identical to the historical inline output.
  it('case #14: output:"inline" is byte-identical to the default inline result', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    seedMediaRow(DEFAULT, 'INL14', 'image', {
      includeRawMessage: true,
      includeCachedFile: { bytes, filename: defaultFilename('image', 'INL14') },
      payloadOverrides: { mimetype: 'image/jpeg', fileLength: bytes.length }
    })
    await startMcpServer(testPort)

    const explicit = await callMcpTool(testPort, '/mcp', 'get_message_media', { messageId: 'INL14', output: 'inline' })
    const auto = await callMcpTool(testPort, '/mcp', 'get_message_media', { messageId: 'INL14' })

    expect(explicit.result.content).toEqual(auto.result.content)
    expect(explicit.result.structuredContent).toEqual(auto.result.structuredContent)
    expect(explicit.result.structuredContent.returnedAs).toBe('inline')
    const img = explicit.result.content.find((b: any) => b.type === 'image')
    expect(img.data).toBe(bytes.toString('base64'))
  })

  // 15. account isolation — same messageId in two slugs maps to two paths.
  it('case #15: output:"file" is account-isolated — same id, two slugs, two paths, no cross-read', async () => {
    makeAccount('work')
    const defaultBytes = Buffer.from('default-account-bytes')
    const workBytes = Buffer.from('work-account-different')
    seedMediaRow(DEFAULT, 'SHARED', 'image', {
      includeRawMessage: true,
      includeCachedFile: { bytes: defaultBytes, filename: defaultFilename('image', 'SHARED') },
      payloadOverrides: { fileLength: defaultBytes.length }
    })
    seedMediaRow('work', 'SHARED', 'image', {
      includeRawMessage: true,
      includeCachedFile: { bytes: workBytes, filename: defaultFilename('image', 'SHARED') },
      payloadOverrides: { fileLength: workBytes.length }
    })
    await startMcpServer(testPort)

    const def = await callMcpTool(testPort, '/mcp', 'get_message_media', { messageId: 'SHARED', output: 'file' })
    const work = await callMcpTool(testPort, '/mcp/work', 'get_message_media', { messageId: 'SHARED', output: 'file' })

    const defPath = def.result.structuredContent.path
    const workPath = work.result.structuredContent.path
    expect(defPath).not.toBe(workPath)
    expect(fs.readFileSync(defPath).equals(defaultBytes)).toBe(true)
    expect(fs.readFileSync(workPath).equals(workBytes)).toBe(true)
  })
})
