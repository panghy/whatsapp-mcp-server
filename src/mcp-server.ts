import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { chatOps, messageOps, settingOps, contactOps, getDatabase } from './database'
import { serializeCompact, MeIdentity } from './compact-serializer'
import { TransformedMessage, extractPhoneFromJid, restoreBuffersInPlace } from './message-transformer'
import {
  toStructuredMessage,
  chatHistoryOutputShape,
  messagesByChatOutputShape,
  searchChatsOutputShape,
  sendMessageOutputShape,
  getMessageMediaOutputShape,
  ChatRef,
  StructuredMessage,
  SearchChatsResultEntry,
  SendMessageResult,
  GetMessageMediaResult
} from './structured-message'
import { getAccount, getDefaultSlug, accountDir } from './accounts'
import { getManager } from './whatsapp-manager'
import { getMcpPort as getGlobalMcpPort, setMcpPort as setGlobalMcpPort } from './global-settings'

// Dynamically loaded so the existing `vi.mock('@whiskeysockets/baileys', …)`
// pattern in tests continues to work the same way as in message-transformer.
let downloadMediaMessageFn: ((msg: any, type: 'buffer', opts: any) => Promise<Buffer>) | null = null
async function loadDownloadMediaMessage(): Promise<typeof downloadMediaMessageFn> {
  if (!downloadMediaMessageFn) {
    const baileys = await import('@whiskeysockets/baileys')
    downloadMediaMessageFn = (baileys as any).downloadMediaMessage
  }
  return downloadMediaMessageFn
}

// Per-account MCP server registry. Lazy-initialized on first request.
const mcpServers = new Map<string, McpServer>()

// Active transports keyed by "<slug>::<sessionId-or-unique-id>" so concurrent
// requests across slugs cannot collide and per-account teardown is possible.
const activeTransports = new Map<string, StreamableHTTPServerTransport>()

let httpServer: http.Server | null = null

// Rank-gap factor used by `search_chats` to prune weak FTS hits when a strong
// hit exists. BM25 ranks are negative (lower = better); multiplying the top
// (most-negative) rank by this factor yields a less-negative threshold, and
// any hit whose rank exceeds the threshold is dropped. Phone-matched hits
// carry a sentinel rank and are exempt from this filter.
const GAP_FACTOR = 0.4

/**
 * Build an FTS5 MATCH expression from a free-text query by generating the set
 * of overlapping trigrams for every >=3 char word, OR-ing the trigrams within
 * each word and AND-ing the per-word groups together. Within-word OR preserves
 * typo tolerance (a single-character error only invalidates a few overlapping
 * trigrams), while AND across words ensures every query word contributes to
 * the match so chats matching all words outrank chats matching only some.
 * Single-word queries degenerate to a single group with the same semantics as
 * a flat OR expression. Returns `null` when the query has no searchable words.
 */
