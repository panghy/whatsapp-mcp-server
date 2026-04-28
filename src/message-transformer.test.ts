import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'

// Create unique temp directory - hoisted so mock can access it
const testDir = vi.hoisted(() => {
  const path = require('path')
  const os = require('os')
  return path.join(os.tmpdir(), 'mt-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
})

// Mock electron BEFORE importing modules
vi.mock('electron', () => ({
  app: { getPath: () => testDir }
}))

// Mock Baileys - downloadMediaMessage is used for attachment downloads
const mockDownloadMediaMessage = vi.fn().mockResolvedValue(Buffer.from('fake-attachment-data'))
vi.mock('@whiskeysockets/baileys', () => ({
  proto: {},
  downloadMediaMessage: mockDownloadMediaMessage
}))

// NOW import modules - mocks are in place
import { initializeDatabase, closeDatabase, chatOps, messageOps, logOps } from './database'
import { MessageTransformer, extractPhoneFromJid, normalizePhoneNumber, initializeMessageTransformer } from './message-transformer'

const SLUG = 'default'

describe('Message Transformer Tests', () => {
  const mockSocket = { ev: { on: vi.fn() } }

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    closeDatabase(SLUG)
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    closeDatabase(SLUG)
    const dbDir = path.join(testDir, 'accounts', SLUG)
    if (fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
    fs.mkdirSync(dbDir, { recursive: true })
    initializeDatabase(SLUG)
    mockDownloadMediaMessage.mockClear()
  })

  afterEach(() => {
    closeDatabase(SLUG)
  })

  // Helper to create a chat and return its ID
  function createTestChat(jid = '1234567890@s.whatsapp.net'): number {
    chatOps.insert(SLUG, jid, 'dm', undefined, 'Test Chat')
    const chat = chatOps.getByWhatsappJid(SLUG, jid) as { id: number }
    return chat.id
  }

  describe('normalizePhoneNumber', () => {
    it('should return null for null input', () => {
      expect(normalizePhoneNumber(null)).toBeNull()
    })

    it('should return null for undefined input', () => {
      expect(normalizePhoneNumber(undefined)).toBeNull()
    })

    it('should return null for empty string', () => {
      expect(normalizePhoneNumber('')).toBeNull()
    })

    it('should convert JID format with @s.whatsapp.net', () => {
      expect(normalizePhoneNumber('1234567890@s.whatsapp.net')).toBe('+1234567890')
    })

    it('should convert JID format with @c.us', () => {
      expect(normalizePhoneNumber('1234567890@c.us')).toBe('+1234567890')
    })

    it('should convert plain digits', () => {
      expect(normalizePhoneNumber('1234567890')).toBe('+1234567890')
    })

    it('should strip formatting from phone number', () => {
      expect(normalizePhoneNumber('+1 (234) 567-890')).toBe('+1234567890')
    })

    it('should return null for too short numbers (< 7 digits)', () => {
      expect(normalizePhoneNumber('123456')).toBeNull()
    })
  })

  describe('extractPhoneFromJid', () => {
    it('should extract phone from @s.whatsapp.net JID', () => {
      expect(extractPhoneFromJid('1234567890@s.whatsapp.net')).toBe('+1234567890')
    })

    it('should extract phone from @c.us JID', () => {
      expect(extractPhoneFromJid('1234567890@c.us')).toBe('+1234567890')
    })

    it('should return null for invalid JID', () => {
      expect(extractPhoneFromJid('invalid')).toBeNull()
    })

    it('should handle JID with device ID', () => {
      expect(extractPhoneFromJid('1234567890:5@s.whatsapp.net')).toBe('+1234567890')
    })
  })

  describe('initializeMessageTransformer', () => {
    it('should return a MessageTransformer instance', async () => {
      const transformer = await initializeMessageTransformer(SLUG, mockSocket)
      expect(transformer).toBeInstanceOf(MessageTransformer)
      expect(transformer.getSocket()).toBe(mockSocket)
    })
  })

  describe('fetchChatHistory', () => {
    it('should log info message', async () => {
      const transformer = new MessageTransformer(SLUG, mockSocket)
      await transformer.fetchChatHistory('1234567890@s.whatsapp.net')

      const logs = logOps.getRecent(SLUG, 10) as { message: string; level: string; category: string }[]
      const historyLog = logs.find(l => l.message.includes('History fetch requested'))
      expect(historyLog).toBeDefined()
      expect(historyLog!.category).toBe('transformer')
    })
  })

  describe('processMessage - text messages', () => {
    it('should process simple text message (conversation field)', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-text-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'Hello world' }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-text-1') as { content_json: string }
      expect(stored).toBeDefined()
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('message')
      expect(content.text).toBe('Hello world')
    })

    it('should process extended text message with mentions', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-mention-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          extendedTextMessage: {
            text: 'Hey @user',
            contextInfo: {
              mentionedJid: ['9876543210@s.whatsapp.net'],
              isForwarded: false
            }
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-mention-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.mentionedJids).toContain('9876543210@s.whatsapp.net')
    })

    it('should process extended text message with reply (stanzaId)', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-reply-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          extendedTextMessage: {
            text: 'This is a reply',
            contextInfo: { stanzaId: 'original-msg-123' }
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-reply-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.replyToMessageId).toBe('original-msg-123')
    })

    it('should process forwarded message', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-fwd-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          extendedTextMessage: {
            text: 'Forwarded message',
            contextInfo: { isForwarded: true }
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-fwd-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.forwarded).toBe(true)
    })

    it('should process fromMe message', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-fromme-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'I sent this' }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-fromme-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.isFromMe).toBe(true)
    })
  })

  describe('processMessage - wrapper unwrapping', () => {
    it('should unwrap ephemeral message', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-eph-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          ephemeralMessage: {
            message: { conversation: 'Disappearing message' }
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-eph-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.text).toBe('Disappearing message')
    })

    it('should unwrap viewOnceMessage', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-vo-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          viewOnceMessage: {
            message: { conversation: 'View once message' }
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-vo-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.text).toBe('View once message')
    })

    it('should unwrap documentWithCaptionMessage', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-dwc-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          documentWithCaptionMessage: {
            message: { conversation: 'Document caption' }
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-dwc-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.text).toBe('Document caption')
    })
  })

  describe('processMessage - attachments', () => {
    it('should process image with supported MIME type', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-img-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            filename: 'photo.jpg',
            fileLength: 1024,
            url: 'https://example.com/photo.jpg'
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-img-1') as { content_json: string; has_attachment: number }
      expect(stored).toBeDefined()
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('message')
      expect(content.filename).toBe('photo.jpg')
      expect(content.mimeType).toBe('image/jpeg')
      expect(stored.has_attachment).toBe(1)
    })

    it('should return unsupported_attachment for unsupported MIME type', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-video-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          videoMessage: {
            mimetype: 'video/mp4',
            filename: 'video.mp4',
            fileLength: 1024
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-video-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('unsupported_attachment')
      expect(content.reason).toBe('unsupported_type')
    })

    it('should return unsupported_attachment for file exceeding size limit', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-big-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            filename: 'bigphoto.jpg',
            fileLength: 10 * 1024 * 1024 // 10MB - over 5MB limit
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-big-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('unsupported_attachment')
      expect(content.reason).toBe('exceeds_size_limit')
    })

    it('should return unsupported_attachment on download failure', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)
      mockDownloadMediaMessage.mockRejectedValueOnce(new Error('Download failed'))

      const msg = {
        key: { id: 'msg-fail-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            filename: 'failed.jpg',
            fileLength: 1024
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-fail-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('unsupported_attachment')
      expect(content.reason).toBe('download_failed')
    })

    it('should handle attachment with reply context', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-img-reply-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            filename: 'reply-photo.jpg',
            fileLength: 1024,
            contextInfo: { stanzaId: 'original-msg-456' }
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-img-reply-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.replyToMessageId).toBe('original-msg-456')
    })
  })

  describe('processMessage - system/edge cases', () => {
    it('should process protocol message type 5 as system message', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-proto-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          protocolMessage: { type: 5 }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-proto-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('system')
      expect(content.systemType).toBe('number_change')
    })

    it('should not store message without content', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-empty-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: null
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-empty-1')
      expect(stored).toBeUndefined()
    })

    it('should not store message without key', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: null,
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'No key message' }
      }

      await transformer.processMessage(msg, chatId)

      const messages = messageOps.getByChatId(SLUG, chatId) as { whatsapp_message_id: string }[]
      expect(messages).toHaveLength(0)
    })
  })

  describe('processMessageDeletion', () => {
    it('should create deletion event with original message info', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      // First, insert an original message
      const originalMsg = {
        key: { id: 'msg-to-delete', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'This will be deleted' }
      }
      await transformer.processMessage(originalMsg, chatId)

      // Now process deletion
      const deleteKey = { id: 'msg-to-delete', remoteJid: '1234567890@s.whatsapp.net' }
      await transformer.processMessageDeletion(deleteKey, chatId, '9876543210@s.whatsapp.net')

      // Find the deletion event
      const messages = messageOps.getByChatId(SLUG, chatId) as { whatsapp_message_id: string; content_json: string }[]
      const deletionMsg = messages.find(m => m.whatsapp_message_id.startsWith('del-'))
      expect(deletionMsg).toBeDefined()
      const content = JSON.parse(deletionMsg!.content_json)
      expect(content.type).toBe('message_deleted')
      expect(content.deletedMessage.text).toBe('This will be deleted')
      expect(content.deletedMessage.messageId).toBe('msg-to-delete')
    })

    it('should handle missing original message gracefully', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const deleteKey = { id: 'non-existent-msg', remoteJid: '1234567890@s.whatsapp.net' }
      await transformer.processMessageDeletion(deleteKey, chatId)

      const messages = messageOps.getByChatId(SLUG, chatId) as { whatsapp_message_id: string; content_json: string }[]
      const deletionMsg = messages.find(m => m.whatsapp_message_id.startsWith('del-'))
      expect(deletionMsg).toBeDefined()
      const content = JSON.parse(deletionMsg!.content_json)
      expect(content.type).toBe('message_deleted')
      expect(content.deletedMessage.text).toBeNull()
    })

    it('should extract deletedBy from participant JID', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const deleteKey = { id: 'delete-test', remoteJid: '1234567890@s.whatsapp.net' }
      await transformer.processMessageDeletion(deleteKey, chatId, '5551234567@s.whatsapp.net')

      const messages = messageOps.getByChatId(SLUG, chatId) as { whatsapp_message_id: string; content_json: string }[]
      const deletionMsg = messages.find(m => m.whatsapp_message_id.startsWith('del-'))
      const content = JSON.parse(deletionMsg!.content_json)
      expect(content.deletedBy.phone).toBe('+5551234567')
    })
  })

  describe('processMessageEdit', () => {
    it('should create edit event with original and new text', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      // First insert original message
      const originalMsg = {
        key: { id: 'msg-to-edit', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'Original text' }
      }
      await transformer.processMessage(originalMsg, chatId)

      // Process edit
      const editKey = { id: 'msg-to-edit', remoteJid: '1234567890@s.whatsapp.net' }
      const editUpdate = { message: { conversation: 'Edited text' } }
      await transformer.processMessageEdit(editKey, editUpdate, chatId)

      // Find the edit event
      const messages = messageOps.getByChatId(SLUG, chatId) as { whatsapp_message_id: string; content_json: string }[]
      const editMsg = messages.find(m => m.whatsapp_message_id.startsWith('edit-'))
      expect(editMsg).toBeDefined()
      const content = JSON.parse(editMsg!.content_json)
      expect(content.type).toBe('message_edited')
      expect(content.editedMessage.originalText).toBe('Original text')
      expect(content.editedMessage.newText).toBe('Edited text')
    })

    it('should update original message content_json', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      // First insert original message
      const originalMsg = {
        key: { id: 'msg-edit-update', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'Original' }
      }
      await transformer.processMessage(originalMsg, chatId)

      // Process edit
      const editKey = { id: 'msg-edit-update', remoteJid: '1234567890@s.whatsapp.net' }
      const editUpdate = { message: { conversation: 'Updated' } }
      await transformer.processMessageEdit(editKey, editUpdate, chatId)

      // Verify original message was updated
      const original = messageOps.getByWhatsappMessageId(SLUG, 'msg-edit-update') as { content_json: string }
      const content = JSON.parse(original.content_json)
      expect(content.text).toBe('Updated')
    })

    it('should handle edit without original message in DB', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const editKey = { id: 'non-existent-edit', remoteJid: '1234567890@s.whatsapp.net' }
      const editUpdate = { message: { conversation: 'New text' } }
      await transformer.processMessageEdit(editKey, editUpdate, chatId)

      const messages = messageOps.getByChatId(SLUG, chatId) as { whatsapp_message_id: string; content_json: string }[]
      const editMsg = messages.find(m => m.whatsapp_message_id.startsWith('edit-'))
      expect(editMsg).toBeDefined()
      const content = JSON.parse(editMsg!.content_json)
      expect(content.editedMessage.originalText).toBeNull()
      expect(content.editedMessage.newText).toBe('New text')
    })

    it('should extract newText from extendedTextMessage', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const editKey = { id: 'edit-extended', remoteJid: '1234567890@s.whatsapp.net' }
      const editUpdate = {
        message: {
          extendedTextMessage: { text: 'Extended edit text' }
        }
      }
      await transformer.processMessageEdit(editKey, editUpdate, chatId)

      const messages = messageOps.getByChatId(SLUG, chatId) as { whatsapp_message_id: string; content_json: string }[]
      const editMsg = messages.find(m => m.whatsapp_message_id.startsWith('edit-'))
      const content = JSON.parse(editMsg!.content_json)
      expect(content.editedMessage.newText).toBe('Extended edit text')
    })

    it('should extract editedBy from participant', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const editKey = { id: 'edit-by-test', remoteJid: '1234567890@s.whatsapp.net' }
      const editUpdate = { message: { conversation: 'Edited' } }
      await transformer.processMessageEdit(editKey, editUpdate, chatId, '9998887777@s.whatsapp.net')

      const messages = messageOps.getByChatId(SLUG, chatId) as { whatsapp_message_id: string; content_json: string }[]
      const editMsg = messages.find(m => m.whatsapp_message_id.startsWith('edit-'))
      const content = JSON.parse(editMsg!.content_json)
      expect(content.editedBy.phone).toBe('+9998887777')
    })
  })
})

