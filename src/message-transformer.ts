import { messageOps, logOps, chatOps } from './database'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

// Dynamic imports for ESM modules
let proto: any
let downloadMediaMessageFn: any

// Load ESM modules dynamically
async function loadBaileysModules() {
  if (!proto) {
    const baileys = await import('@whiskeysockets/baileys')
    proto = baileys.proto
    downloadMediaMessageFn = baileys.downloadMediaMessage
  }
}

// Re-export messageOps for use in processMessage
export { messageOps }

const ATTACHMENTS_DIR = path.join(app.getPath('userData'), 'nodexa-whatsapp', 'attachments')
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024 // 5MB
const SUPPORTED_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]

/**
 * Extract timestamp in milliseconds from a Baileys message timestamp.
 */
function extractTimestampMs(ts: any): number {
  let seconds: number | null = null
  if (typeof ts === 'number') {
    seconds = ts
  } else if (ts && typeof ts === 'object' && typeof ts.toNumber === 'function') {
    try { seconds = ts.toNumber() } catch { seconds = null }
  } else if (ts && typeof ts === 'object' && typeof ts.low === 'number') {
    seconds = (ts.high >>> 0) * 0x100000000 + (ts.low >>> 0)
  } else if (typeof ts === 'string' && ts.length > 0) {
    const parsed = parseInt(ts, 10)
    if (!isNaN(parsed)) seconds = parsed
  }
  if (seconds === null || seconds <= 0) return Date.now()
  const ms = seconds * 1000
  const now = Date.now()
  const year2000 = 946684800000
  if (ms < year2000 || ms > now + 86400000) return Date.now()
  return ms
}

/**
 * Extract phone number from WhatsApp JID.
 */
export function extractPhoneFromJid(jid: string): string | null {
  const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/)
  return match ? `+${match[1]}` : null
}

/**
 * Normalize a phone number to +E.164 format.
 */
export function normalizePhoneNumber(input: string | undefined | null): string | null {
  if (!input) return null
  const jidMatch = input.match(/^(\d+)@(s\.whatsapp\.net|c\.us)$/)
  if (jidMatch) { return `+${jidMatch[1]}` }
  const stripped = input.replace(/[^\d+]/g, '')
  const digits = stripped.replace(/\D/g, '')
  if (digits.length < 7) return null
  return `+${digits}`
}

export interface TransformedMessage {
  type: 'message' | 'system' | 'unsupported_attachment' | 'message_deleted' | 'message_edited'
  messageId: string
  sender?: { name: string; phone: string | null }
  timestamp: string
  text?: string
  mentionedJids?: string[]
  replyTo?: {
    messageId: string
    senderName: string
    senderPhone: string | null
    fullText: string
    preview: string
  }
  replyToMessageId?: string
  forwarded?: boolean
  isFromMe?: boolean
  systemType?: string
  details?: Record<string, any>
  filename?: string
  mimeType?: string
  fileSize?: number
  reason?: 'unsupported_type' | 'exceeds_size_limit' | 'download_failed'
  deletedMessage?: {
    messageId: string
    text: string | null
    sender?: { name: string; phone: string | null }
    timestamp?: string
  }
  deletedBy?: { name: string; phone: string | null }
  editedMessage?: {
    messageId: string
    originalText: string | null
    newText: string
    sender?: { name: string; phone: string | null }
    timestamp?: string
  }
  editedBy?: { name: string; phone: string | null }
}

export class MessageTransformer {
  constructor(private socket: any) {}

  getSocket(): any {
    return this.socket
  }

  async fetchChatHistory(jid: string): Promise<void> {
    try {
      logOps.insert('info', 'transformer', `History fetch requested for chat ${jid}`)
    } catch (error) {
      logOps.insert('error', 'transformer', `Failed to fetch history for ${jid}`, JSON.stringify({ error: String(error) }))
      throw error
    }
  }

