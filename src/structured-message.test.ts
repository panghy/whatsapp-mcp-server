import { describe, it, expect } from 'vitest'
import { TransformedMessage } from './message-transformer'
import { toStructuredMessage, structuredMessageSchema } from './structured-message'

const baseTimestamp = '2024-01-01T00:00:00.000Z'

describe('toStructuredMessage', () => {
  it('projects a regular text message and preserves inline mentions verbatim', () => {
    const input: TransformedMessage = {
      type: 'message',
      messageId: 'm1',
      timestamp: baseTimestamp,
      sender: { name: 'Alice', phone: '+111' },
      text: 'Hi @Bob:+222 and @Charlie:+333',
      mentionedJids: ['bob@s.whatsapp.net', 'charlie@s.whatsapp.net'],
      isFromMe: false
    }
    const out = toStructuredMessage(input)
    expect(structuredMessageSchema.parse(out)).toEqual(out)
    expect(out.sender).toEqual({ name: 'Alice', phone: '+111', isMe: false })
    expect(out.text).toBe('Hi @Bob:+222 and @Charlie:+333')
    expect((out as any).mentionedJids).toBeUndefined()
    expect(out.replyTo).toBeUndefined()
  })

  it('projects a reply to structured replyTo and drops replyToMessageId', () => {
    const input: TransformedMessage = {
      type: 'message',
      messageId: 'm2',
      timestamp: baseTimestamp,
      sender: { name: 'Replier', phone: '+222' },
      text: 'me too',
      replyToMessageId: 'orig-1',
      replyTo: {
        messageId: 'orig-1',
        senderName: 'Original Sender',
        senderPhone: '+111',
        fullText: 'a longer original text body that should be summarised',
        preview: 'a longer original text body that should be summa'
      }
    }
    const out = toStructuredMessage(input)
    expect(structuredMessageSchema.parse(out)).toEqual(out)
    expect(out.replyTo).toEqual({
      messageId: 'orig-1',
      sender: { name: 'Original Sender', phone: '+111' },
      preview: 'a longer original text body that should be summa'
    })
    expect((out as any).replyToMessageId).toBeUndefined()
  })

  it('preserves the forwarded flag', () => {
    const input: TransformedMessage = {
      type: 'message',
      messageId: 'm3',
      timestamp: baseTimestamp,
      sender: { name: 'Fwd', phone: '+999' },
      text: 'fyi',
      forwarded: true
    }
    const out = toStructuredMessage(input)
    expect(out.forwarded).toBe(true)
  })

  it('projects an unsupported attachment with reason and mimeType', () => {
    const input: TransformedMessage = {
      type: 'unsupported_attachment',
      messageId: 'm4',
      timestamp: baseTimestamp,
      sender: { name: 'Sender', phone: '+1' },
      filename: 'big.zip',
      mimeType: 'application/zip',
      fileSize: 9999999,
      reason: 'unsupported_type'
    }
    const out = toStructuredMessage(input)
    expect(structuredMessageSchema.parse(out)).toEqual(out)
    expect(out.attachment).toEqual({
      filename: 'big.zip', mimeType: 'application/zip', fileSize: 9999999, reason: 'unsupported_type'
    })
    expect(out.sender).toEqual({ name: 'Sender', phone: '+1', isMe: false })
  })

  it('projects a system message with null sender and systemDetails', () => {
    const input: TransformedMessage = {
      type: 'system',
      messageId: 'm5',
      timestamp: baseTimestamp,
      systemType: 'number_change',
      details: { userName: 'Alice', oldNumber: '+111', newNumber: '+999' }
    }
    const out = toStructuredMessage(input)
    expect(structuredMessageSchema.parse(out)).toEqual(out)
    expect(out.sender).toBeNull()
    expect(out.systemType).toBe('number_change')
    expect(out.systemDetails).toEqual({ userName: 'Alice', oldNumber: '+111', newNumber: '+999' })
    expect((out as any).details).toBeUndefined()
  })

  it('projects a deletion event with null top-level sender and populated deletedBy/deletedMessage', () => {
    const input: TransformedMessage = {
      type: 'message_deleted',
      messageId: 'del-1',
      timestamp: baseTimestamp,
      deletedBy: { name: 'Deleter', phone: '+222' },
      deletedMessage: {
        messageId: 'orig-1',
        text: 'oops',
        sender: { name: 'Original', phone: '+111' },
        timestamp: '2023-12-31T23:59:59.000Z'
      }
    }
    const out = toStructuredMessage(input)
    expect(structuredMessageSchema.parse(out)).toEqual(out)
    expect(out.sender).toBeNull()
    expect(out.deletedBy).toEqual({ name: 'Deleter', phone: '+222' })
    expect(out.deletedMessage).toEqual({
      messageId: 'orig-1', text: 'oops', timestamp: '2023-12-31T23:59:59.000Z'
    })
  })

  it('projects an edit event with null top-level sender and editedBy/editedMessage', () => {
    const input: TransformedMessage = {
      type: 'message_edited',
      messageId: 'edit-1',
      timestamp: baseTimestamp,
      editedBy: { name: 'Editor', phone: '+222' },
      editedMessage: {
        messageId: 'orig-2',
        originalText: 'old',
        newText: 'new',
        sender: { name: 'Original', phone: '+111' }
      }
    }
    const out = toStructuredMessage(input)
    expect(structuredMessageSchema.parse(out)).toEqual(out)
    expect(out.sender).toBeNull()
    expect(out.editedBy).toEqual({ name: 'Editor', phone: '+222' })
    expect(out.editedMessage).toEqual({ messageId: 'orig-2', originalText: 'old', newText: 'new' })
  })

  it('marks sender.isMe true when isFromMe is true', () => {
    const input: TransformedMessage = {
      type: 'message',
      messageId: 'm-me',
      timestamp: baseTimestamp,
      sender: { name: 'Me', phone: '+1234567890' },
      text: 'sent by me',
      isFromMe: true
    }
    const out = toStructuredMessage(input)
    expect(out.sender).toEqual({ name: 'Me', phone: '+1234567890', isMe: true })
  })
})

