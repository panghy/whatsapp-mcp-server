import { chatOps, contactOps, logOps } from './database'
import { extractPhoneFromJid, normalizePhoneNumber } from './message-transformer'

export interface GroupMetadataFetcherStatus {
  isRunning: boolean
  totalGroups: number
  fetchedCount: number
  currentGroup: string | null
  lastError: string | null
  nextRetryTime: number | null
}

export class GroupMetadataFetcher {
  private socket: any = null
  private isRunning = false
  private pendingGroups: Array<{ chatId: number; jid: string }> = []
  private fetchedCount = 0
  private currentGroup: string | null = null
  private lastError: string | null = null
  private nextRetryTime: number | null = null
  private currentBackoffMs = 1000
  private minBackoffMs = 1000
  private maxBackoffMs = 60000
  private fetchTimeout: NodeJS.Timeout | null = null
  private groupCache: Map<string, any> = new Map()
  private retryCount: Map<string, number> = new Map()
  private maxRetries = 3

  constructor(private slug: string) {}

  getSlug(): string { return this.slug }

  setSocket(socket: any) { this.socket = socket }

  getCachedMetadata(jid: string): any | undefined { return this.groupCache.get(jid) }

  queueGroups(groups: Array<{ chatId: number; jid: string }>) {
    for (const group of groups) {
      if (!this.pendingGroups.find(g => g.jid === group.jid)) {
        this.pendingGroups.push(group)
      }
    }
    console.log(`[GroupMetadata:${this.slug}] Queued ${groups.length} groups, total pending: ${this.pendingGroups.length}`)
  }

  start() {
    if (this.isRunning) return
    if (!this.socket) { console.error(`[GroupMetadata:${this.slug}] Cannot start: no socket set`); return }
    this.isRunning = true
    this.fetchedCount = 0
    console.log(`[GroupMetadata:${this.slug}] Starting fetch for ${this.pendingGroups.length} groups`)
    logOps.insert(this.slug, 'info', 'group-metadata', `Starting metadata fetch for ${this.pendingGroups.length} groups`)
    this.processNextGroup()
  }

  stop() {
    this.isRunning = false
    if (this.fetchTimeout) { clearTimeout(this.fetchTimeout); this.fetchTimeout = null }
    console.log(`[GroupMetadata:${this.slug}] Stopped`)
  }

  getStatus(): GroupMetadataFetcherStatus {
    return { isRunning: this.isRunning, totalGroups: this.pendingGroups.length + this.fetchedCount, fetchedCount: this.fetchedCount, currentGroup: this.currentGroup, lastError: this.lastError, nextRetryTime: this.nextRetryTime }
  }

  getRemainingCount(): number { return this.pendingGroups.length }

