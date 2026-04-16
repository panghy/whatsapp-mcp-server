import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'

const testDir = vi.hoisted(() => {
  const os = require('os')
  const path = require('path')
  return path.join(os.tmpdir(), 'gmf-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
})

vi.mock('electron', () => ({
  app: { getPath: () => testDir }
}))

vi.mock('./message-transformer', () => ({
  extractPhoneFromJid: vi.fn((jid: string) => {
    const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/)
    return match ? `+${match[1]}` : null
  }),
  normalizePhoneNumber: vi.fn((input: string | undefined | null) => {
    if (!input) return null
    const stripped = input.replace(/[^\d+]/g, '')
    return stripped.startsWith('+') ? stripped : `+${stripped}`
  })
}))

import { initializeDatabase, closeDatabase, chatOps, contactOps } from './database'
import { GroupMetadataFetcher } from './group-metadata-fetcher'

const createMockSocket = (metadata?: any) => ({
  groupMetadata: vi.fn().mockResolvedValue(metadata || {
    id: 'group@g.us',
    participants: [
      { id: '1111@s.whatsapp.net', notify: 'Alice', phoneNumber: '+1111' },
      { id: '2222@s.whatsapp.net', name: 'Bob' }
    ]
  })
})

describe('GroupMetadataFetcher', () => {
  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    closeDatabase()
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    vi.useFakeTimers()
    closeDatabase()
    const dbDir = path.join(testDir, 'nodexa-whatsapp')
    if (fs.existsSync(dbDir)) {
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
    fs.mkdirSync(dbDir, { recursive: true })
    initializeDatabase()
  })

  afterEach(() => {
    vi.useRealTimers()
    closeDatabase()
  })

  describe('Constructor & basic methods', () => {
    it('creates instance with isRunning=false', () => {
      const fetcher = new GroupMetadataFetcher()
      const status = fetcher.getStatus()
      expect(status.isRunning).toBe(false)
    })

    it('getStatus() returns correct initial status', () => {
      const fetcher = new GroupMetadataFetcher()
      const status = fetcher.getStatus()
      expect(status).toEqual({
        isRunning: false,
        totalGroups: 0,
        fetchedCount: 0,
        currentGroup: null,
        lastError: null,
        nextRetryTime: null
      })
    })

    it('getRemainingCount() returns 0 initially', () => {
      const fetcher = new GroupMetadataFetcher()
      expect(fetcher.getRemainingCount()).toBe(0)
    })

    it('getCachedMetadata() returns undefined for unknown JID', () => {
      const fetcher = new GroupMetadataFetcher()
      expect(fetcher.getCachedMetadata('unknown@g.us')).toBeUndefined()
    })

    it('setSocket() sets the socket', () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = createMockSocket()
      fetcher.setSocket(mockSocket)
      chatOps.insert('group@g.us', 'group', undefined, 'Test Group')
      const chat = chatOps.getByWhatsappJid('group@g.us') as any
      fetcher.queueGroups([{ chatId: chat.id, jid: 'group@g.us' }])
      fetcher.start()
      expect(fetcher.getStatus().isRunning).toBe(true)
      fetcher.stop()
    })
  })

  describe('queueGroups()', () => {
    it('queues new groups', () => {
      const fetcher = new GroupMetadataFetcher()
      fetcher.queueGroups([
        { chatId: 1, jid: 'group1@g.us' },
        { chatId: 2, jid: 'group2@g.us' }
      ])
      expect(fetcher.getRemainingCount()).toBe(2)
    })

    it('deduplicates groups with same JID', () => {
      const fetcher = new GroupMetadataFetcher()
      fetcher.queueGroups([
        { chatId: 1, jid: 'group@g.us' },
        { chatId: 2, jid: 'group@g.us' }
      ])
      expect(fetcher.getRemainingCount()).toBe(1)
    })

    it('adds to existing queue (does not replace)', () => {
      const fetcher = new GroupMetadataFetcher()
      fetcher.queueGroups([{ chatId: 1, jid: 'group1@g.us' }])
      fetcher.queueGroups([{ chatId: 2, jid: 'group2@g.us' }])
      expect(fetcher.getRemainingCount()).toBe(2)
    })
  })

  describe('start() / stop()', () => {
    it('start() without socket does not crash (logs error)', () => {
      const fetcher = new GroupMetadataFetcher()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      fetcher.start()
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no socket'))
      expect(fetcher.getStatus().isRunning).toBe(false)
      consoleSpy.mockRestore()
    })

    it('stop() sets isRunning=false', () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = createMockSocket()
      fetcher.setSocket(mockSocket)
      chatOps.insert('group@g.us', 'group')
      const chat = chatOps.getByWhatsappJid('group@g.us') as any
      fetcher.queueGroups([{ chatId: chat.id, jid: 'group@g.us' }])
      fetcher.start()
      expect(fetcher.getStatus().isRunning).toBe(true)
      fetcher.stop()
      expect(fetcher.getStatus().isRunning).toBe(false)
    })
  })

  describe('processNextGroup() (via start())', () => {
    it('successfully fetches metadata and increments fetchedCount', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = createMockSocket()
      fetcher.setSocket(mockSocket)

      chatOps.insert('group@g.us', 'group')
      const chat = chatOps.getByWhatsappJid('group@g.us') as any
      fetcher.queueGroups([{ chatId: chat.id, jid: 'group@g.us' }])

      fetcher.start()
      await vi.advanceTimersByTimeAsync(100)

      expect(mockSocket.groupMetadata).toHaveBeenCalledWith('group@g.us')
      expect(fetcher.getStatus().fetchedCount).toBe(1)
      expect(fetcher.getCachedMetadata('group@g.us')).toBeDefined()
      fetcher.stop()
    })

    it('stores participant contacts in DB', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = createMockSocket({
        id: 'group@g.us',
        participants: [
          { id: '1111@s.whatsapp.net', notify: 'Alice', phoneNumber: '+1111' },
          { id: '2222@s.whatsapp.net', name: 'Bob' }
        ]
      })
      fetcher.setSocket(mockSocket)

      chatOps.insert('group@g.us', 'group')
      const chat = chatOps.getByWhatsappJid('group@g.us') as any
      fetcher.queueGroups([{ chatId: chat.id, jid: 'group@g.us' }])

      fetcher.start()
      await vi.advanceTimersByTimeAsync(100)

      const alice = contactOps.getByJid('1111@s.whatsapp.net') as any
      expect(alice).toBeDefined()
      expect(alice.name).toBe('Alice')
      fetcher.stop()
    })
  })

  describe('Error handling in processNextGroup()', () => {
    it('rate limit error (429) applies exponential backoff', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = {
        groupMetadata: vi.fn().mockRejectedValue(new Error('rate-overlimit 429'))
      }
      fetcher.setSocket(mockSocket)

      chatOps.insert('group@g.us', 'group')
      const chat = chatOps.getByWhatsappJid('group@g.us') as any
      fetcher.queueGroups([{ chatId: chat.id, jid: 'group@g.us' }])

      fetcher.start()
      await vi.advanceTimersByTimeAsync(100)

      expect(fetcher.getStatus().lastError).toContain('rate-overlimit')
      expect(fetcher.getRemainingCount()).toBe(1) // Still in queue
      fetcher.stop()
    })

    it('forbidden error skips group', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = {
        groupMetadata: vi.fn().mockRejectedValue(new Error('forbidden'))
      }
      fetcher.setSocket(mockSocket)

      chatOps.insert('group@g.us', 'group')
      const chat = chatOps.getByWhatsappJid('group@g.us') as any
      fetcher.queueGroups([{ chatId: chat.id, jid: 'group@g.us' }])

      fetcher.start()
      await vi.advanceTimersByTimeAsync(100)

      expect(fetcher.getRemainingCount()).toBe(0) // Skipped
      expect(fetcher.getStatus().fetchedCount).toBe(1) // Counted as processed
      fetcher.stop()
    })

    it('generic error retries up to 3 times then skips', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = {
        groupMetadata: vi.fn().mockRejectedValue(new Error('network error'))
      }
      fetcher.setSocket(mockSocket)

      chatOps.insert('group@g.us', 'group')
      const chat = chatOps.getByWhatsappJid('group@g.us') as any
      fetcher.queueGroups([{ chatId: chat.id, jid: 'group@g.us' }])

      fetcher.start()
      // Advance through retries with backoff
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(4000)
      await vi.advanceTimersByTimeAsync(8000)

      expect(mockSocket.groupMetadata).toHaveBeenCalledTimes(3)
      expect(fetcher.getRemainingCount()).toBe(0) // Eventually skipped
      fetcher.stop()
    })
  })

  describe('handleGroupUpdate()', () => {
    it('fetches and caches metadata for updated groups', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = createMockSocket({
        id: 'updated-group@g.us',
        participants: [{ id: '3333@s.whatsapp.net', notify: 'Charlie' }]
      })
      fetcher.setSocket(mockSocket)

      await fetcher.handleGroupUpdate([{ id: 'updated-group@g.us' }])

      expect(mockSocket.groupMetadata).toHaveBeenCalledWith('updated-group@g.us')
      expect(fetcher.getCachedMetadata('updated-group@g.us')).toBeDefined()
    })

    it('skips events without id', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = createMockSocket()
      fetcher.setSocket(mockSocket)

      await fetcher.handleGroupUpdate([{}, { subject: 'no id' }])

      expect(mockSocket.groupMetadata).not.toHaveBeenCalled()
    })

    it('handles fetch errors gracefully', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = {
        groupMetadata: vi.fn().mockRejectedValue(new Error('fetch failed'))
      }
      fetcher.setSocket(mockSocket)

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await fetcher.handleGroupUpdate([{ id: 'error-group@g.us' }])
      consoleSpy.mockRestore()

      expect(fetcher.getCachedMetadata('error-group@g.us')).toBeUndefined()
    })
  })

  describe('handleParticipantsUpdate()', () => {
    it('fetches and caches participant metadata', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = createMockSocket({
        id: 'participant-group@g.us',
        participants: [{ id: '4444@s.whatsapp.net', notify: 'Dave', phoneNumber: '+4444' }]
      })
      fetcher.setSocket(mockSocket)

      await fetcher.handleParticipantsUpdate({ id: 'participant-group@g.us' })

      expect(mockSocket.groupMetadata).toHaveBeenCalledWith('participant-group@g.us')
      expect(fetcher.getCachedMetadata('participant-group@g.us')).toBeDefined()
    })

    it('stores contacts from participants', async () => {
      const fetcher = new GroupMetadataFetcher()
      const mockSocket = createMockSocket({
        id: 'contacts-group@g.us',
        participants: [{ id: '5555@s.whatsapp.net', notify: 'Eve', phoneNumber: '+5555' }]
      })
      fetcher.setSocket(mockSocket)

      await fetcher.handleParticipantsUpdate({ id: 'contacts-group@g.us' })

      const eve = contactOps.getByJid('5555@s.whatsapp.net') as any
      expect(eve).toBeDefined()
      expect(eve.name).toBe('Eve')
    })
  })
})

describe('Global singleton', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('getGroupMetadataFetcher() throws before init', async () => {
    const { getGroupMetadataFetcher: getFetcher } = await import('./group-metadata-fetcher')
    expect(() => getFetcher()).toThrow('GroupMetadataFetcher not initialized')
  })

  it('initializeGroupMetadataFetcher() creates singleton', async () => {
    const { initializeGroupMetadataFetcher: initFetcher, getGroupMetadataFetcher: getFetcher } = await import('./group-metadata-fetcher')
    const fetcher1 = initFetcher()
    const fetcher2 = initFetcher()
    expect(fetcher1).toBe(fetcher2)
    expect(getFetcher()).toBe(fetcher1)
  })
})
