import { messageOps, logOps, chatOps, settingOps } from './database'
import path from 'path'
import fs from 'fs'
import { accountDir } from './accounts'
import type { MeIdentity } from './compact-serializer'

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

/**
 * Maximum size for an attachment to be downloaded eagerly on receipt.
 * Only applies to images and documents; larger items and other media kinds
 * (audio, voice, video, sticker) are fetched lazily on demand via the
 * `/media` HTTP endpoint.
 */
const EAGER_DOWNLOAD_CAP_BYTES = 5 * 1024 * 1024 // 5MB

/** Discriminator for the six recognized WhatsApp media kinds. */
export type AttachmentKind = 'image' | 'voice' | 'audio' | 'video' | 'document' | 'sticker'

/**
 * Map a Baileys `messageContent` object to the matching `*Message` key and
 * its derived `kind` discriminator. Returns `null` when no recognized media
 * key is present. Voice notes (`audioMessage.ptt === true`) are reported as
 * `kind: 'voice'`; all other `audioMessage` as `kind: 'audio'`.
 */
function detectAttachmentKind(messageContent: any): { kind: AttachmentKind; payload: any } | null {
  if (messageContent.imageMessage) return { kind: 'image', payload: messageContent.imageMessage }
  if (messageContent.videoMessage) return { kind: 'video', payload: messageContent.videoMessage }
  if (messageContent.documentMessage) return { kind: 'document', payload: messageContent.documentMessage }
  if (messageContent.stickerMessage) return { kind: 'sticker', payload: messageContent.stickerMessage }
  if (messageContent.audioMessage) {
    const isPtt = messageContent.audioMessage.ptt === true
    return { kind: isPtt ? 'voice' : 'audio', payload: messageContent.audioMessage }
  }
  return null
}

/** Coerce a Baileys numeric field (may be a Long with low/high words). */
function coerceLongOrNumber(value: any): number {
  if (typeof value === 'number') return value
  if (typeof value === 'object' && value !== null) {
    if (typeof value.toNumber === 'function') {
      try { return value.toNumber() } catch { /* fall through */ }
    }
    if (typeof value.low === 'number') {
      return (value.low >>> 0) + (value.high || 0) * 0x100000000
    }
  }
  return 0
}

function attachmentsDirFor(slug: string): string {
  return path.join(accountDir(slug), 'attachments')
}

/**
 * Marker shape used to round-trip raw protobuf `bytes` fields through SQLite
 * TEXT. The Baileys media-fetch helper needs `mediaKey`, `fileEncSha256`,
 * `fileSha256`, `jpegThumbnail`, etc. as `Buffer`/`Uint8Array` at call time;
 * `JSON.parse` cannot recover them on its own, so we tag them on the way out
 * and rebuild them on the way in via `restoreBuffersInPlace`.
 */
type BufferMarker = { type: 'Buffer'; data: string }

function isBufferMarker(value: any): value is BufferMarker {
  return !!value && typeof value === 'object' && value.type === 'Buffer' &&
    (typeof value.data === 'string' || Array.isArray(value.data))
}

/**
 * Walk a plain JS value and replace any `Uint8Array`/`Buffer` leaves with a
 * compact base64 `BufferMarker`. Other values are returned as-is. Used when
 * persisting the raw Baileys `IMessage` body alongside the projected
 * `TransformedMessage`, so the on-disk JSON stays compact yet recoverable.
 */
export function toJsonSafeMediaPayload(value: any, depth = 0): any {
  if (depth > 12) return null
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { type: 'Buffer', data: Buffer.from(value as Uint8Array).toString('base64') } as BufferMarker
  }
  if (Array.isArray(value)) return value.map((v) => toJsonSafeMediaPayload(v, depth + 1))
  if (typeof value === 'object') {
    if (typeof value.toNumber === 'function' && typeof value.low === 'number') {
      // ProtobufJS Long — preserve numeric value when safely representable.
      try { return value.toNumber() } catch { return { low: value.low, high: value.high, unsigned: !!value.unsigned } }
    }
    const out: Record<string, any> = {}
    for (const k of Object.keys(value)) {
      out[k] = toJsonSafeMediaPayload(value[k], depth + 1)
    }
    return out
  }
  return value
}

/**
 * In-place inverse of `toJsonSafeMediaPayload`: walks a parsed JSON object
 * and rewrites any `BufferMarker` it finds into a real `Buffer`. Safe to
 * call on arbitrary structures and is a no-op when no markers are present.
 */
