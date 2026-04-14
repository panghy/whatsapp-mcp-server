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

  setSocket(socket: any) { this.socket = socket }

  getCachedMetadata(jid: string): any | undefined { return this.groupCache.get(jid) }

  queueGroups(groups: Array<{ chatId: number; jid: string }>) {
    for (const group of groups) {
      if (!this.pendingGroups.find(g => g.jid === group.jid)) {
        this.pendingGroups.push(group)
      }
    }
    console.log(`[GroupMetadata] Queued ${groups.length} groups, total pending: ${this.pendingGroups.length}`)
  }

  start() {
    if (this.isRunning) return
    if (!this.socket) { console.error('[GroupMetadata] Cannot start: no socket set'); return }
    this.isRunning = true
    this.fetchedCount = 0
    console.log(`[GroupMetadata] Starting fetch for ${this.pendingGroups.length} groups`)
    logOps.insert('info', 'group-metadata', `Starting metadata fetch for ${this.pendingGroups.length} groups`)
    this.processNextGroup()
  }

  stop() {
    this.isRunning = false
    if (this.fetchTimeout) { clearTimeout(this.fetchTimeout); this.fetchTimeout = null }
    console.log('[GroupMetadata] Stopped')
  }

  getStatus(): GroupMetadataFetcherStatus {
    return { isRunning: this.isRunning, totalGroups: this.pendingGroups.length + this.fetchedCount, fetchedCount: this.fetchedCount, currentGroup: this.currentGroup, lastError: this.lastError, nextRetryTime: this.nextRetryTime }
  }

  getRemainingCount(): number { return this.pendingGroups.length }

  private async processNextGroup() {
    if (!this.isRunning || this.pendingGroups.length === 0) {
      if (this.isRunning) {
        console.log(`[GroupMetadata] All groups fetched! (${this.fetchedCount} total)`)
        logOps.insert('info', 'group-metadata', `Completed fetching metadata for ${this.fetchedCount} groups`)
        this.isRunning = false
      }
      return
    }

    const group = this.pendingGroups[0]
    this.currentGroup = group.jid

    try {
      console.log(`[GroupMetadata] Fetching ${group.jid} (${this.pendingGroups.length} remaining)`)
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
            contactOps.insert(jid, name, phoneNumber, lid)
            if (lid && phoneNumber) { contactOps.insert(lid, name, phoneNumber) }
          }
        }
        console.log(`[GroupMetadata] Stored ${metadata.participants.length} participants (${namesFound} with names) for ${group.jid}`)
        const crossResolved = contactOps.crossResolveLidNames()
        if (crossResolved.changes > 0) { console.log(`[GroupMetadata] Cross-resolved ${crossResolved.changes} LID contact names`) }
        const crossResolvedDm = contactOps.crossResolveDmNames()
        if (crossResolvedDm.changes > 0) { console.log(`[GroupMetadata] Cross-resolved ${crossResolvedDm.changes} DM contact names`) }
        const chatBackfill = chatOps.backfillDmNames()
        if (chatBackfill.changes > 0) { console.log(`[GroupMetadata] Backfilled ${chatBackfill.changes} DM chat names`) }
      }

      chatOps.updateGroupMetadataFetched(group.chatId, true)
      this.pendingGroups.shift()
      this.fetchedCount++
      this.lastError = null
      this.currentBackoffMs = this.minBackoffMs
      this.scheduleNextFetch(500)
    } catch (error: any) {
      const errorMsg = error?.message || String(error)
      this.lastError = errorMsg
      console.error(`[GroupMetadata] Error fetching ${group.jid}: ${errorMsg}`)
      
      if (errorMsg.includes('rate-overlimit') || errorMsg.includes('429')) {
        this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs)
        console.log(`[GroupMetadata] Rate limited, backing off for ${this.currentBackoffMs / 1000}s`)
      } else if (errorMsg.toLowerCase().includes('forbidden') || errorMsg.toLowerCase().includes('item-not-found')) {
        console.log(`[GroupMetadata] Skipping ${group.jid}: ${errorMsg}`)
        this.pendingGroups.shift()
        this.fetchedCount++
        this.retryCount.delete(group.jid)
        chatOps.updateGroupMetadataFetched(group.chatId, true)
      } else {
        const currentRetries = (this.retryCount.get(group.jid) || 0) + 1
        this.retryCount.set(group.jid, currentRetries)
        if (currentRetries >= this.maxRetries) {
          console.log(`[GroupMetadata] Skipping ${group.jid} after ${currentRetries} failed attempts`)
          this.pendingGroups.shift()
          this.fetchedCount++
          this.retryCount.delete(group.jid)
          chatOps.updateGroupMetadataFetched(group.chatId, true)
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
              contactOps.insert(jid, name, phoneNumber, lid)
              if (lid && phoneNumber) { contactOps.insert(lid, name, phoneNumber) }
            }
          }
          contactOps.crossResolveLidNames()
          contactOps.crossResolveDmNames()
          chatOps.backfillDmNames()
        }
        console.log(`[GroupMetadata] Updated cache for ${event.id}`)
      } catch (error) {
        console.error(`[GroupMetadata] Failed to update cache for ${event.id}:`, error)
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
            contactOps.insert(jid, name, phoneNumber, lid)
            if (lid && phoneNumber) { contactOps.insert(lid, name, phoneNumber) }
          }
        }
        contactOps.crossResolveLidNames()
        contactOps.crossResolveDmNames()
        chatOps.backfillDmNames()
      }
      console.log(`[GroupMetadata] Updated participants for ${event.id}`)
    } catch (error) {
      console.error(`[GroupMetadata] Failed to update participants for ${event.id}:`, error)
    }
  }
}

// Singleton instance
let groupMetadataFetcher: GroupMetadataFetcher | null = null

export function initializeGroupMetadataFetcher(): GroupMetadataFetcher {
  if (!groupMetadataFetcher) { groupMetadataFetcher = new GroupMetadataFetcher() }
  return groupMetadataFetcher
}

export function getGroupMetadataFetcher(): GroupMetadataFetcher {
  if (!groupMetadataFetcher) { throw new Error('GroupMetadataFetcher not initialized') }
  return groupMetadataFetcher
}