  async processMessage(msg: any, chatId: number): Promise<void> {
    try {
      const transformed = await this.transformMessage(msg)

      if (transformed) {
        const contentJson = JSON.stringify(transformed)
        const hasAttachment = transformed.type === 'unsupported_attachment' ||
                             (transformed.type === 'message' && !!transformed.filename)
        const msgId = msg.key?.id || `msg-${Date.now()}`
        const senderJid = msg.key?.participant || msg.key?.remoteJid || 'unknown'
        const timestamp = extractTimestampMs(msg.messageTimestamp)
        messageOps.insert(chatId, msgId, timestamp, senderJid, contentJson, hasAttachment)
        chatOps.updateLastActivity(chatId, new Date(timestamp).toISOString())
      }
    } catch (error) {
      console.error(`[processMessage] Error processing message:`, error)
      logOps.insert('error', 'transformer', `Failed to process message`, JSON.stringify({ error: String(error) }))
    }
  }

  async processMessageDeletion(key: any, chatId: number, participant?: string): Promise<void> {
    try {
      const original = messageOps.getByWhatsappMessageId(key.id) as any
      let originalText: string | null = null
      let originalSender: { name: string; phone: string | null } | undefined = undefined
      let originalTimestamp: string | undefined = undefined

      if (original) {
        try {
          const content = JSON.parse(original.content_json)
          originalText = content.text || null
          originalSender = content.sender
          originalTimestamp = content.timestamp
        } catch (e) { originalText = null }
      }

      const deletedByJid = participant || key.remoteJid || 'unknown'
      const phone = extractPhoneFromJid(deletedByJid)
      const deletedBy = { name: phone || `Unknown_${deletedByJid}`, phone }

      const deletedMessageEvent: TransformedMessage = {
        type: 'message_deleted',
        messageId: `del-${key.id}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        deletedMessage: { messageId: key.id, text: originalText, sender: originalSender, timestamp: originalTimestamp },
        deletedBy
      }

      const contentJson = JSON.stringify(deletedMessageEvent)
      const timestamp = Date.now()
      messageOps.insert(chatId, `del-${key.id}`, timestamp, deletedByJid, contentJson, false)
      chatOps.updateLastActivity(chatId, new Date(timestamp).toISOString())
    } catch (error) {
      logOps.insert('error', 'transformer', `Failed to process message deletion`, JSON.stringify({ error: String(error) }))
      throw error
    }
  }

  async processMessageEdit(key: any, update: any, chatId: number, participant?: string): Promise<void> {
    try {
      const original = messageOps.getByWhatsappMessageId(key.id) as any
      let originalText: string | null = null
      let originalSender: { name: string; phone: string | null } | undefined
      let originalTimestamp: string | undefined
      if (original?.content_json) {
        try {
          const parsed = JSON.parse(original.content_json)
          originalText = parsed.text || null
          originalSender = parsed.sender
          originalTimestamp = parsed.timestamp
        } catch (e) { }
      }

      const editedMsg = update?.message?.editedMessage?.message || update?.message
      const newText = editedMsg?.conversation || editedMsg?.extendedTextMessage?.text ||
                      editedMsg?.text || '[Unable to extract edited text]'

      const editedByJid = participant || key.remoteJid || 'unknown'
      const phone = extractPhoneFromJid(editedByJid)
      const editedBy = { name: phone || `Unknown_${editedByJid}`, phone }

      const editedMessageEvent: TransformedMessage = {
        type: 'message_edited',
        messageId: `edit-${key.id}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        editedMessage: { messageId: key.id, originalText, newText, sender: originalSender, timestamp: originalTimestamp },
        editedBy
      }

      const contentJson = JSON.stringify(editedMessageEvent)
      const timestamp = Date.now()
      messageOps.insert(chatId, `edit-${key.id}-${Date.now()}`, timestamp, editedByJid, contentJson, false)
      chatOps.updateLastActivity(chatId, new Date(timestamp).toISOString())

      if (original) {
        try {
          const parsed = JSON.parse(original.content_json)
          parsed.text = newText
          messageOps.updateContentJson(key.id, JSON.stringify(parsed))
        } catch (e) { }
      }
    } catch (error) {
      logOps.insert('error', 'transformer', 'Failed to process message edit', JSON.stringify({ error: String(error) }))
      throw error
    }
  }

