import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import http from 'http'
import { chatOps, messageOps, settingOps, contactOps, getDatabase } from './database'
import { serializeCompact, MeIdentity } from './compact-serializer'
import { TransformedMessage, extractPhoneFromJid } from './message-transformer'
import { getAccount, getDefaultSlug } from './accounts'
import { getManager } from './whatsapp-manager'
import { getMcpPort as getGlobalMcpPort, setMcpPort as setGlobalMcpPort } from './global-settings'

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
 * Resolve sender identity from contacts database.
 */
function resolveFromContacts(
  slug: string,
  senderJid: string,
  fallback: { name: string; phone: string | null }
): { name: string; phone: string | null } {
  let contact = contactOps.getByJid(slug, senderJid) as any

  if ((!contact?.name) && (senderJid.includes('@lid') || senderJid.includes('@hosted.lid'))) {
    const lidContact = contactOps.getByLid(slug, senderJid) as any
    if (lidContact) contact = lidContact
  }

  const phone = fallback.phone || extractPhoneFromJid(senderJid) || contact?.phone_number
  if ((!contact?.name) && phone) {
    const phoneContact = contactOps.getByPhone(slug, phone) as any
    if (phoneContact) contact = phoneContact
  }

  const resolvedName = contact?.name || fallback.name
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

    if ((!contact || !contact.name) && (jid.includes('@lid') || jid.includes('@hosted.lid'))) {
      const lidContact = contactOps.getByLid(slug, jid) as any
      if (lidContact) contact = lidContact
    }

    const atIndex = jid.indexOf('@')
    const numberPart = atIndex > 0 ? jid.substring(0, atIndex) : jid

    if ((!contact || !contact.name) && numberPart) {
      const phoneContact = contactOps.getByPhone(slug, numberPart) as any
      if (phoneContact) contact = phoneContact
    }

    const name = contact?.name || null
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
      const name = contact.name || null
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

  if (parsed.sender) {
    parsed.sender = resolveFromContacts(slug, senderJid, parsed.sender)
  }

  if (meIdentity && !parsed.isFromMe) {
    const senderPhone = extractPhoneFromJid(senderJid)
    if (senderPhone && senderPhone === meIdentity.phone) {
      parsed.isFromMe = true
    }
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
 * Build an McpServer whose tool handlers are bound to the given account slug.
 */
export function createMcpServer(slug: string): McpServer {
  const server = new McpServer({
    name: `whatsapp-mcp-server:${slug}`,
    version: '1.0.0'
  })

  server.tool(
    'search_chats',
    'Search chats by name or associated contact name, with typo tolerance and phone-number matching. Multi-word queries match chats that contain any of the words; chats matching more words rank higher (bm25). Typos are tolerated via trigram fuzzy matching when available. Digit-only queries of 5+ digits also match contacts by normalized phone number (digits only, ignoring +, -, spaces, parentheses), surfacing the matching DM chat. Results are ranked by relevance with recent activity as a tiebreaker and capped by `limit`.',
    {
      query: z.string().describe('Search query: name fragment, multiple words, or a phone number'),
      limit: z.number().optional().default(20).describe('Maximum number of results to return (default 20, capped at 100)')
    },
    { readOnlyHint: true },
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
          JOIN chats c ON c.whatsapp_jid = ct.jid AND c.chat_type = 'dm'
          WHERE ct.phone_digits IS NOT NULL AND ct.phone_digits LIKE '%' || ? || '%'
        `).all(digitQuery) as { chatId: number }[]
        for (const r of phoneRows) upsert({ chatId: r.chatId, rank: -1e6, matchedVia: 'phone' })
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

      if (hits.size === 0) {
        return { content: [{ type: 'text', text: JSON.stringify([], null, 2) }] }
      }

      const ids = Array.from(hits.keys())
      const placeholders = ids.map(() => '?').join(',')
      const chats = db.prepare(
        `SELECT * FROM chats WHERE id IN (${placeholders}) AND enabled = 1`
      ).all(...ids) as any[]

      const results = chats.map((chat: any) => {
        const h = hits.get(chat.id)!
        return {
          jid: chat.whatsapp_jid,
          name: chat.name || 'Unknown',
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

      return { content: [{ type: 'text', text: JSON.stringify(results.slice(0, cap), null, 2) }] }
    }
  )

  server.tool(
    'get_chat_history',
    'Get messages for a specific chat',
    {
      jid: z.string().describe('WhatsApp JID of the chat'),
      limit: z.number().optional().default(100).describe('Maximum number of messages to return'),
      since: z.string().optional().describe('ISO timestamp cutoff - only return messages after this time')
    },
    { readOnlyHint: true },
    async ({ jid, limit, since }: { jid: string; limit: number; since?: string }) => {
      const chat = chatOps.getByWhatsappJid(slug, jid) as any
      if (!chat) {
        return { content: [{ type: 'text', text: `Chat not found: ${jid}` }], isError: true }
      }
      if (!chat.enabled) {
        return { content: [{ type: 'text', text: `Chat is disabled: ${jid}` }], isError: true }
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
      return { content: [{ type: 'text', text: output || '(no messages)' }] }
    }
  )

  server.tool(
    'get_recent_messages',
    'Get messages across all chats since a timestamp',
    {
      since: z.string().describe('ISO timestamp cutoff - return messages after this time'),
      limit: z.number().optional().default(200).describe('Maximum total messages to return')
    },
    { readOnlyHint: true },
    async ({ since, limit }: { since: string; limit: number }) => {
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

      const byChat = new Map<string, any[]>()
      for (const m of messages) {
        const key = m.chat_name || m.whatsapp_jid
        if (!byChat.has(key)) byChat.set(key, [])
        byChat.get(key)!.push(m)
      }

      let output = ''
      for (const [chatName, msgs] of byChat) {
        output += `\n=== ${chatName} ===\n`
        const transformed = msgs.map((m: any) => {
          try {
            const parsed = JSON.parse(m.content_json) as TransformedMessage
            return resolveAllIdentities(slug, m, parsed, meIdentity)
          }
          catch { return null }
        }).filter((m): m is TransformedMessage => m !== null).reverse()
        output += serializeCompact(transformed, undefined, meIdentity) + '\n'
      }

      return { content: [{ type: 'text', text: output || '(no recent messages)' }] }
    }
  )

  server.tool(
    'get_unread_messages',
    'Get unread/new messages across all chats',
    { since: z.string().optional().describe('ISO timestamp cutoff (defaults to last check time or 24h ago)') },
    { readOnlyHint: true },
    async ({ since }: { since?: string }) => {
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

      const byChat = new Map<string, any[]>()
      for (const m of messages) {
        const key = m.chat_name || m.whatsapp_jid
        if (!byChat.has(key)) byChat.set(key, [])
        byChat.get(key)!.push(m)
      }

      let output = `Messages since ${sinceStr}:\n`
      for (const [chatName, msgs] of byChat) {
        output += `\n=== ${chatName} ===\n`
        const transformed = msgs.map((m: any) => {
          try {
            const parsed = JSON.parse(m.content_json) as TransformedMessage
            return resolveAllIdentities(slug, m, parsed, meIdentity)
          }
          catch { return null }
        }).filter((m): m is TransformedMessage => m !== null).reverse()
        output += serializeCompact(transformed, undefined, meIdentity) + '\n'
      }

      return { content: [{ type: 'text', text: output || '(no unread messages)' }] }
    }
  )

  server.tool(
    'send_message',
    'Send a text message with optional attachment',
    {
      jid: z.string().describe('WhatsApp JID to send the message to'),
      text: z.string().describe('Message text to send'),
      attachmentPath: z.string().optional().describe('Optional path to a file to attach')
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ jid, text, attachmentPath }: { jid: string; text: string; attachmentPath?: string }) => {
      const socket = getManager(slug)?.socket
      if (!socket) {
        return { content: [{ type: 'text', text: 'WhatsApp is not connected' }], isError: true }
      }

      try {
        if (attachmentPath) {
          const fs = await import('fs')
          const path = await import('path')

          if (!fs.existsSync(attachmentPath)) {
            return {
              content: [{ type: 'text', text: `Attachment file not found: ${attachmentPath}` }],
              isError: true
            }
          }

          const buffer = fs.readFileSync(attachmentPath)
          const filename = path.basename(attachmentPath)
          const ext = path.extname(attachmentPath).toLowerCase()

          const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
          const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']

          if (imageExts.includes(ext)) {
            await socket.sendMessage(jid, { image: buffer, caption: text })
          } else if (docExts.includes(ext)) {
            await socket.sendMessage(jid, { document: buffer, fileName: filename, caption: text })
          } else {
            await socket.sendMessage(jid, { document: buffer, fileName: filename, caption: text })
          }
        } else {
          await socket.sendMessage(jid, { text })
        }

        return { content: [{ type: 'text', text: `Message sent to ${jid}` }] }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text', text: `Failed to send message: ${errMsg}` }],
          isError: true
        }
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
    httpServer!.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use`))
      } else {
        reject(err)
      }
    })

    httpServer!.listen(port, '127.0.0.1', () => {
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

