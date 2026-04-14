import { TransformedMessage } from './message-transformer'

/**
 * Default timestamp gap threshold: 1 hour in milliseconds.
 * A new timestamp line is emitted when the gap between consecutive messages exceeds this.
 */
const DEFAULT_TIMESTAMP_GAP_MS = 60 * 60 * 1000 // 1 hour

/**
 * Format a date as "YYYY-MM-DD HH:mm UTC±X" in local timezone.
 */
function formatTimestamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  // getTimezoneOffset() returns minutes *west* of UTC, so we negate for conventional sign
  const offsetMinutes = -date.getTimezoneOffset()
  const offsetHours = Math.trunc(offsetMinutes / 60)
  const offsetRemainder = Math.abs(offsetMinutes % 60)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const tzSuffix = offsetRemainder === 0
    ? `UTC${sign}${Math.abs(offsetHours)}`
    : `UTC${sign}${Math.abs(offsetHours)}:${String(offsetRemainder).padStart(2, '0')}`

  return `${year}-${month}-${day} ${hours}:${minutes} ${tzSuffix}`
}

/**
 * Collapse newlines to literal \n (keeps format unambiguous).
 */
function escapeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\n')
}

/**
 * Format sender identity according to display rules (priority order):
 * 1. Name:+Phone — both exist, name ≠ phone, name doesn't start with "Unknown"
 * 2. +Phone — name equals phone, or name starts with "Unknown" but phone exists, or name missing but phone exists
 * 3. Name — phone is null and name is a real name (not "Unknown*")
 * 4. Unknown_<JID> — no name AND no phone (never bare "Unknown")
 */
function formatSenderIdentity(
  sender: { name?: string; phone?: string | null } | null | undefined,
  jid?: string
): string {
  const name = sender?.name || ''
  const phone = sender?.phone || null

  // Case 1: Both name and phone exist, name ≠ phone, name doesn't start with "Unknown"
  if (name && phone && name !== phone && !name.startsWith('Unknown')) {
    return `${name}:${phone}`
  }

  // Case 2: Phone exists but name is missing/equals phone/starts with "Unknown"
  if (phone) {
    return phone
  }

  // Case 3: Phone is null, name is a real name (not bare "Unknown")
  // Allow "Unknown_<jid>" format through since that's our fallback format
  if (name && (name !== 'Unknown')) {
    return name
  }

  // Case 4: No name AND no phone — use Unknown_<JID> if jid provided
  if (jid) {
    return `Unknown_${jid}`
  }

  return 'Unknown'
}

/**
 * Format reply sender identity using same rules as formatSenderIdentity.
 */
function formatReplySenderIdentity(
  senderName: string | undefined,
  senderPhone: string | null | undefined
): string | null {
  // If no sender name and no phone, return null (no sender to display)
  if (!senderName && !senderPhone) {
    return null
  }

  const sender = { name: senderName, phone: senderPhone }
  return formatSenderIdentity(sender)
}

/**
 * Identity information for the current user (me).
 */
export interface MeIdentity {
  name: string
  phone: string
}

/**
 * Build sender prefix: "Name:+Phone >" for isFromMe with meIdentity, "(me) >" for isFromMe without, "Name:+Phone >" for others.
 */
function getSenderPrefix(msg: TransformedMessage, meIdentity?: MeIdentity): string {
  if (msg.isFromMe) {
    if (meIdentity) {
      return formatSenderIdentity(meIdentity)
    }
    return '(me)'
  }
  return formatSenderIdentity(msg.sender)
}

/**
 * Build annotations for a message: [fwd], [re: ...].
 */
function buildAnnotations(msg: TransformedMessage): string[] {
  const annotations: string[] = []

  if (msg.forwarded) {
    annotations.push('[fwd]')
  }

  if (msg.replyTo) {
    // Truncate preview to ~20 chars with ellipsis
    const preview = msg.replyTo.preview.length > 20
      ? msg.replyTo.preview.substring(0, 20) + '...'
      : msg.replyTo.preview
    const replyIdentity = formatReplySenderIdentity(msg.replyTo.senderName, msg.replyTo.senderPhone)
    if (replyIdentity) {
      annotations.push(`[re ${replyIdentity}: "${escapeNewlines(preview)}"]`)
    } else {
      annotations.push(`[re: "${escapeNewlines(preview)}"]`)
    }
  }

  return annotations
}