  private async transformMessage(msg: any): Promise<TransformedMessage | null> {
    if (!msg.key) return null

    const messageId = msg.key.id || `msg-${Date.now()}`
    const timestampMs = extractTimestampMs(msg.messageTimestamp)
    const timestamp = new Date(timestampMs).toISOString()
    const senderJid = msg.key.participant || msg.key.remoteJid || 'unknown'
    const isFromMe = msg.key.fromMe || false

    const phone = extractPhoneFromJid(senderJid)
    const sender = { name: phone || `Unknown_${senderJid}`, phone }

    // Get initial message content
    let messageContent = msg.message
    if (!messageContent) {
      console.log(`[transformMessage] msgId=${messageId} no message content`)
      return null
    }

    const originalKeys = Object.keys(messageContent)
    console.log(`[transformMessage] msgId=${messageId} originalKeys=[${originalKeys.join(', ')}]`)

    // Unwrap wrapper message types
    if (messageContent.ephemeralMessage?.message) {
      messageContent = messageContent.ephemeralMessage.message
      console.log(`[transformMessage] msgId=${messageId} unwrapped ephemeralMessage`)
    }
    if (messageContent.viewOnceMessage?.message) {
      messageContent = messageContent.viewOnceMessage.message
      console.log(`[transformMessage] msgId=${messageId} unwrapped viewOnceMessage`)
    }
    if (messageContent.viewOnceMessageV2?.message) {
      messageContent = messageContent.viewOnceMessageV2.message
      console.log(`[transformMessage] msgId=${messageId} unwrapped viewOnceMessageV2`)
    }
    if (messageContent.documentWithCaptionMessage?.message) {
      messageContent = messageContent.documentWithCaptionMessage.message
      console.log(`[transformMessage] msgId=${messageId} unwrapped documentWithCaptionMessage`)
    }
    if (messageContent.deviceSentMessage?.message) {
      messageContent = messageContent.deviceSentMessage.message
      console.log(`[transformMessage] msgId=${messageId} unwrapped deviceSentMessage`)
    }
    if (messageContent.editedMessage?.message) {
      messageContent = messageContent.editedMessage.message
      console.log(`[transformMessage] msgId=${messageId} unwrapped editedMessage`)
    }

    const unwrappedKeys = Object.keys(messageContent)
    if (unwrappedKeys.join(',') !== originalKeys.join(',')) {
      console.log(`[transformMessage] msgId=${messageId} unwrappedKeys=[${unwrappedKeys.join(', ')}]`)
    }

    if (messageContent.protocolMessage) {
      return this.handleSystemMessage(messageId, timestamp, messageContent)
    }

    if (messageContent.conversation || messageContent.extendedTextMessage) {
      const text = messageContent.conversation || messageContent.extendedTextMessage?.text || ''
      const forwarded = !!messageContent.extendedTextMessage?.contextInfo?.isForwarded
      const mentionedJids = messageContent.extendedTextMessage?.contextInfo?.mentionedJid
      const hasMentions = mentionedJids && Array.isArray(mentionedJids) && mentionedJids.length > 0

      const transformed: TransformedMessage = { type: 'message', messageId, sender, timestamp, text, forwarded, isFromMe }
      if (hasMentions) { transformed.mentionedJids = mentionedJids }
      if (messageContent.extendedTextMessage?.contextInfo?.stanzaId) {
        transformed.replyToMessageId = messageContent.extendedTextMessage.contextInfo.stanzaId
      }
      return transformed
    }

    if (messageContent.imageMessage || messageContent.documentMessage ||
        messageContent.audioMessage || messageContent.videoMessage) {
      return await this.handleAttachment(messageId, timestamp, sender, messageContent, msg)
    }

    console.log(`[transformMessage] msgId=${messageId} unrecognized type, keys=[${unwrappedKeys.join(', ')}]`)
    return null
  }

