import { describe, it, expect, vi } from 'vitest'

// Mock electron before importing modules that depend on it
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test' }
}))

import { serializeCompact, MeIdentity } from './compact-serializer'
import { TransformedMessage, extractPhoneFromJid } from './message-transformer'

// Helper to create a basic message
function createMessage(overrides: Partial<TransformedMessage> = {}): TransformedMessage {
  return {
    type: 'message',
    messageId: `msg-${Date.now()}`,
    sender: { name: 'John', phone: '+1234567890' },
    timestamp: '2024-01-15T12:00:00.000Z',
    text: 'Hello world',
    isFromMe: false,
    ...overrides
  }
}

describe('serializeCompact', () => {
  describe('empty and single message', () => {
    it('should return empty string for empty array', () => {
      expect(serializeCompact([])).toBe('')
    })

    it('should serialize single text message with timestamp', () => {
      const msg = createMessage({ timestamp: '2024-01-15T12:00:00.000Z' })
      const result = serializeCompact([msg])
      expect(result).toContain('John:+1234567890 > Hello world')
      expect(result).toMatch(/^--- \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC[+-]\d+ ---/)
    })
  })

  describe('timestamp gaps', () => {
    it('should emit separator for timestamp gaps > 1 hour', () => {
      const msg1 = createMessage({ messageId: 'msg-1', timestamp: '2024-01-15T12:00:00.000Z', text: 'First' })
      const msg2 = createMessage({ messageId: 'msg-2', timestamp: '2024-01-15T14:00:00.000Z', text: 'Second' })
      const result = serializeCompact([msg1, msg2])
      const separatorMatches = result.match(/^---/gm)
      expect(separatorMatches?.length).toBe(2)
    })

    it('should NOT emit extra separator for messages within 1 hour', () => {
      const msg1 = createMessage({ messageId: 'msg-1', timestamp: '2024-01-15T12:00:00.000Z', text: 'First' })
      const msg2 = createMessage({ messageId: 'msg-2', timestamp: '2024-01-15T12:30:00.000Z', text: 'Second' })
      const result = serializeCompact([msg1, msg2])
      const separatorMatches = result.match(/^---/gm)
      expect(separatorMatches?.length).toBe(1)
    })

    it('should respect custom timestamp gap threshold', () => {
      const msg1 = createMessage({ messageId: 'msg-1', timestamp: '2024-01-15T12:00:00.000Z', text: 'First' })
      const msg2 = createMessage({ messageId: 'msg-2', timestamp: '2024-01-15T12:10:00.000Z', text: 'Second' })
      // 5 minute threshold in ms
      const result = serializeCompact([msg1, msg2], 5 * 60 * 1000)
      const separatorMatches = result.match(/^---/gm)
      expect(separatorMatches?.length).toBe(2)
    })
  })

  describe('meIdentity parameter', () => {
    it('should show (me) when isFromMe and no meIdentity', () => {
      const msg = createMessage({ isFromMe: true, text: 'My message' })
      const result = serializeCompact([msg])
      expect(result).toContain('(me) > My message')
    })

    it('should show meIdentity when isFromMe and meIdentity provided', () => {
      const msg = createMessage({ isFromMe: true, text: 'My message' })
      const meIdentity: MeIdentity = { name: 'Me', phone: '+9876543210' }
      const result = serializeCompact([msg], undefined, meIdentity)
      expect(result).toContain('Me:+9876543210 > My message')
    })
  })

  describe('sender identity formatting', () => {
    it('should format Name:+Phone when both exist', () => {
      const msg = createMessage({ sender: { name: 'Alice', phone: '+1111111111' } })
      const result = serializeCompact([msg])
      expect(result).toContain('Alice:+1111111111 >')
    })

    it('should show only phone when name equals phone', () => {
      const msg = createMessage({ sender: { name: '+2222222222', phone: '+2222222222' } })
      const result = serializeCompact([msg])
      expect(result).toContain('+2222222222 >')
      expect(result).not.toContain('+2222222222:+2222222222')
    })

    it('should show only phone when name starts with Unknown', () => {
      const msg = createMessage({ sender: { name: 'Unknown_123', phone: '+3333333333' } })
      const result = serializeCompact([msg])
      expect(result).toContain('+3333333333 >')
    })

    it('should show name only when phone is null', () => {
      const msg = createMessage({ sender: { name: 'Bob', phone: null } })
      const result = serializeCompact([msg])
      expect(result).toContain('Bob >')
      expect(result).not.toContain('Bob:')
    })

    it('should show Unknown_JID when no name and no phone', () => {
      const msg = createMessage({ sender: { name: '', phone: null } })
      const result = serializeCompact([msg])
      expect(result).toMatch(/Unknown[_ >]/)
    })
  })

  describe('newline escaping', () => {
    it('should escape newlines in text', () => {
      const msg = createMessage({ text: 'Line1\nLine2\nLine3' })
      const result = serializeCompact([msg])
      expect(result).toContain('Line1\\nLine2\\nLine3')
      expect(result).not.toContain('Line1\nLine2')
    })

    it('should escape CRLF sequences', () => {
      const msg = createMessage({ text: 'Windows\r\nLine' })
      const result = serializeCompact([msg])
      expect(result).toContain('Windows\\nLine')
    })
  })

  describe('message types', () => {
    it('should serialize deleted message', () => {
      const msg = createMessage({
        type: 'message_deleted',
        deletedMessage: { messageId: 'orig-1', text: 'Original text', sender: { name: 'User', phone: '+111' } },
        deletedBy: { name: 'Admin', phone: '+222' }
      })
      const result = serializeCompact([msg])
      expect(result).toContain('[deleted] "Original text" (by Admin:+222)')
    })

    it('should serialize edited message', () => {
      const msg = createMessage({
        type: 'message_edited',
        editedMessage: { messageId: 'orig-1', originalText: 'Old text', newText: 'New text' },
        editedBy: { name: 'Editor', phone: '+333' }
      })
      const result = serializeCompact([msg])
      expect(result).toContain('[edited] "Old text" → "New text" (by Editor:+333)')
    })

    it('should serialize system message', () => {
      const msg = createMessage({
        type: 'system',
        systemType: 'number_change',
        details: { userName: 'John', oldNumber: '+111', newNumber: '+222' }
      })
      const result = serializeCompact([msg])
      expect(result).toContain('[system: number_change] John changed from +111 to +222')
    })

    it('should serialize unsupported_attachment', () => {
      const msg = createMessage({
        type: 'unsupported_attachment',
        mimeType: 'video/mp4',
        filename: 'video.mp4'
      })
      const result = serializeCompact([msg])
      expect(result).toContain('[unsupported: video/mp4]')
    })

    it('should serialize forwarded message', () => {
      const msg = createMessage({ forwarded: true, text: 'Forwarded content' })
      const result = serializeCompact([msg])
      expect(result).toContain('[fwd] Forwarded content')
    })

    it('should serialize reply message', () => {
      const msg = createMessage({
        text: 'Reply text',
        replyTo: {
          messageId: 'orig-1',
          senderName: 'Original Sender',
          senderPhone: '+444',
          fullText: 'Original message that was replied to',
          preview: 'Original message that...'
        }
      })
      const result = serializeCompact([msg])
      expect(result).toContain('[re Original Sender:+444:')
      expect(result).toContain('Reply text')
    })

    it('should serialize reply with truncated preview > 20 chars', () => {
      const msg = createMessage({
        text: 'Reply',
        replyTo: {
          messageId: 'orig-1',
          senderName: 'Bob',
          senderPhone: '+555',
          fullText: 'This is a very long message that exceeds twenty characters',
          preview: 'This is a very long message that exceeds twenty characters'
        }
      })
      const result = serializeCompact([msg])
      expect(result).toContain('This is a very long ...')
    })
  })
})

describe('extractPhoneFromJid', () => {
  it('should extract phone from standard JID', () => {
    expect(extractPhoneFromJid('1234567890@s.whatsapp.net')).toBe('+1234567890')
  })

  it('should extract phone from JID with device suffix', () => {
    expect(extractPhoneFromJid('1234567890:1@s.whatsapp.net')).toBe('+1234567890')
  })

  it('should extract phone from c.us JID', () => {
    expect(extractPhoneFromJid('1234567890@c.us')).toBe('+1234567890')
  })

  it('should return null for group JID', () => {
    expect(extractPhoneFromJid('123456789-1234567890@g.us')).toBe(null)
  })

  it('should return null for LID JID', () => {
    expect(extractPhoneFromJid('abc@lid')).toBe(null)
  })

  it('should return null for invalid JID format', () => {
    expect(extractPhoneFromJid('invalid-jid')).toBe(null)
  })

  it('should return null for JID with letters in number', () => {
    expect(extractPhoneFromJid('abc123@s.whatsapp.net')).toBe(null)
  })

  it('should handle long phone numbers', () => {
    expect(extractPhoneFromJid('123456789012345@s.whatsapp.net')).toBe('+123456789012345')
  })
})

