import { contactOps } from './database'
import { extractPhoneFromJid, normalizePhoneNumber } from './message-transformer'

const LID_RE = /^\d+(?::\d+)?@(?:hosted\.)?lid$/
const PN_RE = /^\d+(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/

export interface LidPnPair { lidJid: string; pnJid: string }

export function isLidJid(jid?: string | null): boolean {
  return !!jid && LID_RE.test(jid)
}

export function isPnJid(jid?: string | null): boolean {
  return !!jid && PN_RE.test(jid)
}

function stripDeviceSuffix(jid: string): string {
  return jid.replace(/^(\d+):\d+@/, '$1@')
}

/**
 * Take an unordered pair of strings and detect which one is LID and which is PN.
 * Device suffixes (`:N`) are stripped before pairing.
 */
export function classifyJidPair(a?: string | null, b?: string | null): LidPnPair | null {
  const aIsLid = isLidJid(a); const aIsPn = isPnJid(a)
  const bIsLid = isLidJid(b); const bIsPn = isPnJid(b)
  if (aIsLid && bIsPn) return { lidJid: stripDeviceSuffix(a!), pnJid: stripDeviceSuffix(b!) }
  if (bIsLid && aIsPn) return { lidJid: stripDeviceSuffix(b!), pnJid: stripDeviceSuffix(a!) }
  return null
}

/**
 * Pull all `{lidJid, pnJid}` pairs from a Baileys WAMessage key. Considers the
 * `participant`/`participantAlt` slot (group senders) and the
 * `remoteJid`/`remoteJidAlt` slot (DM chat ids).
 */
export function extractLidPnFromMessageKey(key: any): LidPnPair[] {
  const out: LidPnPair[] = []
  if (!key) return out
  const p = classifyJidPair(key.participant, key.participantAlt)
  if (p) out.push(p)
  const r = classifyJidPair(key.remoteJid, key.remoteJidAlt)
  if (r) out.push(r)
  return out
}

/**
 * Pull a `{lidJid, pnJid}` pair from a Baileys Contact (or Partial<Contact>).
 * The Contact type exposes `id` (preferred form, LID or PN), `lid` and
 * `phoneNumber` (PN as `<digits>@s.whatsapp.net`).
 */
export function extractLidPnFromContact(
  contact: { id?: string | null; lid?: string | null; phoneNumber?: string | null } | null | undefined
): LidPnPair | null {
  if (!contact) return null
  const id = contact.id || null
  const lid = contact.lid || null
  const pn = contact.phoneNumber || null
  return (
    classifyJidPair(id, lid) ||
    classifyJidPair(id, pn) ||
    classifyJidPair(lid, pn) ||
    null
  )
}

/**
 * Persist an LID↔PN pair into the contacts table. Creates/updates two rows so
 * later `getByJid`, `getByLid` and `getByPhone` lookups all hit:
 *   - PN-rooted: `jid=pnJid, lid=lidJid, phone_number=normalizedPhone`
 *   - LID-rooted: `jid=lidJid, phone_number=normalizedPhone`
 * `name` is applied to both rows when given.
 */
export function persistLidPnMapping(slug: string, pair: LidPnPair, name?: string | null): void {
  const phone = extractPhoneFromJid(pair.pnJid) ?? undefined
  contactOps.insert(slug, pair.pnJid, name || undefined, phone, pair.lidJid)
  contactOps.insert(slug, pair.lidJid, name || undefined, phone, undefined)
}

/**
 * Persist a Baileys Contact (from `contacts.upsert` / `contacts.update`).
 * Stores the row keyed on `contact.id` and additionally cross-stores the
 * paired LID/PN row when both forms are known.
 */
export function recordContactFromBaileys(
  slug: string,
  contact: {
    id?: string | null
    lid?: string | null
    phoneNumber?: string | null
    name?: string | null
    notify?: string | null
  } | null | undefined
): boolean {
  if (!contact) return false
  const id = contact.id || ''
  if (!id) return false
  const name = contact.name || contact.notify || undefined
  const lid = contact.lid || undefined
  const pnField = contact.phoneNumber || undefined
  const phone = pnField
    ? (extractPhoneFromJid(pnField) ?? normalizePhoneNumber(pnField) ?? undefined)
    : (extractPhoneFromJid(id) ?? undefined)

  let persisted = false
  if (name || phone || lid) {
    contactOps.insert(slug, id, name, phone, lid)
    persisted = true
  }

  const pair = extractLidPnFromContact(contact)
  if (pair) {
    persistLidPnMapping(slug, pair, name)
    persisted = true
  }
  return persisted
}

/**
 * Persist LID↔PN pairs harvested from a single Baileys WAMessage key.
 * Best-effort: silently no-ops when the key has no usable LID/PN slots.
 */
export function recordLidPnFromMessageKey(slug: string, key: any): number {
  const pairs = extractLidPnFromMessageKey(key)
  for (const pair of pairs) persistLidPnMapping(slug, pair)
  return pairs.length
}

/**
 * Persist a `lid-mapping.update` event payload. Baileys emits this when it
 * learns of a fresh LID↔PN mapping (e.g., during signal-protocol setup).
 * The payload is `{ lid, pn }` where both are full JIDs.
 */
export function recordLidMappingUpdate(
  slug: string,
  payload: { lid?: string | null; pn?: string | null } | null | undefined
): boolean {
  if (!payload) return false
  const pair = classifyJidPair(payload.lid, payload.pn)
  if (!pair) return false
  persistLidPnMapping(slug, pair)
  return true
}