  private async processNextGroup() {
    if (!this.isRunning || this.pendingGroups.length === 0) {
      if (this.isRunning) {
        console.log(`[GroupMetadata:${this.slug}] All groups fetched! (${this.fetchedCount} total)`)
        logOps.insert(this.slug, 'info', 'group-metadata', `Completed fetching metadata for ${this.fetchedCount} groups`)
        this.isRunning = false
      }
      return
    }

    const group = this.pendingGroups[0]
    this.currentGroup = group.jid

    try {
      console.log(`[GroupMetadata:${this.slug}] Fetching ${group.jid} (${this.pendingGroups.length} remaining)`)
      const metadata = await this.socket.groupMetadata(group.jid)
      this.groupCache.set(group.jid, metadata)

      if (metadata.participants && Array.isArray(metadata.participants)) {
        let namesFound = 0
        for (const participant of metadata.participants) {
          const jid = participant.id
          const lid = participant.lid || undefined
          const phoneNumber = participant.phoneNumber
            ? normalizePhoneNumber(participant.phoneNumber) ?? undefined
            : extractPhoneFromJid(jid) ?? undefined
          const name = participant.notify || participant.name || undefined
          if (name) namesFound++
          if (jid && (name || phoneNumber || lid)) {
            contactOps.insert(this.slug, jid, name, phoneNumber, lid)
            if (lid && phoneNumber) { contactOps.insert(this.slug, lid, name, phoneNumber) }
          }
        }
        console.log(`[GroupMetadata:${this.slug}] Stored ${metadata.participants.length} participants (${namesFound} with names) for ${group.jid}`)
        const crossResolved = contactOps.crossResolveLidNames(this.slug)
        if (crossResolved.changes > 0) { console.log(`[GroupMetadata:${this.slug}] Cross-resolved ${crossResolved.changes} LID contact names`) }
        const crossResolvedDm = contactOps.crossResolveDmNames(this.slug)
        if (crossResolvedDm.changes > 0) { console.log(`[GroupMetadata:${this.slug}] Cross-resolved ${crossResolvedDm.changes} DM contact names`) }
        const chatBackfill = chatOps.backfillDmNames(this.slug)
        if (chatBackfill.changes > 0) { console.log(`[GroupMetadata:${this.slug}] Backfilled ${chatBackfill.changes} DM chat names`) }
      }

      chatOps.updateGroupMetadataFetched(this.slug, group.chatId, true)
      this.pendingGroups.shift()
      this.fetchedCount++
      this.lastError = null
      this.currentBackoffMs = this.minBackoffMs
      this.scheduleNextFetch(500)
    } catch (error: any) {
      const errorMsg = error?.message || String(error)
      this.lastError = errorMsg
      console.error(`[GroupMetadata:${this.slug}] Error fetching ${group.jid}: ${errorMsg}`)

      if (errorMsg.includes('rate-overlimit') || errorMsg.includes('429')) {
        this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs)
        console.log(`[GroupMetadata:${this.slug}] Rate limited, backing off for ${this.currentBackoffMs / 1000}s`)
      } else if (errorMsg.toLowerCase().includes('forbidden') || errorMsg.toLowerCase().includes('item-not-found')) {
        console.log(`[GroupMetadata:${this.slug}] Skipping ${group.jid}: ${errorMsg}`)
        this.pendingGroups.shift()
        this.fetchedCount++
        this.retryCount.delete(group.jid)
        chatOps.updateGroupMetadataFetched(this.slug, group.chatId, true)
      } else {
        const currentRetries = (this.retryCount.get(group.jid) || 0) + 1
        this.retryCount.set(group.jid, currentRetries)
        if (currentRetries >= this.maxRetries) {
          console.log(`[GroupMetadata:${this.slug}] Skipping ${group.jid} after ${currentRetries} failed attempts`)
          this.pendingGroups.shift()
          this.fetchedCount++
          this.retryCount.delete(group.jid)
          chatOps.updateGroupMetadataFetched(this.slug, group.chatId, true)
        } else {
          this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs)
        }
      }
      this.scheduleNextFetch(this.currentBackoffMs)
    }
  }

  private scheduleNextFetch(delayMs: number) {
    if (!this.isRunning) return
    this.nextRetryTime = Date.now() + delayMs
    this.fetchTimeout = setTimeout(() => { this.nextRetryTime = null; this.processNextGroup() }, delayMs)
  }

  async handleGroupUpdate(events: any[]) {
    if (!this.socket) return
    for (const event of events) {
      if (!event.id) continue
      try {
        const metadata = await this.socket.groupMetadata(event.id)
        this.groupCache.set(event.id, metadata)
        if (metadata.participants && Array.isArray(metadata.participants)) {
          for (const participant of metadata.participants) {
            const jid = participant.id
            const lid = participant.lid || undefined
            const phoneNumber = participant.phoneNumber
              ? normalizePhoneNumber(participant.phoneNumber) ?? undefined
              : extractPhoneFromJid(jid) ?? undefined
            const name = participant.notify || participant.name || undefined
            if (jid && (name || phoneNumber || lid)) {
              contactOps.insert(this.slug, jid, name, phoneNumber, lid)
              if (lid && phoneNumber) { contactOps.insert(this.slug, lid, name, phoneNumber) }
            }
          }
          contactOps.crossResolveLidNames(this.slug)
          contactOps.crossResolveDmNames(this.slug)
          chatOps.backfillDmNames(this.slug)
        }
        console.log(`[GroupMetadata:${this.slug}] Updated cache for ${event.id}`)
      } catch (error) {
        console.error(`[GroupMetadata:${this.slug}] Failed to update cache for ${event.id}:`, error)
      }
    }
  }

  async handleParticipantsUpdate(event: any) {
    if (!this.socket || !event.id) return
    try {
      const metadata = await this.socket.groupMetadata(event.id)
      this.groupCache.set(event.id, metadata)
      if (metadata.participants && Array.isArray(metadata.participants)) {
        for (const participant of metadata.participants) {
          const jid = participant.id
          const lid = participant.lid || undefined
          const phoneNumber = participant.phoneNumber
            ? normalizePhoneNumber(participant.phoneNumber) ?? undefined
            : extractPhoneFromJid(jid) ?? undefined
          const name = participant.notify || participant.name || undefined
          if (jid && (name || phoneNumber || lid)) {
            contactOps.insert(this.slug, jid, name, phoneNumber, lid)
            if (lid && phoneNumber) { contactOps.insert(this.slug, lid, name, phoneNumber) }
          }
        }
        contactOps.crossResolveLidNames(this.slug)
        contactOps.crossResolveDmNames(this.slug)
        chatOps.backfillDmNames(this.slug)
      }
      console.log(`[GroupMetadata:${this.slug}] Updated participants for ${event.id}`)
    } catch (error) {
      console.error(`[GroupMetadata:${this.slug}] Failed to update participants for ${event.id}:`, error)
    }
  }
}

// Per-slug registry.
const fetchers = new Map<string, GroupMetadataFetcher>()

export function initializeGroupMetadataFetcher(slug: string): GroupMetadataFetcher {
  let fetcher = fetchers.get(slug)
  if (!fetcher) {
    fetcher = new GroupMetadataFetcher(slug)
    fetchers.set(slug, fetcher)
  }
  return fetcher
}

export function getGroupMetadataFetcher(slug: string): GroupMetadataFetcher {
  const fetcher = fetchers.get(slug)
  if (!fetcher) {
    throw new Error(
      `GroupMetadataFetcher not initialized for slug "${slug}". Call initializeGroupMetadataFetcher("${slug}") first.`
    )
  }
  return fetcher
}

export function resetGroupMetadataFetchers(): void {
  fetchers.clear()
}