function buildFtsQuery(query: string): string | null {
  const normalized = (query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (!normalized) return null
  const words = normalized.split(/\s+/).filter((w) => w.length >= 3)
  if (words.length === 0) return null
  const groups: string[] = []
  for (const word of words) {
    const trigrams = new Set<string>()
    for (let i = 0; i <= word.length - 3; i++) {
      trigrams.add(word.substring(i, i + 3))
    }
    if (trigrams.size === 0) continue
    const terms = Array.from(trigrams).map((t) => `"${t.replace(/"/g, '""')}"`)
    groups.push(`(${terms.join(' OR ')})`)
  }
  if (groups.length === 0) return null
  return groups.join(' AND ')
}

/**
 * Read meIdentity from the given account's settings.
 */
function getMeIdentity(slug: string): MeIdentity | undefined {
  const name = settingOps.get(slug, 'user_display_name')
  const phone = settingOps.get(slug, 'user_phone')
  if (name && phone) return { name, phone }
  return undefined
}

/**
 * Pick a display name from a contact row using the priority
 * `name → verified_name → push_name`. Returns `null` when none are set.
 */
function pickContactDisplayName(contact: any): string | null {
  return contact?.name || contact?.verified_name || contact?.push_name || null
}

/**
 * Resolve sender identity from contacts database.
 */
function resolveFromContacts(
  slug: string,
  senderJid: string,
  fallback: { name: string; phone: string | null }
): { name: string; phone: string | null } {
  let contact = contactOps.getByJid(slug, senderJid) as any

  if (!pickContactDisplayName(contact) && (senderJid.includes('@lid') || senderJid.includes('@hosted.lid'))) {
    const lidContact = contactOps.getByLid(slug, senderJid) as any
    if (lidContact) contact = lidContact
  }

  const phone = fallback.phone || extractPhoneFromJid(senderJid) || contact?.phone_number
  if (!pickContactDisplayName(contact) && phone) {
    const phoneContact = contactOps.getByPhone(slug, phone) as any
    if (phoneContact) contact = phoneContact
  }

  const resolvedName = pickContactDisplayName(contact) || fallback.name
  const resolvedPhone = contact?.phone_number || phone || fallback.phone

  if ((resolvedName === 'Unknown' || resolvedName.startsWith('Unknown_')) && resolvedPhone) {
    return { name: resolvedPhone, phone: resolvedPhone }
  }
  if (resolvedName === 'Unknown') {
    return { name: `Unknown_${senderJid}`, phone: null }
  }

  return { name: resolvedName, phone: resolvedPhone }
}

/**
 * Re-resolve @mentions in text using stored mentionedJids array.
 */
function reResolveAllMentions(slug: string, text: string, mentionedJids: string[]): string {
  let resolvedText = text

  for (const jid of mentionedJids) {
    let contact = contactOps.getByJid(slug, jid) as any

    if (!pickContactDisplayName(contact) && (jid.includes('@lid') || jid.includes('@hosted.lid'))) {
      const lidContact = contactOps.getByLid(slug, jid) as any
      if (lidContact) contact = lidContact
    }

    const atIndex = jid.indexOf('@')
    const numberPart = atIndex > 0 ? jid.substring(0, atIndex) : jid

    if (!pickContactDisplayName(contact) && numberPart) {
      const phoneContact = contactOps.getByPhone(slug, numberPart) as any
      if (phoneContact) contact = phoneContact
    }

    const name = pickContactDisplayName(contact)
    const phone = contact?.phone_number || numberPart || null

    let formattedMention: string
    if (name && phone && name !== phone) {
      formattedMention = `@${name}:${phone}`
    } else if (phone) {
      formattedMention = `@${phone}`
    } else if (name) {
      formattedMention = `@${name}`
    } else {
      formattedMention = `@Unknown_${jid}`
    }

    const unknownPattern = `@Unknown_${jid}`
    if (resolvedText.includes(unknownPattern)) {
      resolvedText = resolvedText.replace(unknownPattern, formattedMention)
      continue
    }

    const rawPattern = `@${numberPart}`
    if (resolvedText.includes(rawPattern)) {
      const rawRegex = new RegExp(`@${numberPart}(?![\\d:])`, 'g')
      resolvedText = resolvedText.replace(rawRegex, formattedMention)
      continue
    }

    if (phone) {
      const escapedPhone = phone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const stalePatternWithName = new RegExp(`@[^@\\s:]+:${escapedPhone}(?![\\d])`, 'g')
      const stalePatternPhoneOnly = new RegExp(`@${escapedPhone}(?![\\d:])`, 'g')
      resolvedText = resolvedText.replace(stalePatternWithName, formattedMention)
      resolvedText = resolvedText.replace(stalePatternPhoneOnly, formattedMention)
    }
  }

  return resolvedText
}

/**
 * Re-resolve @Unknown_<jid> patterns in text (backward compat).
 */
function reResolveMentionsInText(slug: string, text: string): string {
  const mentionPattern = /@Unknown_([^\s@]+@(?:s\.whatsapp\.net|lid|hosted\.lid))/g

  return text.replace(mentionPattern, (match, jid) => {
    let contact = contactOps.getByJid(slug, jid) as any

    if (!contact && (jid.includes('@lid') || jid.includes('@hosted.lid'))) {
      contact = contactOps.getByLid(slug, jid) as any
    }

    if (contact) {
      const name = pickContactDisplayName(contact)
      const phone = contact.phone_number || null

      if (name && phone && name !== phone) return `@${name}:${phone}`
      if (phone) return `@${phone}`
      if (name) return `@${name}`
    }

    return match
  })
}

/**
 * Resolve all identity fields in a message.
 */
function resolveAllIdentities(
  slug: string,
  msg: any,
  parsed: TransformedMessage,
  meIdentity?: MeIdentity
): TransformedMessage {
  const senderJid = msg.sender_jid

  if (meIdentity && !parsed.isFromMe) {
    const senderPhone = extractPhoneFromJid(senderJid)
    if (senderPhone && senderPhone === meIdentity.phone) {
      parsed.isFromMe = true
    }
  }

  if (parsed.isFromMe && meIdentity) {
    parsed.sender = { name: meIdentity.name, phone: meIdentity.phone }
  } else if (parsed.sender) {
    parsed.sender = resolveFromContacts(slug, senderJid, parsed.sender)
  }

  if (parsed.text) {
    if (parsed.mentionedJids && parsed.mentionedJids.length > 0) {
      parsed.text = reResolveAllMentions(slug, parsed.text, parsed.mentionedJids)
    } else {
      parsed.text = reResolveMentionsInText(slug, parsed.text)
    }
  }

  if (parsed.replyTo && parsed.replyTo.messageId) {
    const originalMsg = messageOps.getByWhatsappMessageId(slug, parsed.replyTo.messageId) as any
    if (originalMsg) {
      const resolved = resolveFromContacts(slug, originalMsg.sender_jid, {
        name: parsed.replyTo.senderName || 'Unknown',
        phone: parsed.replyTo.senderPhone || null
      })
      parsed.replyTo.senderName = resolved.name
      parsed.replyTo.senderPhone = resolved.phone
    }
  }

  if (!parsed.replyTo && parsed.replyToMessageId) {
    const original = messageOps.getByWhatsappMessageId(slug, parsed.replyToMessageId) as any
    if (original) {
      try {
        const content = JSON.parse(original.content_json)
        const resolved = resolveFromContacts(slug, original.sender_jid, { name: 'Unknown', phone: null })
        const fullText = content.text || '[Attachment]'
        parsed.replyTo = {
          messageId: parsed.replyToMessageId,
          senderName: resolved.name,
          senderPhone: resolved.phone,
          fullText,
          preview: fullText.substring(0, 50)
        }
      } catch { /* skip corrupt content */ }
    }
  }

  if (parsed.deletedBy) {
    parsed.deletedBy = resolveFromContacts(slug, senderJid, parsed.deletedBy)
  }

  if (parsed.editedBy) {
    parsed.editedBy = resolveFromContacts(slug, senderJid, parsed.editedBy)
  }

  if (parsed.deletedMessage?.sender && parsed.deletedMessage.messageId) {
    const original = messageOps.getByWhatsappMessageId(slug, parsed.deletedMessage.messageId) as any
    if (original) {
      parsed.deletedMessage.sender = resolveFromContacts(slug, original.sender_jid, parsed.deletedMessage.sender)
    }
  }

  if (parsed.editedMessage?.sender && parsed.editedMessage.messageId) {
    const original = messageOps.getByWhatsappMessageId(slug, parsed.editedMessage.messageId) as any
    if (original) {
      parsed.editedMessage.sender = resolveFromContacts(slug, original.sender_jid, parsed.editedMessage.sender)
    }
  }

  return parsed
}

/**
 * Build the per-account `/media` URL prefix using the current MCP port. Read
 * fresh on each tool call so port changes take effect without rebuilding the
 * McpServer.
 */
function buildMediaBaseUrl(slug: string): string {
  return `http://127.0.0.1:${getGlobalMcpPort()}/media/${slug}`
}

// --- Media download (shared between /media HTTP route and get_message_media) ---

/**
 * Hard upper bound on the size of an inline `get_message_media` payload. Over
 * this limit the tool falls back to a `resource_link` block only so it never
 * crashes MCP hosts with multi-megabyte base64 strings.
 */
const DEFAULT_MAX_INLINE_TOOL_BYTES = 25 * 1024 * 1024 // 25MB
let maxInlineToolBytes = DEFAULT_MAX_INLINE_TOOL_BYTES

/** Test-only override for the inline payload cap. Pass `null` to reset. */
export function setMaxInlineToolBytesForTesting(bytes: number | null): void {
  maxInlineToolBytes = bytes === null ? DEFAULT_MAX_INLINE_TOOL_BYTES : bytes
}

type MediaAttachmentKind = 'image' | 'voice' | 'audio' | 'video' | 'document' | 'sticker'

interface ResolvedMedia {
  filepath: string
  filename: string
  mimeType: string
  fileSize: number
  kind: MediaAttachmentKind
  durationSeconds?: number
}
interface MediaFailure {
  errorKind: 'message_not_found' | 'no_media' | 'not_connected' | 'download_failed'
  httpStatus: 404 | 415 | 502 | 503
  error: string
}
type MediaResolution = { ok: true; media: ResolvedMedia } | { ok: false; failure: MediaFailure }

/** Validate a messageId path parameter — must not be empty or contain
 *  separators / null bytes / dots that could enable directory traversal. */
function isValidMessageId(messageId: string): boolean {
  if (!messageId || messageId.length === 0 || messageId.length > 256) return false
  if (messageId.includes('/') || messageId.includes('\\')) return false
  if (messageId.includes('.') || messageId.includes('\0')) return false
  return true
}

/** Map a mime type to a common file extension. Falls back to `bin`. */
function deriveExtension(mimeType: string): string {
  const base = (mimeType || '').split(';')[0].trim().toLowerCase()
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/aac': 'aac',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/3gpp': '3gp',
    'application/pdf': 'pdf'
  }
  return map[base] || 'bin'
}

