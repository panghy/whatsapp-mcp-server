import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import http from 'http'
import { chatOps, messageOps, settingOps, contactOps, getDatabase } from './database'
import { serializeCompact, MeIdentity } from './compact-serializer'
import { TransformedMessage, extractPhoneFromJid } from './message-transformer'
import type { WhatsAppManager } from './whatsapp-manager'

// Store for active transports (for session management)
const activeTransports = new Map<string, StreamableHTTPServerTransport>()

/**
 * Get meIdentity from settings (user_display_name, user_phone).
 */
function getMeIdentity(): MeIdentity | undefined {
  const name = settingOps.get('user_display_name')
  const phone = settingOps.get('user_phone')
  if (name && phone) {
    return { name, phone }
  }
  return undefined
}

/**
 * Resolve sender identity from contacts database.
 * Uses JID lookup, LID fallback, then phone fallback.
 */
function resolveFromContacts(
  senderJid: string,
  fallback: { name: string; phone: string | null }
): { name: string; phone: string | null } {
  // Always look up contact — don't skip based on current name
  let contact = contactOps.getByJid(senderJid) as any

  // LID fallback: if JID is a LID and we didn't find a name, try getByLid
  if ((!contact?.name) && (senderJid.includes('@lid') || senderJid.includes('@hosted.lid'))) {
    const lidContact = contactOps.getByLid(senderJid) as any
    if (lidContact) {
      contact = lidContact
    }
  }

  // Phone fallback: if still no name, try phone lookup
  const phone = fallback.phone || extractPhoneFromJid(senderJid) || contact?.phone_number
  if ((!contact?.name) && phone) {
    const phoneContact = contactOps.getByPhone(phone) as any
    if (phoneContact) {
      contact = phoneContact
    }
  }

  // Use contact data if available, otherwise keep fallback
  const resolvedName = contact?.name || fallback.name
  const resolvedPhone = contact?.phone_number || phone || fallback.phone

  // Apply display rules (no bare "Unknown")
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
function reResolveAllMentions(text: string, mentionedJids: string[]): string {
  let resolvedText = text

  for (const jid of mentionedJids) {
    let contact = contactOps.getByJid(jid) as any

    if ((!contact || !contact.name) && (jid.includes('@lid') || jid.includes('@hosted.lid'))) {
      const lidContact = contactOps.getByLid(jid) as any
      if (lidContact) contact = lidContact
    }

    const atIndex = jid.indexOf('@')
    const numberPart = atIndex > 0 ? jid.substring(0, atIndex) : jid

    if ((!contact || !contact.name) && numberPart) {
      const phoneContact = contactOps.getByPhone(numberPart) as any
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
function reResolveMentionsInText(text: string): string {
  const mentionPattern = /@Unknown_([^\s@]+@(?:s\.whatsapp\.net|lid|hosted\.lid))/g

  return text.replace(mentionPattern, (match, jid) => {
    let contact = contactOps.getByJid(jid) as any

    if (!contact && (jid.includes('@lid') || jid.includes('@hosted.lid'))) {
      contact = contactOps.getByLid(jid) as any
    }

    if (contact) {
      const name = contact.name || null
      const phone = contact.phone_number || null

      if (name && phone && name !== phone) {
        return `@${name}:${phone}`
      }
      if (phone) {
        return `@${phone}`
      }
      if (name) {
        return `@${name}`
      }
    }

    return match
  })
}

/**
 * Resolve all identity fields in a message.
 * Handles sender, replyTo, deferred replies, deletedBy, editedBy, mentions.
 */
function resolveAllIdentities(
  msg: any,
  parsed: TransformedMessage,
  meIdentity?: MeIdentity
): TransformedMessage {
  const senderJid = msg.sender_jid

  // 1. Primary sender
  if (parsed.sender) {
    parsed.sender = resolveFromContacts(senderJid, parsed.sender)
  }

  // 1b. Defensive isFromMe
  if (meIdentity && !parsed.isFromMe) {
    const senderPhone = extractPhoneFromJid(senderJid)
    if (senderPhone && senderPhone === meIdentity.phone) {
      parsed.isFromMe = true
    }
  }

  // 1c. Mentions
  if (parsed.text) {
    if (parsed.mentionedJids && parsed.mentionedJids.length > 0) {
      parsed.text = reResolveAllMentions(parsed.text, parsed.mentionedJids)
    } else {
      parsed.text = reResolveMentionsInText(parsed.text)
    }
  }

  // 2. Reply sender
  if (parsed.replyTo && parsed.replyTo.messageId) {
    const originalMsg = messageOps.getByWhatsappMessageId(parsed.replyTo.messageId) as any
    if (originalMsg) {
      const resolved = resolveFromContacts(originalMsg.sender_jid, {
        name: parsed.replyTo.senderName || 'Unknown',
        phone: parsed.replyTo.senderPhone || null
      })
      parsed.replyTo.senderName = resolved.name
      parsed.replyTo.senderPhone = resolved.phone
    }
  }

  // 2b. Deferred reply
  if (!parsed.replyTo && parsed.replyToMessageId) {
    const original = messageOps.getByWhatsappMessageId(parsed.replyToMessageId) as any
    if (original) {
      try {
        const content = JSON.parse(original.content_json)
        const resolved = resolveFromContacts(original.sender_jid, { name: 'Unknown', phone: null })
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

  // 3. deletedBy
  if (parsed.deletedBy) {
    parsed.deletedBy = resolveFromContacts(senderJid, parsed.deletedBy)
  }

  // 4. editedBy
  if (parsed.editedBy) {
    parsed.editedBy = resolveFromContacts(senderJid, parsed.editedBy)
  }

  // 5. deletedMessage.sender
  if (parsed.deletedMessage?.sender && parsed.deletedMessage.messageId) {
    const original = messageOps.getByWhatsappMessageId(parsed.deletedMessage.messageId) as any
    if (original) {
      parsed.deletedMessage.sender = resolveFromContacts(original.sender_jid, parsed.deletedMessage.sender)
    }
  }

  // 6. editedMessage.sender
  if (parsed.editedMessage?.sender && parsed.editedMessage.messageId) {
    const original = messageOps.getByWhatsappMessageId(parsed.editedMessage.messageId) as any
    if (original) {
      parsed.editedMessage.sender = resolveFromContacts(original.sender_jid, parsed.editedMessage.sender)
    }
  }

  return parsed
}

let mcpServer: McpServer | null = null
let httpServer: http.Server | null = null
let whatsappManager: WhatsAppManager | null = null

/**
 * Set the WhatsApp manager instance for sending messages
 */
export function setWhatsAppManager(manager: WhatsAppManager): void {
  whatsappManager = manager
}

/**
 * Initialize and configure the MCP server with all tools
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'whatsapp-mcp-server',
    version: '1.0.0'
  })

  // Tool 1: search_chats - Search chats by phone number or name fragment
  server.tool(
    'search_chats',
    'Search chats by phone number or name fragment',
    {
      query: z.string().describe('Phone number or name fragment to search for')
    },
    { readOnlyHint: true },
    async ({ query }: { query: string }) => {
      const allChats = chatOps.getAll() as any[]
      const results = allChats.filter((chat: any) => {
        const name = chat.name?.toLowerCase() || ''
        const jid = chat.whatsapp_jid?.toLowerCase() || ''
        const q = query.toLowerCase()
        return name.includes(q) || jid.includes(q)
      }).map((chat: any) => ({
        jid: chat.whatsapp_jid,
        name: chat.name || 'Unknown',
        type: chat.chat_type,
        lastActivity: chat.last_activity
      }))

      return {
        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
      }
    }
  )

  // Tool 2: get_chat_history - Get messages for a specific chat
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
      const chat = chatOps.getByWhatsappJid(jid) as any
      if (!chat) {
        return { content: [{ type: 'text', text: `Chat not found: ${jid}` }], isError: true }
      }

      let messages = messageOps.getByChatId(chat.id, limit || 100) as any[]

      // Filter by timestamp if provided
      if (since) {
        const sinceTs = new Date(since).getTime()
        messages = messages.filter((m: any) => m.timestamp >= sinceTs)
      }

      const meIdentity = getMeIdentity()

      // Parse, resolve identities, and serialize messages
      const transformed = messages.map((m: any) => {
        try {
          const parsed = JSON.parse(m.content_json) as TransformedMessage
          return resolveAllIdentities(m, parsed, meIdentity)
        }
        catch { return null }
      }).filter((m): m is TransformedMessage => m !== null).reverse()

      const output = serializeCompact(transformed, undefined, meIdentity)
      return { content: [{ type: 'text', text: output || '(no messages)' }] }
    }
  )

  // Tool 3: get_recent_messages - Get messages across all chats since a timestamp
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
      const db = getDatabase()
      const messages = db.prepare(`
        SELECT m.*, c.whatsapp_jid, c.name as chat_name, c.chat_type
        FROM messages m
        JOIN chats c ON m.chat_id = c.id
        WHERE m.timestamp >= ?
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(sinceTs, limit || 200) as any[]

      const meIdentity = getMeIdentity()

      // Group by chat for readable output
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
            return resolveAllIdentities(m, parsed, meIdentity)
          }
          catch { return null }
        }).filter((m): m is TransformedMessage => m !== null).reverse()
        output += serializeCompact(transformed, undefined, meIdentity) + '\n'
      }

      return { content: [{ type: 'text', text: output || '(no recent messages)' }] }
    }
  )

  // Tool 4: get_unread_messages - Get unread/new messages across all chats
  server.tool(
    'get_unread_messages',
    'Get unread/new messages across all chats',
    {
      since: z.string().optional().describe('ISO timestamp cutoff (defaults to last check time or 24h ago)')
    },
    { readOnlyHint: true },
    async ({ since }: { since?: string }) => {
      // Get last check time from settings, or default to 24h ago
      const lastCheck = settingOps.get('last_unread_check')
      const defaultSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const sinceStr = since || lastCheck || defaultSince
      const sinceTs = new Date(sinceStr).getTime()

      const db = getDatabase()
      const messages = db.prepare(`
        SELECT m.*, c.whatsapp_jid, c.name as chat_name, c.chat_type
        FROM messages m
        JOIN chats c ON m.chat_id = c.id
        WHERE m.timestamp >= ?
        ORDER BY m.timestamp DESC
        LIMIT 500
      `).all(sinceTs) as any[]

      // Update last check time
      settingOps.set('last_unread_check', new Date().toISOString())

      const meIdentity = getMeIdentity()

      // Group by chat
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
            return resolveAllIdentities(m, parsed, meIdentity)
          }
          catch { return null }
        }).filter((m): m is TransformedMessage => m !== null).reverse()
        output += serializeCompact(transformed, undefined, meIdentity) + '\n'
      }

      return { content: [{ type: 'text', text: output || '(no unread messages)' }] }
    }
  )

  // Tool 5: send_message - Send a text message with optional attachment
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
      if (!whatsappManager?.socket) {
        return {
          content: [{ type: 'text', text: 'WhatsApp is not connected' }],
          isError: true
        }
      }

      try {
        const socket = whatsappManager.socket

        if (attachmentPath) {
          // Send with attachment
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

          // Determine message type based on extension
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
          // Send text only
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
 * Start the MCP HTTP server on the specified port
 */
export async function startMcpServer(port: number): Promise<void> {
  if (httpServer) {
    throw new Error('MCP server is already running')
  }

  mcpServer = createMcpServer()

  httpServer = http.createServer(async (req, res) => {
    try {
      // Only handle POST /mcp endpoint
      if (req.method === 'POST' && req.url === '/mcp') {
        // Collect request body
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk as Buffer)
        }
        const body = Buffer.concat(chunks).toString()

        // Create transport for this request (stateless mode)
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined // stateless
        })

        // Connect server to transport
        await mcpServer!.connect(transport)

        // Clean up when connection closes
        res.on('close', () => {
          transport.close()
        })

        // Handle the request
        try {
          const parsedBody = JSON.parse(body)
          await transport.handleRequest(req, res, parsedBody)
        } catch (error) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Invalid JSON' }))
        }
      } else if (req.method === 'GET' && req.url === '/health') {
        // Health check endpoint
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ status: 'ok', whatsapp: whatsappManager?.state || 'unknown' }))
      } else {
        res.statusCode = 404
        res.end('Not Found')
      }
    } catch (error) {
      console.error('[MCP] Unhandled request error:', error)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    }
  })

  // Bind to localhost only (security: no external access)
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
 * Stop the MCP HTTP server
 */
export async function stopMcpServer(): Promise<void> {
  if (httpServer) {
    return new Promise((resolve) => {
      // Close all active transports
      for (const transport of activeTransports.values()) {
        transport.close()
      }
      activeTransports.clear()

      httpServer!.close(() => {
        httpServer = null
        mcpServer = null
        console.log('MCP server stopped')
        resolve()
      })
    })
  }
}

/**
 * Check if MCP server is running
 */
export function isMcpServerRunning(): boolean {
  return httpServer !== null && httpServer.listening
}

/**
 * Get the current MCP server port (from settings or default)
 */
export function getMcpPort(): number {
  const portStr = settingOps.get('mcp_port')
  return portStr ? parseInt(portStr, 10) : 13491 // Default port
}

/**
 * Set the MCP server port in settings
 */
export function setMcpPort(port: number): void {
  settingOps.set('mcp_port', String(port))
}

