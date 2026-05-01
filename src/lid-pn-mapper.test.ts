import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'

const { testDir } = vi.hoisted(() => {
  const p = require('path')
  const os = require('os')
  const testDir = p.join(os.tmpdir(), 'wa-lid-pn-mapper-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  return { testDir }
})

vi.mock('electron', () => ({
  app: { getPath: () => testDir }
}))

import {
  isLidJid,
  isPnJid,
  classifyJidPair,
  extractLidPnFromMessageKey,
  extractLidPnFromContact,
  recordContactFromBaileys,
  recordLidPnFromMessageKey,
  recordLidMappingUpdate,
  persistLidPnMapping,
} from './lid-pn-mapper'
import {
  initializeDatabase,
  closeAllDatabases,
  contactOps,
} from './database'

const SLUG = 'test-mapper'
const LID = '111222333@lid'
const HOSTED_LID = '999888777@hosted.lid'
const PN = '15551234567@s.whatsapp.net'

describe('lid-pn-mapper pure helpers', () => {
  it('classifies LID/PN jids', () => {
    expect(isLidJid(LID)).toBe(true)
    expect(isLidJid(HOSTED_LID)).toBe(true)
    expect(isLidJid(PN)).toBe(false)
    expect(isPnJid(PN)).toBe(true)
    expect(isPnJid('15551234567:5@s.whatsapp.net')).toBe(true)
    expect(isPnJid(LID)).toBe(false)
  })

  it('classifyJidPair detects either ordering and strips device suffixes', () => {
    expect(classifyJidPair(LID, PN)).toEqual({ lidJid: LID, pnJid: PN })
    expect(classifyJidPair(PN, LID)).toEqual({ lidJid: LID, pnJid: PN })
    expect(classifyJidPair('111222333:7@lid', '15551234567:3@s.whatsapp.net')).toEqual({
      lidJid: LID,
      pnJid: PN,
    })
    expect(classifyJidPair(LID, LID)).toBeNull()
    expect(classifyJidPair(undefined, PN)).toBeNull()
    expect(classifyJidPair(null, null)).toBeNull()
  })

  it('extractLidPnFromMessageKey reads participant/participantAlt and remoteJid/remoteJidAlt', () => {
    const key = { remoteJid: 'group@g.us', participant: LID, participantAlt: PN, addressingMode: 'lid' }
    const pairs = extractLidPnFromMessageKey(key)
    expect(pairs).toEqual([{ lidJid: LID, pnJid: PN }])

    const dmKey = { remoteJid: PN, remoteJidAlt: LID, addressingMode: 'pn' }
    expect(extractLidPnFromMessageKey(dmKey)).toEqual([{ lidJid: LID, pnJid: PN }])

    const empty = { remoteJid: 'group@g.us', participant: LID }
    expect(extractLidPnFromMessageKey(empty)).toEqual([])
    expect(extractLidPnFromMessageKey(null)).toEqual([])
  })

  it('extractLidPnFromContact prefers id+lid, then id+phoneNumber, then lid+phoneNumber', () => {
    expect(extractLidPnFromContact({ id: PN, lid: LID })).toEqual({ lidJid: LID, pnJid: PN })
    expect(extractLidPnFromContact({ id: LID, phoneNumber: PN })).toEqual({ lidJid: LID, pnJid: PN })
    expect(extractLidPnFromContact({ id: 'group@g.us', lid: LID, phoneNumber: PN }))
      .toEqual({ lidJid: LID, pnJid: PN })
    expect(extractLidPnFromContact({ id: PN })).toBeNull()
    expect(extractLidPnFromContact(null)).toBeNull()
  })
})

describe('lid-pn-mapper persistence', () => {
  beforeAll(() => { fs.mkdirSync(testDir, { recursive: true }) })
  afterAll(() => {
    closeAllDatabases()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })
  beforeEach(() => {
    closeAllDatabases()
    const accountsRoot = require('path').join(testDir, 'accounts')
    if (fs.existsSync(accountsRoot)) fs.rmSync(accountsRoot, { recursive: true, force: true })
    initializeDatabase(SLUG)
  })
  afterEach(() => { closeAllDatabases() })

  it('persistLidPnMapping writes both PN-rooted and LID-rooted rows', () => {
    persistLidPnMapping(SLUG, { lidJid: LID, pnJid: PN }, 'Alice')
    const pnRow = contactOps.getByJid(SLUG, PN) as any
    const lidRow = contactOps.getByJid(SLUG, LID) as any
    expect(pnRow.lid).toBe(LID)
    expect(pnRow.phone_number).toBe('+15551234567')
    expect(pnRow.name).toBe('Alice')
    expect(lidRow.phone_number).toBe('+15551234567')
    expect(lidRow.name).toBe('Alice')
    expect(contactOps.getByLid(SLUG, LID)).toBeTruthy()
    expect(contactOps.getByPhone(SLUG, '+15551234567')).toBeTruthy()
  })

  it('recordContactFromBaileys persists the id row plus the cross-pair', () => {
    const persisted = recordContactFromBaileys(SLUG, {
      id: PN, lid: LID, name: 'Bob'
    })
    expect(persisted).toBe(true)
    const pnRow = contactOps.getByJid(SLUG, PN) as any
    expect(pnRow.lid).toBe(LID)
    expect(pnRow.name).toBe('Bob')
    const lidRow = contactOps.getByJid(SLUG, LID) as any
    expect(lidRow.phone_number).toBe('+15551234567')
  })

  it('recordContactFromBaileys is a no-op when there is no usable identifier', () => {
    expect(recordContactFromBaileys(SLUG, null)).toBe(false)
    expect(recordContactFromBaileys(SLUG, { id: '' })).toBe(false)
    // A bare LID id with no name/phone/lid pair has nothing to persist.
    expect(recordContactFromBaileys(SLUG, { id: LID })).toBe(false)
    // A bare group id is also skipped.
    expect(recordContactFromBaileys(SLUG, { id: 'group@g.us' })).toBe(false)
    expect(contactOps.getAll(SLUG)).toEqual([])
  })

  it('recordLidPnFromMessageKey upserts both rows for a group LID-addressed message', () => {
    const count = recordLidPnFromMessageKey(SLUG, {
      remoteJid: 'group@g.us', participant: LID, participantAlt: PN, addressingMode: 'lid'
    })
    expect(count).toBe(1)
    expect((contactOps.getByJid(SLUG, PN) as any).lid).toBe(LID)
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
  })

  it('recordLidMappingUpdate persists both directions from {lid, pn}', () => {
    expect(recordLidMappingUpdate(SLUG, { lid: LID, pn: PN })).toBe(true)
    expect((contactOps.getByJid(SLUG, PN) as any).lid).toBe(LID)
    expect(contactOps.getByJid(SLUG, LID)).toBeTruthy()
    expect(recordLidMappingUpdate(SLUG, { lid: LID, pn: '' })).toBe(false)
    expect(recordLidMappingUpdate(SLUG, null)).toBe(false)
  })
})