/** Locate a Baileys `*Message` payload inside the stored `content_json`. The
 *  ingestion path may persist the raw payload at the top level, under
 *  `.message`, or under `.rawMessage`; checking all three keeps this helper
 *  compatible with the persistence layout chosen by the sibling task. */
function findMediaPayload(parsed: any): { kind: MediaAttachmentKind; payload: any } | null {
  const candidates: any[] = [parsed, parsed?.message, parsed?.rawMessage].filter((c) => c && typeof c === 'object')
  for (const c of candidates) {
    if (c.imageMessage) return { kind: 'image', payload: c.imageMessage }
    if (c.videoMessage) return { kind: 'video', payload: c.videoMessage }
    if (c.documentMessage) return { kind: 'document', payload: c.documentMessage }
    if (c.stickerMessage) return { kind: 'sticker', payload: c.stickerMessage }
    if (c.audioMessage) {
      const isPtt = c.audioMessage.ptt === true
      return { kind: isPtt ? 'voice' : 'audio', payload: c.audioMessage }
    }
  }
  return null
}

/** Coerce a Baileys numeric field (may be a Long with low/high words). */
function coerceLong(value: any): number {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object') {
    if (typeof value.toNumber === 'function') {
      try { return value.toNumber() } catch { /* fall through */ }
    }
    if (typeof value.low === 'number') {
      return (value.low >>> 0) + (value.high || 0) * 0x100000000
    }
  }
  return 0
}

/**
 * Resolve the on-disk media for a given (slug, messageId). Looks up the
 * stored message, identifies the media payload, returns the cached file when
 * present, and otherwise lazily downloads via Baileys' `downloadMediaMessage`
 * and writes it under `<accountDir>/attachments/<messageId>/<filename>`.
 */
export async function resolveMedia(slug: string, messageId: string): Promise<MediaResolution> {
  const row = messageOps.getByWhatsappMessageId(slug, messageId) as any
  if (!row) {
    return { ok: false, failure: { errorKind: 'message_not_found', httpStatus: 404, error: `Message not found: ${messageId}` } }
  }

  let parsed: any
  try { parsed = JSON.parse(row.content_json) }
  catch { return { ok: false, failure: { errorKind: 'no_media', httpStatus: 415, error: 'Message content is not valid JSON' } } }

  const found = findMediaPayload(parsed)
  if (!found) {
    return { ok: false, failure: { errorKind: 'no_media', httpStatus: 415, error: 'Message has no downloadable media' } }
  }
  const { kind, payload } = found

  const mimeType = (payload?.mimetype || 'application/octet-stream') as string
  const fileSizeFromMeta = coerceLong(payload?.fileLength)
  const durationSeconds = payload?.seconds != null ? coerceLong(payload.seconds) : undefined
  const filename = (payload?.fileName as string | undefined) || `${kind}_${messageId}.${deriveExtension(mimeType)}`

  const attachmentDir = path.join(accountDir(slug), 'attachments', messageId)
  const filepath = path.join(attachmentDir, filename)

  if (fs.existsSync(filepath)) {
    const stat = fs.statSync(filepath)
    return { ok: true, media: { filepath, filename, mimeType, fileSize: stat.size, kind, durationSeconds } }
  }

  const socket = getManager(slug)?.socket
  if (!socket) {
    return { ok: false, failure: { errorKind: 'not_connected', httpStatus: 503, error: 'WhatsApp not connected' } }
  }

  const download = await loadDownloadMediaMessage()
  if (!download) {
    return { ok: false, failure: { errorKind: 'download_failed', httpStatus: 502, error: 'Baileys download helper is unavailable' } }
  }

  // Reconstruct a minimal Baileys WAMessage. `downloadMediaMessage` reads
  // `msg.message.<kind>Message` and uses its `mediaKey` + URL to fetch.
  // `restoreBuffersInPlace` rebuilds the protobuf `bytes` fields (`mediaKey`,
  // `fileEncSha256`, …) from their persisted JSON-safe form.
  const messageKey = `${kind === 'voice' ? 'audio' : kind}Message`
  restoreBuffersInPlace(payload)
  const reconstructed = {
    key: { id: messageId, remoteJid: row.sender_jid, fromMe: false },
    message: { [messageKey]: payload }
  }

  try {
    const buffer = await download(reconstructed, 'buffer', {})
    if (!fs.existsSync(attachmentDir)) fs.mkdirSync(attachmentDir, { recursive: true })
    fs.writeFileSync(filepath, buffer)
    const fileSize = buffer.length || fileSizeFromMeta
    return { ok: true, media: { filepath, filename, mimeType, fileSize, kind, durationSeconds } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, failure: { errorKind: 'download_failed', httpStatus: 502, error: msg } }
  }
}