  private handleSystemMessage(messageId: string, timestamp: string, messageContent: any): TransformedMessage | null {
    const protocolMsg = messageContent.protocolMessage
    if (!protocolMsg) return null
    if (protocolMsg.type === 5) {
      return {
        type: 'system', messageId, timestamp, systemType: 'number_change',
        details: { userName: 'Unknown', oldNumber: 'unknown', newNumber: 'unknown' }
      }
    }
    return null
  }

  private async handleAttachment(
    messageId: string, timestamp: string, sender: { name: string; phone: string | null }, messageContent: any, originalMsg: any
  ): Promise<TransformedMessage | null> {
    const attachment = messageContent.imageMessage || messageContent.documentMessage ||
                      messageContent.audioMessage || messageContent.videoMessage
    if (!attachment) return null

    const mimeType = (attachment as any).mimetype || 'application/octet-stream'
    const filename = (attachment as any).filename || `attachment_${messageId}`
    let fileSize = (attachment as any).fileLength || 0
    if (typeof fileSize === 'object' && fileSize?.low !== undefined) {
      fileSize = fileSize.low + (fileSize.high || 0) * 0x100000000
    }

    const contextInfo = (messageContent.imageMessage?.contextInfo || messageContent.documentMessage?.contextInfo ||
                         messageContent.audioMessage?.contextInfo || messageContent.videoMessage?.contextInfo)

    const isFromMe = originalMsg.key?.fromMe || false

    const applyReplyInfo = (result: TransformedMessage): TransformedMessage => {
      if (contextInfo?.stanzaId) { result.replyToMessageId = contextInfo.stanzaId }
      return result
    }

    if (!SUPPORTED_MIME_TYPES.includes(mimeType)) {
      return applyReplyInfo({ type: 'unsupported_attachment', messageId, sender, timestamp, filename, mimeType, fileSize, reason: 'unsupported_type', isFromMe })
    }

    if (fileSize > MAX_ATTACHMENT_SIZE) {
      return applyReplyInfo({ type: 'unsupported_attachment', messageId, sender, timestamp, filename, mimeType, fileSize, reason: 'exceeds_size_limit', isFromMe })
    }

    try {
      await this.downloadAttachment(messageId, originalMsg)
      return applyReplyInfo({ type: 'message', messageId, sender, timestamp, text: `[Attachment: ${filename}]`, filename, mimeType, isFromMe })
    } catch (error) {
      logOps.insert('error', 'transformer', `Failed to download attachment ${messageId}`, JSON.stringify({ error: String(error) }))
      return applyReplyInfo({ type: 'unsupported_attachment', messageId, sender, timestamp, filename, mimeType, fileSize, reason: 'download_failed', isFromMe })
    }
  }

  private async downloadAttachment(messageId: string, msg: any): Promise<void> {
    await loadBaileysModules()
    const attachment = msg.message?.imageMessage || msg.message?.documentMessage ||
                      msg.message?.audioMessage || msg.message?.videoMessage
    const attachmentDir = path.join(ATTACHMENTS_DIR, messageId)
    if (!fs.existsSync(attachmentDir)) { fs.mkdirSync(attachmentDir, { recursive: true }) }

    const filename = attachment?.filename || `attachment_${messageId}`
    const filepath = path.join(attachmentDir, filename)

    if (downloadMediaMessageFn) {
      const buffer = await downloadMediaMessageFn(msg, 'buffer', {})
      fs.writeFileSync(filepath, buffer)
      return
    }

    if (attachment?.url) {
      const axios = require('axios')
      const response = await axios.get(attachment.url, { responseType: 'arraybuffer' })
      fs.writeFileSync(filepath, response.data)
      return
    }

    throw new Error('No download method available')
  }
}

export async function initializeMessageTransformer(socket: any): Promise<MessageTransformer> {
  return new MessageTransformer(socket)
}