export function restoreBuffersInPlace(value: any): any {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      if (isBufferMarker(item)) {
        value[i] = Array.isArray(item.data) ? Buffer.from(item.data) : Buffer.from(item.data, 'base64')
      } else if (item && typeof item === 'object') {
        restoreBuffersInPlace(item)
      }
    }
    return value
  }
  for (const k of Object.keys(value)) {
    const child = value[k]
    if (isBufferMarker(child)) {
      value[k] = Array.isArray(child.data) ? Buffer.from(child.data) : Buffer.from(child.data, 'base64')
    } else if (child && typeof child === 'object') {
      restoreBuffersInPlace(child)
    }
  }
  return value
}

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
  kind?: AttachmentKind
  durationSeconds?: number
  /**
   * Persisted raw Baileys `IMessage` payload (i.e. `msg.message`) projected
   * through `toJsonSafeMediaPayload` so its protobuf `bytes` fields survive a
   * JSON round-trip. Consumed by `resolveMedia` to call
   * `downloadMediaMessage` lazily on first request.
   */
  rawMessage?: any
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
  constructor(private slug: string, private socket: any) {}

  getSocket(): any {
    return this.socket
  }

  getSlug(): string {
    return this.slug
  }

  async fetchChatHistory(jid: string): Promise<void> {
    try {
      logOps.insert(this.slug, 'info', 'transformer', `History fetch requested for chat ${jid}`)
    } catch (error) {
      logOps.insert(this.slug, 'error', 'transformer', `Failed to fetch history for ${jid}`, JSON.stringify({ error: String(error) }))
      throw error
    }
  }

  /**
   * Read meIdentity from this account's settings, or undefined if not set yet.
   */
  private getMeIdentity(): MeIdentity | undefined {
    const name = settingOps.get(this.slug, 'user_display_name')
    const phone = settingOps.get(this.slug, 'user_phone')
    if (name && phone) return { name, phone }
    return undefined
  }

  async processMessage(msg: any, chatId: number): Promise<void> {
    try {
      const meIdentity = this.getMeIdentity()
      const transformed = await this.transformMessage(msg, meIdentity)

      if (transformed) {
        const contentJson = JSON.stringify(transformed)
        const hasAttachment = transformed.type === 'unsupported_attachment' ||
                             !!transformed.kind ||
                             (transformed.type === 'message' && !!transformed.filename)
        const msgId = msg.key?.id || `msg-${Date.now()}`
        const senderJid = msg.key?.participant || msg.key?.remoteJid || 'unknown'
        const timestamp = extractTimestampMs(msg.messageTimestamp)
        messageOps.insert(this.slug, chatId, msgId, timestamp, senderJid, contentJson, hasAttachment)
        chatOps.updateLastActivity(this.slug, chatId, new Date(timestamp).toISOString())
      }
    } catch (error) {
      console.error(`[processMessage] Error processing message:`, error)
      logOps.insert(this.slug, 'error', 'transformer', `Failed to process message`, JSON.stringify({ error: String(error) }))
    }
  }

  async processMessageDeletion(key: any, chatId: number, participant?: string): Promise<void> {
    try {
      const original = messageOps.getByWhatsappMessageId(this.slug, key.id) as any
      let originalText: string | null = null
      let originalSender: { name: string; phone: string | null } | undefined = undefined
      let originalTimestamp: string | undefined = undefined

      if (original) {
        try {
          const content = JSON.parse(original.content_json)
          originalText = content.text || null
          originalSender = content.sender
          originalTimestamp = content.timestamp
        } catch { originalText = null }
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
      messageOps.insert(this.slug, chatId, `del-${key.id}`, timestamp, deletedByJid, contentJson, false)
      chatOps.updateLastActivity(this.slug, chatId, new Date(timestamp).toISOString())
    } catch (error) {
      logOps.insert(this.slug, 'error', 'transformer', `Failed to process message deletion`, JSON.stringify({ error: String(error) }))
      throw error
    }
  }

  async processMessageEdit(key: any, update: any, chatId: number, participant?: string): Promise<void> {
    try {
      const original = messageOps.getByWhatsappMessageId(this.slug, key.id) as any
      let originalText: string | null = null
      let originalSender: { name: string; phone: string | null } | undefined
      let originalTimestamp: string | undefined
      if (original?.content_json) {
        try {
          const parsed = JSON.parse(original.content_json)
          originalText = parsed.text || null
          originalSender = parsed.sender
          originalTimestamp = parsed.timestamp
        } catch { }
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
      messageOps.insert(this.slug, chatId, `edit-${key.id}-${Date.now()}`, timestamp, editedByJid, contentJson, false)
      chatOps.updateLastActivity(this.slug, chatId, new Date(timestamp).toISOString())

      if (original) {
        try {
          const parsed = JSON.parse(original.content_json)
          parsed.text = newText
          messageOps.updateContentJson(this.slug, key.id, JSON.stringify(parsed))
        } catch { }
      }
    } catch (error) {
      logOps.insert(this.slug, 'error', 'transformer', 'Failed to process message edit', JSON.stringify({ error: String(error) }))
      throw error
    }
  }

  private async transformMessage(msg: any, meIdentity?: MeIdentity): Promise<TransformedMessage | null> {
    if (!msg.key) return null

    const messageId = msg.key.id || `msg-${Date.now()}`
    const timestampMs = extractTimestampMs(msg.messageTimestamp)
    const timestamp = new Date(timestampMs).toISOString()
    const senderJid = msg.key.participant || msg.key.remoteJid || 'unknown'
    const isFromMe = msg.key.fromMe || false

    let sender: { name: string; phone: string | null }
    if (isFromMe) {
      sender = meIdentity
        ? { name: meIdentity.name, phone: meIdentity.phone }
        : { name: '(me)', phone: null }
    } else {
      const phone = extractPhoneFromJid(senderJid)
      sender = { name: phone || `Unknown_${senderJid}`, phone }
    }

    let messageContent = msg.message
    if (!messageContent) {
      console.log(`[transformMessage] msgId=${messageId} no message content`)
      return null
    }

    const originalKeys = Object.keys(messageContent)
    console.log(`[transformMessage] msgId=${messageId} originalKeys=[${originalKeys.join(', ')}]`)

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

    const detected = detectAttachmentKind(messageContent)
    if (detected) {
      return await this.handleAttachment(messageId, timestamp, sender, messageContent, msg, detected)
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
    messageId: string, timestamp: string, sender: { name: string; phone: string | null }, _messageContent: any, originalMsg: any,
    detected: { kind: AttachmentKind; payload: any }
  ): Promise<TransformedMessage | null> {
    const { kind, payload: attachment } = detected

    const mimeType = (attachment as any).mimetype || 'application/octet-stream'
    const filename = (attachment as any).filename || `attachment_${messageId}`
    const fileSize = coerceLongOrNumber((attachment as any).fileLength)

    const rawSeconds = (attachment as any).seconds
    const durationSeconds = (kind === 'voice' || kind === 'audio' || kind === 'video') && typeof rawSeconds === 'number' && rawSeconds > 0
      ? rawSeconds
      : undefined

    const contextInfo = (attachment as any).contextInfo

    const isFromMe = originalMsg.key?.fromMe || false

    const applyReplyInfo = (result: TransformedMessage): TransformedMessage => {
      if (contextInfo?.stanzaId) { result.replyToMessageId = contextInfo.stanzaId }
      return result
    }

    // Persist the raw `*Message` payload so the on-demand `/media` endpoint
    // can hand it back to Baileys' `downloadMediaMessage`. The wrapping
    // `{ [kind+Message]: ... }` shape matches what Baileys consumes as
    // `msg.message`.
    const messageKey = `${kind === 'voice' ? 'audio' : kind}Message`
    const rawMessage = toJsonSafeMediaPayload({ [messageKey]: attachment })

    const buildMessageEntry = (): TransformedMessage => {
      const entry: TransformedMessage = {
        type: 'message', messageId, sender, timestamp,
        text: `[Attachment: ${filename}]`,
        filename, mimeType, fileSize, kind, isFromMe,
        rawMessage
      }
      if (durationSeconds !== undefined) entry.durationSeconds = durationSeconds
      return entry
    }

    // Eager on-receipt download is preserved only for images and documents at
    // or below the cap. Audio/voice/video/sticker — and oversize images/docs —
    // are recorded with attachment metadata but fetched lazily on first
    // request by the /media HTTP endpoint.
    const eagerEligible = (kind === 'image' || kind === 'document') && fileSize <= EAGER_DOWNLOAD_CAP_BYTES

    if (!eagerEligible) {
      return applyReplyInfo(buildMessageEntry())
    }

    try {
      await this.downloadAttachment(messageId, originalMsg)
      return applyReplyInfo(buildMessageEntry())
    } catch (error) {
      logOps.insert(this.slug, 'error', 'transformer', `Failed to download attachment ${messageId}`, JSON.stringify({ error: String(error) }))
      return applyReplyInfo({ type: 'unsupported_attachment', messageId, sender, timestamp, filename, mimeType, fileSize, kind, reason: 'download_failed', isFromMe })
    }
  }

  private async downloadAttachment(messageId: string, msg: any): Promise<void> {
    await loadBaileysModules()
    const attachment = msg.message?.imageMessage || msg.message?.documentMessage ||
                      msg.message?.audioMessage || msg.message?.videoMessage
    const attachmentDir = path.join(attachmentsDirFor(this.slug), messageId)
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

export async function initializeMessageTransformer(slug: string, socket: any): Promise<MessageTransformer> {
  return new MessageTransformer(slug, socket)
}

