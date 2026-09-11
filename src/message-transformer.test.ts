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
import { initializeDatabase, closeDatabase, getDatabase, chatOps, messageOps, logOps, settingOps, reactionOps, contactOps } from './database'
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

  describe('processMessage - sender identity (isFromMe / meIdentity)', () => {
    it('should set sender to (me) with null phone for fromMe DM when meIdentity not set', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-me-noid-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'I sent this' }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-me-noid-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.isFromMe).toBe(true)
      expect(content.sender).toEqual({ name: '(me)', phone: null })
    })

    it('should set sender to meIdentity for fromMe DM when meIdentity is set', async () => {
      const chatId = createTestChat()
      settingOps.set(SLUG, 'user_display_name', 'Alice')
      settingOps.set(SLUG, 'user_phone', '+9998887777')
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-me-id-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'I sent this' }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-me-id-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.isFromMe).toBe(true)
      expect(content.sender).toEqual({ name: 'Alice', phone: '+9998887777' })
    })

    it('should derive sender from senderJid when not fromMe (DM)', async () => {
      const chatId = createTestChat()
      settingOps.set(SLUG, 'user_display_name', 'Alice')
      settingOps.set(SLUG, 'user_phone', '+9998887777')
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-other-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'Hi from contact' }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-other-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.isFromMe).toBe(false)
      expect(content.sender).toEqual({ name: '+1234567890', phone: '+1234567890' })
    })

    it('should use meIdentity for fromMe attachments too', async () => {
      const chatId = createTestChat()
      settingOps.set(SLUG, 'user_display_name', 'Alice')
      settingOps.set(SLUG, 'user_phone', '+9998887777')
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-me-img-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: true },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            filename: 'me.jpg',
            fileLength: 1024,
            url: 'https://example.com/me.jpg'
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-me-img-1') as { content_json: string }
      const content = JSON.parse(stored.content_json)
      expect(content.isFromMe).toBe(true)
      expect(content.sender).toEqual({ name: 'Alice', phone: '+9998887777' })
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

    it('should record video as a first-class lazy-fetch message with kind=video', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-video-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          videoMessage: {
            mimetype: 'video/mp4',
            filename: 'video.mp4',
            fileLength: 1024,
            seconds: 17
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-video-1') as { content_json: string; has_attachment: number }
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('message')
      expect(content.kind).toBe('video')
      expect(content.mimeType).toBe('video/mp4')
      expect(content.durationSeconds).toBe(17)
      expect(stored.has_attachment).toBe(1)
      // Eager-download is reserved for image/document, so downloadMediaMessage
      // must NOT be invoked for video on receipt.
      expect(mockDownloadMediaMessage).not.toHaveBeenCalled()
    })

    it('should record oversize images as lazy-fetch messages (no eager download)', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-big-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            filename: 'bigphoto.jpg',
            fileLength: 10 * 1024 * 1024 // 10MB — over the 5MB eager-download cap
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-big-1') as { content_json: string; has_attachment: number }
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('message')
      expect(content.kind).toBe('image')
      expect(content.fileSize).toBe(10 * 1024 * 1024)
      expect(stored.has_attachment).toBe(1)
      expect(mockDownloadMediaMessage).not.toHaveBeenCalled()
    })

    it('should record voice notes (audioMessage.ptt=true) with kind=voice and duration', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-voice-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          audioMessage: {
            mimetype: 'audio/ogg; codecs=opus',
            fileLength: 4096,
            seconds: 12,
            ptt: true
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-voice-1') as { content_json: string; has_attachment: number }
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('message')
      expect(content.kind).toBe('voice')
      expect(content.durationSeconds).toBe(12)
      expect(stored.has_attachment).toBe(1)
      expect(mockDownloadMediaMessage).not.toHaveBeenCalled()
    })

    it('should record non-PTT audio with kind=audio', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-audio-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          audioMessage: {
            mimetype: 'audio/mp4',
            fileLength: 8192,
            seconds: 45
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-audio-1') as { content_json: string; has_attachment: number }
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('message')
      expect(content.kind).toBe('audio')
      expect(content.durationSeconds).toBe(45)
      expect(stored.has_attachment).toBe(1)
    })

    it('should record stickers with kind=sticker (no duration)', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const msg = {
        key: { id: 'msg-sticker-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          stickerMessage: {
            mimetype: 'image/webp',
            fileLength: 2048
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-sticker-1') as { content_json: string; has_attachment: number }
      const content = JSON.parse(stored.content_json)
      expect(content.type).toBe('message')
      expect(content.kind).toBe('sticker')
      expect(content.durationSeconds).toBeUndefined()
      expect(stored.has_attachment).toBe(1)
      expect(mockDownloadMediaMessage).not.toHaveBeenCalled()
    })

    it('round-trips raw imageMessage through messageOps.insert/getByWhatsappMessageId with mediaKey intact', async () => {
      const chatId = createTestChat()
      const transformer = new MessageTransformer(SLUG, mockSocket)

      const mediaKeyBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      const fileSha = Buffer.from('abcdefghijklmnop')
      const msg = {
        key: { id: 'msg-roundtrip-1', remoteJid: '1234567890@s.whatsapp.net', fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            filename: 'rt.jpg',
            fileLength: 4242,
            mediaKey: mediaKeyBytes,
            fileSha256: fileSha,
            url: 'https://mmg.whatsapp.net/m/v/t62/foo.enc',
            directPath: '/v/t62/foo.enc'
          }
        }
      }

      await transformer.processMessage(msg, chatId)

      const stored = messageOps.getByWhatsappMessageId(SLUG, 'msg-roundtrip-1') as { content_json: string }
      const parsed = JSON.parse(stored.content_json)
      expect(parsed.rawMessage).toBeDefined()
      expect(parsed.rawMessage.imageMessage).toBeDefined()
      expect(parsed.rawMessage.imageMessage.url).toBe('https://mmg.whatsapp.net/m/v/t62/foo.enc')
      expect(parsed.rawMessage.imageMessage.directPath).toBe('/v/t62/foo.enc')

      const { restoreBuffersInPlace } = await import('./message-transformer')
      restoreBuffersInPlace(parsed.rawMessage)
      expect(Buffer.isBuffer(parsed.rawMessage.imageMessage.mediaKey)).toBe(true)
      expect(parsed.rawMessage.imageMessage.mediaKey.equals(mediaKeyBytes)).toBe(true)
      expect(Buffer.isBuffer(parsed.rawMessage.imageMessage.fileSha256)).toBe(true)
      expect(parsed.rawMessage.imageMessage.fileSha256.equals(fileSha)).toBe(true)
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

  describe('processMessage - reactions', () => {
    const DM_JID = '1234567890@s.whatsapp.net'
    const GROUP_JID = 'group-1@g.us'
    const ALICE = '9998887777@s.whatsapp.net'
    const OWN_JID_WITH_DEVICE = '15550001111:7@s.whatsapp.net'
    const OWN_JID = '15550001111@s.whatsapp.net'
    const socketWithUser = { ev: { on: vi.fn() }, user: { id: OWN_JID_WITH_DEVICE } }

    function reactionMsg(opts: {
      id: string
      remoteJid: string
      targetId: string
      text: string | undefined
      fromMe?: boolean
      participant?: string
      senderTimestampMs?: number | string | { low: number; high: number }
      messageTimestamp?: number
      wrap?: 'deviceSentMessage' | 'ephemeralMessage'
    }) {
      const reactionMessage: any = { key: { remoteJid: opts.remoteJid, fromMe: false, id: opts.targetId }, text: opts.text }
      if (opts.senderTimestampMs !== undefined) reactionMessage.senderTimestampMs = opts.senderTimestampMs
      const inner = { reactionMessage }
      const message = opts.wrap ? { [opts.wrap]: { message: inner } } : inner
      return {
        key: { id: opts.id, remoteJid: opts.remoteJid, fromMe: opts.fromMe ?? false, participant: opts.participant },
        messageTimestamp: opts.messageTimestamp ?? Math.floor(Date.now() / 1000),
        message,
      }
    }

    it('stores a reaction row and does not insert a messages row', async () => {
      const chatId = createTestChat(DM_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      await transformer.processMessage({
        key: { id: 'target-1', remoteJid: DM_JID, fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: 'hello' },
      }, chatId)
      const before = messageOps.getCountByChatId(SLUG, chatId)

      await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: DM_JID, targetId: 'target-1', text: '👍', senderTimestampMs: 1700000000000 }), chatId)

      expect(messageOps.getCountByChatId(SLUG, chatId)).toBe(before)
      expect(messageOps.getByWhatsappMessageId(SLUG, 'r-1')).toBeUndefined()
      const rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ target_message_id: 'target-1', chat_id: chatId, reactor_jid: DM_JID, emoji: '👍', is_from_me: 0, timestamp: 1700000000000 })
    })

    it('does not update chats.last_activity for a reaction', async () => {
      const chatId = createTestChat(DM_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      const before = (chatOps.getById(SLUG, chatId) as any).last_activity
      await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: DM_JID, targetId: 'target-1', text: '👍' }), chatId)
      expect((chatOps.getById(SLUG, chatId) as any).last_activity).toBe(before)
    })

    it('persists a reaction whose target message has not been stored', async () => {
      const chatId = createTestChat(DM_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: DM_JID, targetId: 'not-yet-stored', text: '🔥' }), chatId)
      expect(reactionOps.getByTargetMessageIds(SLUG, ['not-yet-stored'])).toHaveLength(1)
    })

    it('re-delivery is idempotent, a newer emoji replaces, an older one does not overwrite, and empty text deletes', async () => {
      const chatId = createTestChat(GROUP_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      const base = { remoteJid: GROUP_JID, participant: ALICE, targetId: 'target-1' }

      await transformer.processMessage(reactionMsg({ ...base, id: 'r-1', text: '👍', senderTimestampMs: 1000 }), chatId)
      await transformer.processMessage(reactionMsg({ ...base, id: 'r-1', text: '👍', senderTimestampMs: 1000 }), chatId)
      let rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
      expect(rows).toHaveLength(1)
      expect(rows[0].reactor_jid).toBe(ALICE)

      await transformer.processMessage(reactionMsg({ ...base, id: 'r-2', text: '❤️', senderTimestampMs: 2000 }), chatId)
      rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
      expect(rows).toHaveLength(1)
      expect(rows[0].emoji).toBe('❤️')

      await transformer.processMessage(reactionMsg({ ...base, id: 'r-0', text: '😂', senderTimestampMs: 500 }), chatId)
      rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
      expect(rows).toHaveLength(1)
      expect(rows[0].emoji).toBe('❤️')

      await transformer.processMessage(reactionMsg({ ...base, id: 'r-3', text: '', senderTimestampMs: 3000 }), chatId)
      expect(reactionOps.getByTargetMessageIds(SLUG, ['target-1'])).toHaveLength(0)
      expect(messageOps.getCountByChatId(SLUG, chatId)).toBe(0)
    })

    it('treats undefined text as a removal', async () => {
      const chatId = createTestChat(DM_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: DM_JID, targetId: 'target-1', text: '👍', senderTimestampMs: 1000 }), chatId)
      await transformer.processMessage(reactionMsg({ id: 'r-2', remoteJid: DM_JID, targetId: 'target-1', text: undefined, senderTimestampMs: 2000 }), chatId)
      expect(reactionOps.getByTargetMessageIds(SLUG, ['target-1'])).toHaveLength(0)
    })

    it('ignores a stale removal (older timestamp than the stored reaction) but honours a newer one', async () => {
      const chatId = createTestChat(GROUP_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      const base = { remoteJid: GROUP_JID, participant: ALICE, targetId: 'target-1' }

      await transformer.processMessage(reactionMsg({ ...base, id: 'r-1', text: '👍', senderTimestampMs: 200 }), chatId)
      await transformer.processMessage(reactionMsg({ ...base, id: 'r-0', text: '', senderTimestampMs: 100 }), chatId)
      let rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ reactor_jid: ALICE, emoji: '👍', timestamp: 200 })

      await transformer.processMessage(reactionMsg({ ...base, id: 'r-2', text: '', senderTimestampMs: 300 }), chatId)
      expect(reactionOps.getByTargetMessageIds(SLUG, ['target-1'])).toHaveLength(0)
    })

    it('stores a from-me reaction in a DM under the own JID (device suffix stripped) with is_from_me = 1', async () => {
      const chatId = createTestChat(DM_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)

      await transformer.processMessage(reactionMsg({ id: 'r-them', remoteJid: DM_JID, targetId: 'target-1', text: '👍', senderTimestampMs: 1000 }), chatId)
      await transformer.processMessage(reactionMsg({ id: 'r-me', remoteJid: DM_JID, targetId: 'target-1', text: '❤️', fromMe: true, senderTimestampMs: 1001 }), chatId)

      const rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
      expect(rows).toHaveLength(2)
      const mine = rows.find((r) => r.is_from_me === 1)
      const theirs = rows.find((r) => r.is_from_me === 0)
      expect(mine).toMatchObject({ reactor_jid: OWN_JID, emoji: '❤️' })
      expect(theirs).toMatchObject({ reactor_jid: DM_JID, emoji: '👍' })
    })

    it('falls back to the literal "me" for from-me reactions when the socket has no user', async () => {
      const chatId = createTestChat(DM_JID)
      const transformer = new MessageTransformer(SLUG, mockSocket)
      await transformer.processMessage(reactionMsg({ id: 'r-me', remoteJid: DM_JID, targetId: 'target-1', text: '❤️', fromMe: true }), chatId)
      const rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ reactor_jid: 'me', is_from_me: 1 })
    })

    it('uses key.participant as reactor in groups', async () => {
      const chatId = createTestChat(GROUP_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: GROUP_JID, participant: ALICE, targetId: 'target-1', text: '👍' }), chatId)
      expect(reactionOps.getByTargetMessageIds(SLUG, ['target-1'])[0].reactor_jid).toBe(ALICE)
    })

    it('unwraps deviceSentMessage / ephemeralMessage wrappers around a reaction', async () => {
      const chatId = createTestChat(DM_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: DM_JID, targetId: 'target-1', text: '👍', fromMe: true, wrap: 'deviceSentMessage' }), chatId)
      await transformer.processMessage(reactionMsg({ id: 'r-2', remoteJid: DM_JID, targetId: 'target-2', text: '🔥', wrap: 'ephemeralMessage' }), chatId)
      expect(reactionOps.getByTargetMessageIds(SLUG, ['target-1', 'target-2'])).toHaveLength(2)
      expect(messageOps.getCountByChatId(SLUG, chatId)).toBe(0)
    })

    it('falls back to messageTimestamp when senderTimestampMs is absent, and parses Long-like / string senderTimestampMs', async () => {
      const chatId = createTestChat(DM_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      const seconds = 1700000000

      await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: DM_JID, targetId: 'fallback', text: '👍', messageTimestamp: seconds }), chatId)
      expect(reactionOps.getByTargetMessageIds(SLUG, ['fallback'])[0].timestamp).toBe(seconds * 1000)

      await transformer.processMessage(reactionMsg({ id: 'r-2', remoteJid: DM_JID, targetId: 'string-ts', text: '👍', senderTimestampMs: '1700000001234' }), chatId)
      expect(reactionOps.getByTargetMessageIds(SLUG, ['string-ts'])[0].timestamp).toBe(1700000001234)

      const ms = 1700000002345
      const long = { low: ms % 0x100000000, high: Math.floor(ms / 0x100000000) }
      await transformer.processMessage(reactionMsg({ id: 'r-3', remoteJid: DM_JID, targetId: 'long-ts', text: '👍', senderTimestampMs: long }), chatId)
      expect(reactionOps.getByTargetMessageIds(SLUG, ['long-ts'])[0].timestamp).toBe(ms)
    })

    it('ignores a reactionMessage without a target key id', async () => {
      const chatId = createTestChat(DM_JID)
      const transformer = new MessageTransformer(SLUG, socketWithUser)
      await transformer.processMessage({
        key: { id: 'r-1', remoteJid: DM_JID, fromMe: false },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { reactionMessage: { text: '👍' } },
      }, chatId)
      const count = (getDatabase(SLUG).prepare('SELECT COUNT(*) as c FROM message_reactions').get() as { c: number }).c
      expect(count).toBe(0)
      expect(messageOps.getCountByChatId(SLUG, chatId)).toBe(0)
    })

    describe('embedded history reactions (WebMessageInfo.reactions[])', () => {
      const BOB = '15551112222@s.whatsapp.net'

      function historyMsg(opts: { id: string; remoteJid: string; participant?: string; messageTimestamp: number; reactions: any[] }) {
        return {
          key: { remoteJid: opts.remoteJid, fromMe: false, id: opts.id, participant: opts.participant },
          messageTimestamp: opts.messageTimestamp,
          message: { conversation: 'target text' },
          reactions: opts.reactions,
        }
      }

      it('stores the target message and one row per embedded reaction, keyed on the outer message id', async () => {
        const chatId = createTestChat(GROUP_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)
        await transformer.processMessage(historyMsg({
          id: 'T-EMB', remoteJid: GROUP_JID, participant: ALICE, messageTimestamp: 1700000000,
          reactions: [
            { key: { remoteJid: GROUP_JID, fromMe: false, id: 'R-1', participant: BOB }, text: '👍', senderTimestampMs: 1700000001000 },
            { key: { remoteJid: GROUP_JID, fromMe: true, id: 'R-2' }, text: '❤️', senderTimestampMs: { low: 1700000002000 % 0x100000000, high: Math.floor(1700000002000 / 0x100000000) } },
          ],
        }), chatId)

        expect(messageOps.getByWhatsappMessageId(SLUG, 'T-EMB')).toBeTruthy()
        expect(messageOps.getCountByChatId(SLUG, chatId)).toBe(1)
        expect(reactionOps.getByTargetMessageIds(SLUG, ['R-1', 'R-2'])).toHaveLength(0)

        const rows = reactionOps.getByTargetMessageIds(SLUG, ['T-EMB'])
        expect(rows).toHaveLength(2)
        expect(rows[0]).toMatchObject({ target_message_id: 'T-EMB', chat_id: chatId, reactor_jid: BOB, emoji: '👍', is_from_me: 0, timestamp: 1700000001000 })
        expect(rows[1]).toMatchObject({ target_message_id: 'T-EMB', chat_id: chatId, reactor_jid: OWN_JID, emoji: '❤️', is_from_me: 1, timestamp: 1700000002000 })
      })

      it('stores nothing for an embedded reaction with empty text', async () => {
        const chatId = createTestChat(DM_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)
        await transformer.processMessage(historyMsg({
          id: 'T-EMPTY', remoteJid: DM_JID, messageTimestamp: 1700000000,
          reactions: [{ key: { remoteJid: DM_JID, fromMe: false, id: 'R-1' }, text: '', senderTimestampMs: 1700000001000 }],
        }), chatId)
        expect(messageOps.getByWhatsappMessageId(SLUG, 'T-EMPTY')).toBeTruthy()
        expect(reactionOps.getByTargetMessageIds(SLUG, ['T-EMPTY'])).toHaveLength(0)
      })

      it('falls back to the target message timestamp when senderTimestampMs is absent', async () => {
        const chatId = createTestChat(DM_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)
        await transformer.processMessage(historyMsg({
          id: 'T-TS', remoteJid: DM_JID, messageTimestamp: 1700000000,
          reactions: [{ key: { remoteJid: DM_JID, fromMe: false, id: 'R-1' }, text: '🔥' }],
        }), chatId)
        const rows = reactionOps.getByTargetMessageIds(SLUG, ['T-TS'])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ reactor_jid: DM_JID, emoji: '🔥', timestamp: 1700000000 * 1000 })
      })

      it('does not let a stale embedded removal delete a newer stored reaction', async () => {
        const chatId = createTestChat(DM_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)
        await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: DM_JID, targetId: 'T-STALE', text: '👍', senderTimestampMs: 200 }), chatId)
        await transformer.processMessage(historyMsg({
          id: 'T-STALE', remoteJid: DM_JID, messageTimestamp: 1,
          reactions: [{ key: { remoteJid: DM_JID, fromMe: false, id: 'R-1' }, text: '', senderTimestampMs: 100 }],
        }), chatId)
        const rows = reactionOps.getByTargetMessageIds(SLUG, ['T-STALE'])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ reactor_jid: DM_JID, emoji: '👍', timestamp: 200 })

        await transformer.processMessage(historyMsg({
          id: 'T-STALE', remoteJid: DM_JID, messageTimestamp: 1,
          reactions: [{ key: { remoteJid: DM_JID, fromMe: false, id: 'R-2' }, text: '', senderTimestampMs: 300 }],
        }), chatId)
        expect(reactionOps.getByTargetMessageIds(SLUG, ['T-STALE'])).toHaveLength(0)
      })

      it('does not treat a message with an empty reactions array differently', async () => {
        const chatId = createTestChat(DM_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)
        await transformer.processMessage(historyMsg({ id: 'T-NONE', remoteJid: DM_JID, messageTimestamp: 1700000000, reactions: [] }), chatId)
        expect(messageOps.getCountByChatId(SLUG, chatId)).toBe(1)
        expect(reactionOps.getByTargetMessageIds(SLUG, ['T-NONE'])).toHaveLength(0)
      })
    })

    describe('PN/LID reactor identity', () => {
      const ALICE_LID = '777888999@lid'
      const DM_LID = '444555666@lid'

      it('group: PN add → LID change (with participantAlt) → LID remove yields one row then zero', async () => {
        const chatId = createTestChat(GROUP_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)

        await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: GROUP_JID, participant: ALICE, targetId: 'target-1', text: '👍', senderTimestampMs: 1000 }), chatId)
        const change = reactionMsg({ id: 'r-2', remoteJid: GROUP_JID, participant: ALICE_LID, targetId: 'target-1', text: '❤️', senderTimestampMs: 2000 })
        ;(change.key as any).participantAlt = ALICE
        await transformer.processMessage(change, chatId)

        let rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ reactor_jid: ALICE, emoji: '❤️', timestamp: 2000 })

        const remove = reactionMsg({ id: 'r-3', remoteJid: GROUP_JID, participant: ALICE_LID, targetId: 'target-1', text: '', senderTimestampMs: 3000 })
        ;(remove.key as any).participantAlt = ALICE
        await transformer.processMessage(remove, chatId)
        rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(0)
      })

      it('DM: PN add → LID change (with remoteJidAlt) → LID remove yields one row then zero', async () => {
        const chatId = createTestChat(DM_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)

        await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: DM_JID, targetId: 'target-1', text: '👍', senderTimestampMs: 1000 }), chatId)
        const change = reactionMsg({ id: 'r-2', remoteJid: DM_LID, targetId: 'target-1', text: '❤️', senderTimestampMs: 2000 })
        ;(change.key as any).remoteJidAlt = DM_JID
        await transformer.processMessage(change, chatId)

        let rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ reactor_jid: DM_JID, emoji: '❤️' })

        const remove = reactionMsg({ id: 'r-3', remoteJid: DM_LID, targetId: 'target-1', text: '', senderTimestampMs: 3000 })
        ;(remove.key as any).remoteJidAlt = DM_JID
        await transformer.processMessage(remove, chatId)
        rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(0)
      })

      it('group: LID change without alt uses a pre-existing contacts mapping', async () => {
        const chatId = createTestChat(GROUP_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)
        contactOps.insert(SLUG, ALICE, { phoneNumber: '+9998887777', lid: ALICE_LID })
        contactOps.insert(SLUG, ALICE_LID, { phoneNumber: '+9998887777' })

        await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: GROUP_JID, participant: ALICE, targetId: 'target-1', text: '👍', senderTimestampMs: 1000 }), chatId)
        await transformer.processMessage(reactionMsg({ id: 'r-2', remoteJid: GROUP_JID, participant: ALICE_LID, targetId: 'target-1', text: '❤️', senderTimestampMs: 2000 }), chatId)

        let rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ reactor_jid: ALICE, emoji: '❤️' })

        await transformer.processMessage(reactionMsg({ id: 'r-3', remoteJid: GROUP_JID, participant: ALICE_LID, targetId: 'target-1', text: '', senderTimestampMs: 3000 }), chatId)
        rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(0)
      })

      it('DM: LID→PN change with only a LID-rooted contacts row known collapses to one PN row', async () => {
        const chatId = createTestChat(DM_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)
        contactOps.insert(SLUG, DM_LID, { phoneNumber: '+1234567890' })

        await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: DM_LID, targetId: 'target-1', text: '👍', senderTimestampMs: 1000 }), chatId)
        let rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ reactor_jid: DM_JID, emoji: '👍' })

        await transformer.processMessage(reactionMsg({ id: 'r-2', remoteJid: DM_JID, targetId: 'target-1', text: '❤️', senderTimestampMs: 2000 }), chatId)
        rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ reactor_jid: DM_JID, emoji: '❤️' })

        await transformer.processMessage(reactionMsg({ id: 'r-3', remoteJid: DM_LID, targetId: 'target-1', text: '', senderTimestampMs: 3000 }), chatId)
        expect(reactionOps.getByTargetMessageIds(SLUG, ['target-1'])).toHaveLength(0)
      })

      it('a LID row stored before the mapping was known is replaced once a PN reaction arrives with the alt', async () => {
        const chatId = createTestChat(GROUP_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)

        await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: GROUP_JID, participant: ALICE_LID, targetId: 'target-1', text: '👍', senderTimestampMs: 1000 }), chatId)
        expect(reactionOps.getByTargetMessageIds(SLUG, ['target-1'])[0].reactor_jid).toBe(ALICE_LID)

        const change = reactionMsg({ id: 'r-2', remoteJid: GROUP_JID, participant: ALICE, targetId: 'target-1', text: '❤️', senderTimestampMs: 2000 })
        ;(change.key as any).participantAlt = ALICE_LID
        await transformer.processMessage(change, chatId)
        const rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ reactor_jid: ALICE, emoji: '❤️' })
      })

      it('a LID reactor with no known mapping is stored under the LID', async () => {
        const chatId = createTestChat(GROUP_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)
        await transformer.processMessage(reactionMsg({ id: 'r-1', remoteJid: GROUP_JID, participant: ALICE_LID, targetId: 'target-1', text: '👍', senderTimestampMs: 1000 }), chatId)
        const rows = reactionOps.getByTargetMessageIds(SLUG, ['target-1'])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ reactor_jid: ALICE_LID, emoji: '👍' })
      })

      it('learns the LID↔PN pair from the reaction key into contacts', async () => {
        const chatId = createTestChat(GROUP_JID)
        const transformer = new MessageTransformer(SLUG, socketWithUser)
        const msg = reactionMsg({ id: 'r-1', remoteJid: GROUP_JID, participant: ALICE_LID, targetId: 'target-1', text: '👍', senderTimestampMs: 1000 })
        ;(msg.key as any).participantAlt = ALICE
        await transformer.processMessage(msg, chatId)
        expect((contactOps.getByJid(SLUG, ALICE) as any)?.lid).toBe(ALICE_LID)
        expect(contactOps.getByJid(SLUG, ALICE_LID)).toBeTruthy()
      })
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

