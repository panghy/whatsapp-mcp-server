import { z } from 'zod'
import { TransformedMessage } from './message-transformer'

/**
 * Wire shape for a single structured message returned by the chat-history MCP
 * tools. `sender` is `null` for `system`, `message_deleted`, and
 * `message_edited` types — the actor identity for those lives under
 * `deletedBy`/`editedBy` and the original message envelope under
 * `deletedMessage`/`editedMessage`.
 */
export interface StructuredMessage {
  messageId: string
  type: 'message' | 'system' | 'unsupported_attachment' | 'message_deleted' | 'message_edited'
  timestamp: string
  sender: { name: string; phone: string | null; isMe: boolean } | null
  text: string | null
  forwarded?: boolean
  replyTo?: { messageId: string; sender: { name: string; phone: string | null }; preview: string }
  attachment?: { filename?: string; mimeType?: string; fileSize?: number; reason?: string }
  deletedBy?: { name: string; phone: string | null }
  deletedMessage?: { messageId: string; text: string | null; timestamp?: string }
  editedBy?: { name: string; phone: string | null }
  editedMessage?: { messageId: string; originalText: string | null; newText: string; timestamp?: string }
  systemType?: string
  systemDetails?: Record<string, unknown>
}

export interface ChatRef {
  jid: string
  name: string
  type: 'dm' | 'group' | string
}

export interface StructuredChatHistory {
  chat: ChatRef
  messages: StructuredMessage[]
}

export interface StructuredMessagesByChat {
  since: string
  chats: Array<{ chat: ChatRef; messages: StructuredMessage[] }>
}

const senderSchema = z.object({
  name: z.string(),
  phone: z.string().nullable(),
  isMe: z.boolean()
})

const replySenderSchema = z.object({
  name: z.string(),
  phone: z.string().nullable()
})

const attachmentSchema = z.object({
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  fileSize: z.number().optional(),
  reason: z.string().optional()
})

export const structuredMessageSchema = z.object({
  messageId: z.string(),
  type: z.enum(['message', 'system', 'unsupported_attachment', 'message_deleted', 'message_edited']),
  timestamp: z.string(),
  sender: senderSchema.nullable(),
  text: z.string().nullable(),
  forwarded: z.boolean().optional(),
  replyTo: z.object({
    messageId: z.string(),
    sender: replySenderSchema,
    preview: z.string()
  }).optional(),
  attachment: attachmentSchema.optional(),
  deletedBy: replySenderSchema.optional(),
  deletedMessage: z.object({
    messageId: z.string(),
    text: z.string().nullable(),
    timestamp: z.string().optional()
  }).optional(),
  editedBy: replySenderSchema.optional(),
  editedMessage: z.object({
    messageId: z.string(),
    originalText: z.string().nullable(),
    newText: z.string(),
    timestamp: z.string().optional()
  }).optional(),
  systemType: z.string().optional(),
  systemDetails: z.record(z.unknown()).optional()
})

export const chatRefSchema = z.object({
  jid: z.string(),
  name: z.string(),
  type: z.string()
})

/** Raw shape suitable for `registerTool`'s `outputSchema` parameter. */
export const chatHistoryOutputShape = {
  chat: chatRefSchema,
  messages: z.array(structuredMessageSchema)
}

/** Raw shape suitable for `registerTool`'s `outputSchema` parameter. */
export const messagesByChatOutputShape = {
  since: z.string(),
  chats: z.array(z.object({
    chat: chatRefSchema,
    messages: z.array(structuredMessageSchema)
  }))
}

/**
 * Project an already-identity-resolved `TransformedMessage` into the
 * `structuredContent` wire shape. Drops internal-only fields
 * (`mentionedJids`, `replyToMessageId`) and folds `details` →
 * `systemDetails` and the flat attachment fields →
 * `attachment` so callers see a single, typed shape.
 */
export function toStructuredMessage(msg: TransformedMessage): StructuredMessage {
  const isMe = !!msg.isFromMe
  const senderlessTypes: Array<TransformedMessage['type']> = ['system', 'message_deleted', 'message_edited']
  const sender = senderlessTypes.includes(msg.type)
    ? null
    : (msg.sender ? { name: msg.sender.name, phone: msg.sender.phone, isMe } : null)

  const result: StructuredMessage = {
    messageId: msg.messageId,
    type: msg.type,
    timestamp: msg.timestamp,
    sender,
    text: msg.text ?? null
  }

  if (msg.forwarded) result.forwarded = true

  if (msg.replyTo) {
    result.replyTo = {
      messageId: msg.replyTo.messageId,
      sender: { name: msg.replyTo.senderName, phone: msg.replyTo.senderPhone },
      preview: msg.replyTo.preview
    }
  }

  const hasAttachmentField = msg.filename !== undefined || msg.mimeType !== undefined ||
                             msg.fileSize !== undefined || msg.reason !== undefined
  if (hasAttachmentField) {
    const attachment: StructuredMessage['attachment'] = {}
    if (msg.filename !== undefined) attachment!.filename = msg.filename
    if (msg.mimeType !== undefined) attachment!.mimeType = msg.mimeType
    if (msg.fileSize !== undefined) attachment!.fileSize = msg.fileSize
    if (msg.reason !== undefined) attachment!.reason = msg.reason
    result.attachment = attachment
  }

  if (msg.deletedBy) result.deletedBy = msg.deletedBy
  if (msg.deletedMessage) {
    result.deletedMessage = {
      messageId: msg.deletedMessage.messageId,
      text: msg.deletedMessage.text,
      ...(msg.deletedMessage.timestamp !== undefined ? { timestamp: msg.deletedMessage.timestamp } : {})
    }
  }
  if (msg.editedBy) result.editedBy = msg.editedBy
  if (msg.editedMessage) {
    result.editedMessage = {
      messageId: msg.editedMessage.messageId,
      originalText: msg.editedMessage.originalText,
      newText: msg.editedMessage.newText,
      ...(msg.editedMessage.timestamp !== undefined ? { timestamp: msg.editedMessage.timestamp } : {})
    }
  }
  if (msg.systemType !== undefined) result.systemType = msg.systemType
  if (msg.details !== undefined) result.systemDetails = msg.details

  return result
}