/**
 * Serialize a regular message line.
 */
function serializeMessage(msg: TransformedMessage, meIdentity?: MeIdentity): string {
  const prefix = getSenderPrefix(msg, meIdentity)
  const annotations = buildAnnotations(msg)
  const text = msg.text ? escapeNewlines(msg.text) : ''

  // Annotations go before text, separated by space
  const annotationStr = annotations.length > 0 ? annotations.join(' ') + ' ' : ''

  return `${prefix} > ${annotationStr}${text}`
}

/**
 * Serialize an unsupported_attachment message.
 */
function serializeUnsupportedAttachment(msg: TransformedMessage, meIdentity?: MeIdentity): string {
  const prefix = getSenderPrefix(msg, meIdentity)
  const mimeType = msg.mimeType || 'unknown'
  return `${prefix} > [unsupported: ${mimeType}]`
}

/**
 * Serialize a system message.
 */
function serializeSystemMessage(msg: TransformedMessage): string {
  const systemType = msg.systemType || 'unknown'
  let details = ''

  if (msg.details) {
    if (msg.systemType === 'number_change') {
      const { userName, oldNumber, newNumber } = msg.details
      details = ` ${userName || '?'} changed from ${oldNumber || '?'} to ${newNumber || '?'}`
    } else {
      // Generic details serialization
      details = ' ' + JSON.stringify(msg.details)
    }
  }

  return `[system: ${systemType}]${details}`
}

/**
 * Serialize a message_deleted event.
 */
function serializeDeletedMessage(msg: TransformedMessage): string {
  const deletedText = msg.deletedMessage?.text
    ? `"${escapeNewlines(msg.deletedMessage.text)}"`
    : '""'
  const deletedByIdentity = formatSenderIdentity(msg.deletedBy)
  return `[deleted] ${deletedText} (by ${deletedByIdentity})`
}

/**
 * Serialize a message_edited event.
 */
function serializeEditedMessage(msg: TransformedMessage): string {
  const oldText = msg.editedMessage?.originalText
    ? `"${escapeNewlines(msg.editedMessage.originalText)}"`
    : '""'
  const newText = msg.editedMessage?.newText
    ? `"${escapeNewlines(msg.editedMessage.newText)}"`
    : '""'
  const editedByIdentity = formatSenderIdentity(msg.editedBy)
  return `[edited] ${oldText} → ${newText} (by ${editedByIdentity})`
}

/**
 * Serialize a single message to a compact line.
 */
function serializeSingleMessage(msg: TransformedMessage, meIdentity?: MeIdentity): string {
  switch (msg.type) {
    case 'message':
      return serializeMessage(msg, meIdentity)
    case 'unsupported_attachment':
      return serializeUnsupportedAttachment(msg, meIdentity)
    case 'system':
      return serializeSystemMessage(msg)
    case 'message_deleted':
      return serializeDeletedMessage(msg)
    case 'message_edited':
      return serializeEditedMessage(msg)
    default:
      // Fallback for unknown types
      return `[unknown type: ${(msg as any).type}]`
  }
}

/**
 * Serialize an array of TransformedMessage objects to compact text format.
 *
 * @param messages - Array of messages (assumed sorted by timestamp ascending)
 * @param timestampGapMs - Gap threshold for emitting timestamp lines (default: 1 hour)
 * @param meIdentity - Optional identity for the current user (replaces "(me)" with "Name:+Phone")
 * @returns Compact text representation
 */
export function serializeCompact(
  messages: TransformedMessage[],
  timestampGapMs: number = DEFAULT_TIMESTAMP_GAP_MS,
  meIdentity?: MeIdentity
): string {
  if (messages.length === 0) {
    return ''
  }

  const lines: string[] = []
  let lastTimestamp: Date | null = null

  for (const msg of messages) {
    const msgDate = new Date(msg.timestamp)
    const msgTime = msgDate.getTime()

    // Emit timestamp line if first message or gap exceeds threshold
    const shouldEmitTimestamp =
      lastTimestamp === null ||
      (msgTime - lastTimestamp.getTime() > timestampGapMs)

    if (shouldEmitTimestamp) {
      lines.push(`--- ${formatTimestamp(msgDate)} ---`)
      lastTimestamp = msgDate
    }

    lines.push(serializeSingleMessage(msg, meIdentity))
  }

  return lines.join('\n')
}