/** RFC 5987-encoded `Content-Disposition` value covering non-ASCII filenames. */
function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A')
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

/** Human-readable byte size used in the over-cap text summary. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Build an McpServer whose tool handlers are bound to the given account slug.
 */
export function createMcpServer(slug: string): McpServer {
  const server = new McpServer({
    name: 'whatsapp-mcp-server',
    version: '1.0.0',
    description: 'Access WhatsApp messages and chats. Search conversations, read message history, get recent and unread messages, and send messages through WhatsApp.'
  })

  server.registerTool(
    'search_chats',
    {
      description: 'Search chats by name or associated contact name, with typo tolerance and phone-number matching. Multi-word queries match chats that contain any of the words; chats matching more words rank higher (bm25). Typos are tolerated via trigram fuzzy matching when available. Digit-only queries of 5+ digits also match contacts by normalized phone number (digits only, ignoring +, -, spaces, parentheses), surfacing the matching DM chat. Results are ranked by relevance with recent activity as a tiebreaker and capped by `limit`.',
      inputSchema: {
        query: z.string().describe('Search query: name fragment, multiple words, or a phone number'),
        limit: z.number().optional().default(20).describe('Maximum number of results to return (default 20, capped at 100)')
      },
      outputSchema: searchChatsOutputShape,
      annotations: { readOnlyHint: true }
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const cap = Math.min(Math.max(Number.isFinite(limit) ? Number(limit) : 20, 1), 100)
      const db = getDatabase(slug)

      const ftsQuery = buildFtsQuery(query)
      const digitQuery = (query || '').replace(/\D+/g, '')

      type Hit = { chatId: number; rank: number; matchedVia: 'name' | 'contact' | 'phone' }
      const hits = new Map<number, Hit>()
      const upsert = (h: Hit) => {
        const existing = hits.get(h.chatId)
        if (!existing || h.rank < existing.rank) hits.set(h.chatId, h)
      }

      if (ftsQuery) {
        try {
          const chatRows = db.prepare(`
            SELECT cf.rowid AS chatId, bm25(chats_fts) AS rank
            FROM chats_fts cf
            WHERE chats_fts MATCH ?
          `).all(ftsQuery) as { chatId: number; rank: number }[]
          for (const r of chatRows) upsert({ chatId: r.chatId, rank: r.rank, matchedVia: 'name' })

          const contactRows = db.prepare(`
            SELECT c.id AS chatId, bm25(contacts_fts) AS rank
            FROM contacts_fts cf
            JOIN chats c ON c.whatsapp_jid = cf.jid AND c.chat_type = 'dm'
            WHERE contacts_fts MATCH ?
          `).all(ftsQuery) as { chatId: number; rank: number }[]
          for (const r of contactRows) upsert({ chatId: r.chatId, rank: r.rank, matchedVia: 'contact' })
        } catch { /* malformed FTS query → skip FTS hits */ }
      }

      if (digitQuery.length >= 5) {
        const phoneRows = db.prepare(`
          SELECT c.id AS chatId
          FROM contacts ct
          JOIN chats c
            ON (c.whatsapp_jid = ct.jid OR (ct.lid IS NOT NULL AND c.whatsapp_jid = ct.lid))
           AND c.chat_type = 'dm'
          WHERE ct.phone_digits IS NOT NULL AND ct.phone_digits LIKE '%' || ? || '%'
        `).all(digitQuery) as { chatId: number }[]
        for (const r of phoneRows) upsert({ chatId: r.chatId, rank: -1e6, matchedVia: 'phone' })
      }

      if (hits.size === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
          structuredContent: { query, results: [] as SearchChatsResultEntry[] }
        }
      }

      // Fetch enabled chat rows once, up front, so the digit-only-name filter
      // below can consult display names and the final result builder can reuse
      // the same rows without a second round-trip.
      const ids = Array.from(hits.keys())
      const placeholders = ids.map(() => '?').join(',')
      const chats = db.prepare(
        `SELECT * FROM chats WHERE id IN (${placeholders}) AND enabled = 1`
      ).all(...ids) as any[]
      const chatsById = new Map<number, any>(chats.map((c: any) => [c.id, c]))

      // Drop hits whose chat is disabled or missing — previously handled
      // implicitly by the enabled = 1 join on the result fetch.
      for (const id of Array.from(hits.keys())) {
        if (!chatsById.has(id)) hits.delete(id)
      }

      // Digit-only-name filter: when a phone-number query produced any phone
      // hit, drop FTS name/contact hits whose chat display name has no ASCII
      // letter (pure-digit strings like "85293497494" or "+852 9243 9919").
      // Those are unnamed DMs where the name is another phone number and the
      // trigram overlap with the query is coincidental digit collision.
      const hasPhoneHit = Array.from(hits.values()).some((h) => h.matchedVia === 'phone')
      if (hasPhoneHit) {
        for (const [id, h] of hits) {
          if (h.matchedVia === 'phone') continue
          const name = ((chatsById.get(id)?.name ?? '') as string).trim()
          if (!name || !/[a-zA-Z]/.test(name)) hits.delete(id)
        }
      }

      // Rank-gap post-filter: when a strong FTS hit exists, drop FTS hits whose
      // BM25 rank is much worse (see GAP_FACTOR). Phone hits are exempt so the
      // sentinel `-1e6` rank keeps them visible regardless of other matches.
      let topFtsRank = Infinity
      for (const h of hits.values()) {
        if (h.matchedVia !== 'phone' && h.rank < topFtsRank) topFtsRank = h.rank
      }
      if (topFtsRank < 0) {
        const threshold = topFtsRank * GAP_FACTOR
        for (const [id, h] of hits) {
          if (h.matchedVia === 'phone') continue
          if (h.rank > threshold) hits.delete(id)
        }
      }

      const results: SearchChatsResultEntry[] = Array.from(hits.values()).map((h) => {
        const chat = chatsById.get(h.chatId)!
        return {
          jid: chat.whatsapp_jid,
          name: chat.name || chat.whatsapp_jid,
          type: chat.chat_type,
          lastActivity: chat.last_activity,
          rank: h.rank,
          matchedVia: h.matchedVia
        }
      })

      results.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank
        const aAct = a.lastActivity || ''
        const bAct = b.lastActivity || ''
        if (aAct === bAct) return 0
        return aAct < bAct ? 1 : -1
      })

      const capped = results.slice(0, cap)
      return {
        content: [{ type: 'text', text: JSON.stringify(capped, null, 2) }],
        structuredContent: { query, results: capped }
      }
    }
  )

  server.registerTool(
    'get_chat_history',
    {
      description: 'Get WhatsApp message history for a specific chat by JID. Returns messages in chronological order with optional time-based filtering.',
      inputSchema: {
        jid: z.string().describe('WhatsApp JID of the chat (get this from search_chats)'),
        limit: z.number().optional().default(100).describe('Maximum number of messages to return'),
        since: z.string().optional().describe('ISO timestamp cutoff - only return messages after this time'),
        includeMessageIds: z.boolean().optional().default(false).describe('Include WhatsApp message IDs (messageId, replyTo.messageId, deletedMessage.messageId, editedMessage.messageId) in structured output. Off by default since these IDs are not actionable without dedicated tools.')
      },
      outputSchema: chatHistoryOutputShape,
      annotations: { readOnlyHint: true }
    },
    async ({ jid, limit, since, includeMessageIds }: { jid: string; limit: number; since?: string; includeMessageIds: boolean }) => {
      const chat = chatOps.getByWhatsappJid(slug, jid) as any
      const missingChatStructured = { chat: { jid, name: jid, type: 'unknown' }, messages: [] as StructuredMessage[] }
      if (!chat) {
        return {
          content: [{ type: 'text', text: `Chat not found: ${jid}` }],
          isError: true,
          structuredContent: missingChatStructured
        }
      }
      if (!chat.enabled) {
        return {
          content: [{ type: 'text', text: `Chat is disabled: ${jid}` }],
          isError: true,
          structuredContent: missingChatStructured
        }
      }

      let messages = messageOps.getByChatId(slug, chat.id, limit || 100) as any[]

      if (since) {
        const sinceTs = new Date(since).getTime()
        messages = messages.filter((m: any) => m.timestamp >= sinceTs)
      }

      const meIdentity = getMeIdentity(slug)

      const transformed = messages.map((m: any) => {
        try {
          const parsed = JSON.parse(m.content_json) as TransformedMessage
          return resolveAllIdentities(slug, m, parsed, meIdentity)
        }
        catch { return null }
      }).filter((m): m is TransformedMessage => m !== null).reverse()

      const output = serializeCompact(transformed, undefined, meIdentity)
      const chatRef: ChatRef = { jid: chat.whatsapp_jid, name: chat.name || chat.whatsapp_jid, type: chat.chat_type }
      const mediaBaseUrl = buildMediaBaseUrl(slug)
      const structuredMessages: StructuredMessage[] = transformed.map(m => toStructuredMessage(m, { includeMessageIds, mediaBaseUrl }))
      return {
        content: [{ type: 'text', text: output || '(no messages)' }],
        structuredContent: { chat: chatRef, messages: structuredMessages }
      }
    }
  )

  server.registerTool(
    'get_recent_messages',
    {
      description: 'Get recent WhatsApp messages across all chats since a given time. Useful for catching up on what happened in a time window. Results grouped by chat.',
      inputSchema: {
        since: z.string().describe('ISO timestamp cutoff (e.g. "2024-01-15T00:00:00Z") - returns messages after this time'),
        limit: z.number().optional().default(200).describe('Maximum total messages to return'),
        includeMessageIds: z.boolean().optional().default(false).describe('Include WhatsApp message IDs (messageId, replyTo.messageId, deletedMessage.messageId, editedMessage.messageId) in structured output. Off by default since these IDs are not actionable without dedicated tools.')
      },
      outputSchema: messagesByChatOutputShape,
      annotations: { readOnlyHint: true }
    },
    async ({ since, limit, includeMessageIds }: { since: string; limit: number; includeMessageIds: boolean }) => {
      const sinceTs = new Date(since).getTime()
      const db = getDatabase(slug)
      const messages = db.prepare(`
        SELECT m.*, c.whatsapp_jid, c.name as chat_name, c.chat_type
        FROM messages m
        JOIN chats c ON m.chat_id = c.id
        WHERE m.timestamp >= ? AND c.enabled = 1
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(sinceTs, limit || 200) as any[]

      const meIdentity = getMeIdentity(slug)

      const byChat = new Map<string, { meta: ChatRef; msgs: any[] }>()
      for (const m of messages) {
        const key = m.chat_name || m.whatsapp_jid
        if (!byChat.has(key)) {
          byChat.set(key, {
            meta: { jid: m.whatsapp_jid, name: m.chat_name || m.whatsapp_jid, type: m.chat_type },
            msgs: []
          })
        }
        byChat.get(key)!.msgs.push(m)
      }

      let output = ''
      const structuredChats: Array<{ chat: ChatRef; messages: StructuredMessage[] }> = []
      const mediaBaseUrl = buildMediaBaseUrl(slug)
      for (const [chatName, group] of byChat) {
        output += `\n=== ${chatName} ===\n`
        const transformed = group.msgs.map((m: any) => {
          try {
            const parsed = JSON.parse(m.content_json) as TransformedMessage
            return resolveAllIdentities(slug, m, parsed, meIdentity)
          }
          catch { return null }
        }).filter((m): m is TransformedMessage => m !== null).reverse()
        output += serializeCompact(transformed, undefined, meIdentity) + '\n'
        structuredChats.push({ chat: group.meta, messages: transformed.map(m => toStructuredMessage(m, { includeMessageIds, mediaBaseUrl })) })
      }

      return {
        content: [{ type: 'text', text: output || '(no recent messages)' }],
        structuredContent: { since, chats: structuredChats }
      }
    }
  )

  server.registerTool(
    'get_unread_messages',
    {
      description: 'Get unread WhatsApp messages across all chats since the last check. Tracks read state so subsequent calls only return new messages. Results grouped by chat.',
      inputSchema: {
        since: z.string().optional().describe('Optional ISO timestamp cutoff. If omitted, uses the last time this tool was called (or 24h ago if first call)'),
        includeMessageIds: z.boolean().optional().default(false).describe('Include WhatsApp message IDs (messageId, replyTo.messageId, deletedMessage.messageId, editedMessage.messageId) in structured output. Off by default since these IDs are not actionable without dedicated tools.')
      },
      outputSchema: messagesByChatOutputShape,
      annotations: { readOnlyHint: true }
    },
    async ({ since, includeMessageIds }: { since?: string; includeMessageIds: boolean }) => {
      const lastCheck = settingOps.get(slug, 'last_unread_check')
      const defaultSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const sinceStr = since || lastCheck || defaultSince
      const sinceTs = new Date(sinceStr).getTime()

      const db = getDatabase(slug)
      const messages = db.prepare(`
        SELECT m.*, c.whatsapp_jid, c.name as chat_name, c.chat_type
        FROM messages m
        JOIN chats c ON m.chat_id = c.id
        WHERE m.timestamp >= ? AND c.enabled = 1
        ORDER BY m.timestamp DESC
        LIMIT 500
      `).all(sinceTs) as any[]

      settingOps.set(slug, 'last_unread_check', new Date().toISOString())

      const meIdentity = getMeIdentity(slug)

      const byChat = new Map<string, { meta: ChatRef; msgs: any[] }>()
      for (const m of messages) {
        const key = m.chat_name || m.whatsapp_jid
        if (!byChat.has(key)) {
          byChat.set(key, {
            meta: { jid: m.whatsapp_jid, name: m.chat_name || m.whatsapp_jid, type: m.chat_type },
            msgs: []
          })
        }
        byChat.get(key)!.msgs.push(m)
      }

      let body = ''
      const structuredChats: Array<{ chat: ChatRef; messages: StructuredMessage[] }> = []
      const mediaBaseUrl = buildMediaBaseUrl(slug)
      for (const [chatName, group] of byChat) {
        body += `\n=== ${chatName} ===\n`
        const transformed = group.msgs.map((m: any) => {
          try {
            const parsed = JSON.parse(m.content_json) as TransformedMessage
            return resolveAllIdentities(slug, m, parsed, meIdentity)
          }
          catch { return null }
        }).filter((m): m is TransformedMessage => m !== null).reverse()
        body += serializeCompact(transformed, undefined, meIdentity) + '\n'
        structuredChats.push({ chat: group.meta, messages: transformed.map(m => toStructuredMessage(m, { includeMessageIds, mediaBaseUrl })) })
      }

      const text = byChat.size === 0 ? '(no unread messages)' : `Messages since ${sinceStr}:\n${body}`
      return {
        content: [{ type: 'text', text }],
        structuredContent: { since: sinceStr, chats: structuredChats }
      }
    }
  )

  server.registerTool(
    'send_message',
    {
      description: 'Send a WhatsApp message to a contact or group. Supports text messages and file attachments (images, documents). Requires the chat JID from search_chats.',
      inputSchema: {
        jid: z.string().describe('WhatsApp JID of the recipient (get this from search_chats)'),
        text: z.string().describe('The message text to send'),
        attachmentPath: z.string().optional().describe('Optional absolute path to a file to attach (images, PDFs, documents)')
      },
      outputSchema: sendMessageOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    async ({ jid, text, attachmentPath }: { jid: string; text: string; attachmentPath?: string }) => {
      const socket = getManager(slug)?.socket
      if (!socket) {
        const failure: SendMessageResult = {
          ok: false, jid, error: 'WhatsApp is not connected', errorKind: 'not_connected'
        }
        return {
          content: [{ type: 'text', text: 'WhatsApp is not connected' }],
          isError: true,
          structuredContent: failure
        }
      }

      try {
        let sendResult: any
        let attachmentInfo: { filename: string; kind: 'image' | 'document' } | undefined
        if (attachmentPath) {
          const fs = await import('fs')
          const path = await import('path')

          if (!fs.existsSync(attachmentPath)) {
            const failure: SendMessageResult = {
              ok: false,
              jid,
              error: `Attachment file not found: ${attachmentPath}`,
              errorKind: 'attachment_not_found'
            }
            return {
              content: [{ type: 'text', text: `Attachment file not found: ${attachmentPath}` }],
              isError: true,
              structuredContent: failure
            }
          }

          const buffer = fs.readFileSync(attachmentPath)
          const filename = path.basename(attachmentPath)
          const ext = path.extname(attachmentPath).toLowerCase()

          const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
          const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']

          if (imageExts.includes(ext)) {
            sendResult = await socket.sendMessage(jid, { image: buffer, caption: text })
            attachmentInfo = { filename, kind: 'image' }
          } else if (docExts.includes(ext)) {
            sendResult = await socket.sendMessage(jid, { document: buffer, fileName: filename, caption: text })
            attachmentInfo = { filename, kind: 'document' }
          } else {
            sendResult = await socket.sendMessage(jid, { document: buffer, fileName: filename, caption: text })
            attachmentInfo = { filename, kind: 'document' }
          }
        } else {
          sendResult = await socket.sendMessage(jid, { text })
        }

        // baileys returns WAProto.WebMessageInfo. `key.id` is the message id;
        // `messageTimestamp` is whole seconds and may be a Long (long.js) or a
        // plain number. Only emit fields baileys actually returned — never
        // fabricate a Date.now() timestamp.
        const messageId: string | undefined = sendResult?.key?.id ?? undefined
        const rawTs = sendResult?.messageTimestamp
        let timestamp: string | undefined
        if (rawTs != null) {
          const tsSec = typeof rawTs === 'number'
            ? rawTs
            : (typeof rawTs?.toNumber === 'function' ? rawTs.toNumber() : Number(rawTs))
          if (Number.isFinite(tsSec) && tsSec > 0) {
            timestamp = new Date(tsSec * 1000).toISOString()
          }
        }

        const success: Extract<SendMessageResult, { ok: true }> = { ok: true, jid }
        if (messageId) success.messageId = messageId
        if (timestamp) success.timestamp = timestamp
        if (attachmentInfo) success.attachment = attachmentInfo

        return {
          content: [{ type: 'text', text: `Message sent to ${jid}` }],
          structuredContent: success
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        const failure: SendMessageResult = {
          ok: false,
          jid,
          error: `Failed to send message: ${errMsg}`,
          errorKind: 'send_failed'
        }
        return {
          content: [{ type: 'text', text: `Failed to send message: ${errMsg}` }],
          isError: true,
          structuredContent: failure
        }
      }
    }
  )

  server.registerTool(
    'get_message_media',
    {
      description: 'Return the media payload of a WhatsApp message (image, voice note, audio, video, document, or sticker) as an inline MCP content block. Use this only when your client cannot fetch HTTP URLs — when you can, prefer the `attachment.url` field on messages from chat-history tools, which streams the same bytes from the local MCP server without inflating the tool result. Files exceeding the inline cap (default 25MB) are returned as a `resource_link` only.',
      inputSchema: {
        messageId: z.string().describe('WhatsApp message ID of the message whose media to fetch'),
        chatJid: z.string().optional().describe('Optional chat JID; only used to make error messages clearer')
      },
      outputSchema: getMessageMediaOutputShape,
      annotations: { readOnlyHint: true }
    },
    async ({ messageId, chatJid }: { messageId: string; chatJid?: string }) => {
      if (!isValidMessageId(messageId)) {
        const failure: GetMessageMediaResult = {
          ok: false, messageId, error: 'Invalid messageId', errorKind: 'message_not_found'
        }
        return { content: [{ type: 'text', text: 'Invalid messageId' }], isError: true, structuredContent: failure }
      }

      const result = await resolveMedia(slug, messageId)
      if (!result.ok) {
        const failure: GetMessageMediaResult = {
          ok: false, messageId,
          error: chatJid ? `${result.failure.error} (chat ${chatJid})` : result.failure.error,
          errorKind: result.failure.errorKind
        }
        return { content: [{ type: 'text', text: failure.error }], isError: true, structuredContent: failure }
      }

      const { media } = result
      const url = `${buildMediaBaseUrl(slug)}/${encodeURIComponent(messageId)}`

      const labelMap: Record<MediaAttachmentKind, string> = {
        image: 'Image', voice: 'Voice note', audio: 'Audio',
        video: 'Video', document: 'Document', sticker: 'Sticker'
      }
      const summaryParts = [labelMap[media.kind]]
      if (media.durationSeconds) summaryParts.push(`${media.durationSeconds}s`)
      summaryParts.push(formatBytes(media.fileSize))
      const summary = summaryParts.join(' · ')

      const baseSuccess = {
        ok: true as const, messageId, kind: media.kind, mimeType: media.mimeType,
        filename: media.filename, fileSize: media.fileSize, url,
        ...(media.durationSeconds !== undefined ? { durationSeconds: media.durationSeconds } : {})
      }

      if (media.fileSize > maxInlineToolBytes) {
        const text = `${summary} — too large to return inline; fetch via ${url}`
        const success: GetMessageMediaResult = { ...baseSuccess, returnedAs: 'link' }
        return {
          content: [
            { type: 'text', text },
            { type: 'resource_link', uri: url, mimeType: media.mimeType, name: media.filename }
          ],
          structuredContent: success
        }
      }

      const buffer = fs.readFileSync(media.filepath)
      const data = buffer.toString('base64')
      let mediaBlock: any
      if (media.kind === 'image') {
        mediaBlock = { type: 'image', data, mimeType: media.mimeType }
      } else if (media.kind === 'voice' || media.kind === 'audio') {
        mediaBlock = { type: 'audio', data, mimeType: media.mimeType }
      } else {
        mediaBlock = { type: 'resource', resource: { uri: url, mimeType: media.mimeType, blob: data, name: media.filename } }
      }

      const success: GetMessageMediaResult = { ...baseSuccess, returnedAs: 'inline' }
      return {
        content: [{ type: 'text', text: summary }, mediaBlock],
        structuredContent: success
      }
    }
  )

  return server
}

/**
 * Lazy-init and return the McpServer for a given slug.
 */
function getOrCreateMcpServer(slug: string): McpServer {
  let server = mcpServers.get(slug)
  if (!server) {
    server = createMcpServer(slug)
    mcpServers.set(slug, server)
  }
  return server
}

/**
 * Evict any cached McpServer + active transports for a slug. Call this when
 * the account's enabled flag flips or the account is removed so the next
 * request will re-check the account registry.
 */
export function refreshAccount(slug: string): void {
  mcpServers.delete(slug)
  const prefix = `${slug}::`
  for (const [key, transport] of activeTransports) {
    if (key.startsWith(prefix)) {
      transport.close().catch(() => { /* ignore */ })
      activeTransports.delete(key)
    }
  }
}

// Match /mcp or /mcp/<slug> with optional trailing slash; capture the slug.
const MCP_PATH_RE = /^\/mcp(?:\/([^/]+))?\/?$/

interface RouteResolution {
  ok: true
  slug: string
}
interface RouteFailure {
  ok: false
  status: number
  body: { error: string }
}

function isRouteFailure(r: RouteResolution | RouteFailure): r is RouteFailure {
  return r.ok === false
}

function resolveRoute(pathname: string): RouteResolution | RouteFailure | null {
  const match = MCP_PATH_RE.exec(pathname)
  if (!match) return null

  const rawSlug = match[1]
  let slug: string | null
  if (!rawSlug) {
    slug = getDefaultSlug()
    if (!slug) {
      return { ok: false, status: 404, body: { error: 'No default account configured' } }
    }
  } else {
    slug = rawSlug
  }

  const account = getAccount(slug)
  if (!account) {
    return { ok: false, status: 404, body: { error: `Unknown account: ${slug}` } }
  }
  if (account.mcpEnabled === false) {
    return { ok: false, status: 503, body: { error: `Account ${slug} is disabled (re-link required)` } }
  }

  return { ok: true, slug }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

let transportCounter = 0

// Match /media/<slug>/<messageId> with optional trailing slash.
const MEDIA_PATH_RE = /^\/media\/([^/]+)\/([^/]+)\/?$/

/**
 * Handle `GET`/`HEAD /media/<slug>/<messageId>`. Streams cached bytes from
 * disk, lazily downloading via Baileys on first request. Loopback-only —
 * shares the trust model with the `/mcp` endpoint.
 */
async function handleMediaRequest(
  method: string,
  pathname: string,
  res: http.ServerResponse
): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    sendJson(res, 405, { error: 'Method Not Allowed' })
    return
  }

  const match = MEDIA_PATH_RE.exec(pathname)
  if (!match) {
    sendJson(res, 400, { error: 'Invalid media path' })
    return
  }
  const slug = match[1]
  let messageId: string
  try { messageId = decodeURIComponent(match[2]) } catch { messageId = match[2] }

  if (!isValidMessageId(messageId)) {
    sendJson(res, 400, { error: 'Invalid messageId' })
    return
  }

  const account = getAccount(slug)
  if (!account) {
    sendJson(res, 404, { error: `Unknown account: ${slug}` })
    return
  }

  const result = await resolveMedia(slug, messageId)
  if (!result.ok) {
    sendJson(res, result.failure.httpStatus, { error: result.failure.error })
    return
  }

  const { media } = result
  res.statusCode = 200
  res.setHeader('Content-Type', media.mimeType)
  res.setHeader('Content-Length', String(media.fileSize))
  res.setHeader('Content-Disposition', buildContentDisposition(media.filename))
  res.setHeader('Cache-Control', 'private, max-age=3600')

  if (method === 'HEAD') {
    res.end()
    return
  }

  const stream = fs.createReadStream(media.filepath)
  stream.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 502, { error: err.message })
    else res.destroy(err)
  })
  stream.pipe(res)
}

async function handleMcpRequest(
  slug: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  const body = Buffer.concat(chunks).toString()

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  // Key by slug + a monotonic id; stateless transports have no sessionId.
  const transportKey = `${slug}::${transport.sessionId ?? `req-${++transportCounter}`}`
  activeTransports.set(transportKey, transport)

  const server = getOrCreateMcpServer(slug)
  await server.connect(transport)

  const cleanup = () => {
    activeTransports.delete(transportKey)
    transport.close().catch(() => { /* ignore */ })
  }
  res.on('close', cleanup)

  try {
    const parsedBody = body ? JSON.parse(body) : undefined
    await transport.handleRequest(req, res, parsedBody)
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' })
  }
}

/**
 * Start the MCP HTTP server on the specified port.
 */
export async function startMcpServer(port: number): Promise<void> {
  if (httpServer) {
    throw new Error('MCP server is already running')
  }

  httpServer = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET'
      const url = req.url || '/'
      const pathname = url.split('?')[0] ?? '/'

      if (method === 'GET' && pathname === '/health') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        const managers: Record<string, string> = {}
        const defaultSlug = getDefaultSlug()
        if (defaultSlug) {
          managers[defaultSlug] = getManager(defaultSlug)?.state || 'unknown'
        }
        res.end(JSON.stringify({ status: 'ok', whatsapp: defaultSlug ? managers[defaultSlug] : 'unknown' }))
        return
      }

      // Dispatch /media/* before /mcp/* so the media route never falls
      // through to the MCP transport handler.
      if (pathname.startsWith('/media/')) {
        await handleMediaRequest(method, pathname, res)
        return
      }

      if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
        res.statusCode = 404
        res.end('Not Found')
        return
      }

      const route = resolveRoute(pathname)
      if (route === null) {
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      if (isRouteFailure(route)) {
        sendJson(res, route.status, route.body)
        return
      }

      // Only POST is currently handled end-to-end (matches existing behavior).
      // GET/DELETE on known /mcp paths fall through as 404 until streaming
      // session support is added.
      if (method !== 'POST') {
        res.statusCode = 404
        res.end('Not Found')
        return
      }

      await handleMcpRequest(route.slug, req, res)
    } catch (error) {
      console.error('[MCP] Unhandled request error:', error)
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' })
      }
    }
  })

  return new Promise((resolve, reject) => {
    const server = httpServer!
    const onError = (err: NodeJS.ErrnoException) => {
      // Reset module-level state so the caller can retry startMcpServer()
      // after the underlying conflict (e.g. EADDRINUSE) is resolved.
      server.removeAllListeners('error')
      server.removeAllListeners('listening')
      if (httpServer === server) {
        httpServer = null
      }
      try { server.close(() => { /* ignore */ }) } catch { /* ignore */ }
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use`))
      } else {
        reject(err)
      }
    }

    server.on('error', onError)

    server.listen(port, '127.0.0.1', () => {
      console.log(`MCP server listening on http://127.0.0.1:${port}/mcp`)
      resolve()
    })
  })
}

/**
 * Stop the MCP HTTP server and tear down all per-account state.
 */
export async function stopMcpServer(): Promise<void> {
  if (!httpServer) return

  return new Promise((resolve) => {
    for (const transport of activeTransports.values()) {
      transport.close().catch(() => { /* ignore */ })
    }
    activeTransports.clear()
    mcpServers.clear()

    httpServer!.close(() => {
      httpServer = null
      console.log('MCP server stopped')
      resolve()
    })
  })
}

/**
 * Check if MCP server is running.
 */
export function isMcpServerRunning(): boolean {
  return httpServer !== null && httpServer.listening
}

/**
 * Get/set the global MCP port (thin wrappers over global-settings).
 */
export function getMcpPort(): number {
  return getGlobalMcpPort()
}

export function setMcpPort(port: number): void {
  setGlobalMcpPort(port)
}

