import { chatOps, contactOps, messageOps, logOps } from './database'
import { MessageTransformer } from './message-transformer'

export interface SyncStatus {
  isSyncing: boolean
  totalChats: number
  completedChats: number
  currentChat: string | null
  messageCount: number
  lastError: string | null
}

export class SyncOrchestrator {
  private status: SyncStatus = {
    isSyncing: false,
    totalChats: 0,
    completedChats: 0,
    currentChat: null,
    messageCount: 0,
    lastError: null
  }

  private messageBuffer: Map<number, any[]> = new Map()
  private messageTransformer: MessageTransformer | null = null
  private isSyncInProgress = false

  constructor(private socket: any) {}

  setMessageTransformer(transformer: MessageTransformer) {
    this.messageTransformer = transformer
  }

  async startInitialSync(): Promise<void> {
    if (this.isSyncInProgress) {
      logOps.insert('warn', 'sync', 'Sync already in progress')
      return
    }

    this.isSyncInProgress = true
    this.status.isSyncing = true
    this.status.completedChats = 0
    this.status.messageCount = 0

    try {
      const chats = await this.fetchChatList()
      this.status.totalChats = chats.length
      logOps.insert('info', 'sync', `Starting initial sync for ${chats.length} chats`)

      for (const chat of chats) {
        try {
          await this.syncChat(chat)
          this.status.completedChats++
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          logOps.insert('error', 'sync', `Failed to sync chat ${chat.id}: ${msg}`)
        }
      }

      await this.flushMessageBuffer()
      logOps.insert('info', 'sync', 'Initial sync complete, triggering queue processor')

      this.status.isSyncing = false
      logOps.insert('info', 'sync', `Sync completed: ${this.status.completedChats}/${this.status.totalChats} chats, ${this.status.messageCount} messages`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.status.lastError = msg
      this.status.isSyncing = false
      logOps.insert('error', 'sync', `Initial sync failed: ${msg}`)
    } finally {
      this.isSyncInProgress = false
    }
  }

  private async fetchChatList(): Promise<any[]> {
    try {
      const allChats = chatOps.getAll() as any[]
      return allChats.filter((chat: any) => {
        const isDm = !chat.whatsapp_jid.includes('@g.us')
        return isDm && chat.enabled
      }).map((chat: any) => ({ ...chat, id: chat.whatsapp_jid }))
    } catch (error) {
      logOps.insert('error', 'sync', `Failed to fetch chat list: ${String(error)}`)
      return []
    }
  }

  private async syncChat(chat: any): Promise<void> {
    const jid = chat.id
    this.status.currentChat = jid

    try {
      let dbChat = chatOps.getByWhatsappJid(jid) as any
      
      if (!dbChat) {
        const chatType = jid.includes('@g.us') ? 'group' : 'dm'
        const enabled = chatType === 'dm' ? 1 : 0
        let chatName: string | undefined = undefined
        if (chatType === 'dm') {
          const contact = contactOps.getByJid(jid) as any
          if (contact?.name) { chatName = contact.name }
        }
        const result = chatOps.insert(jid, chatType, undefined, chatName)
        dbChat = { id: (result as any).lastInsertRowid, whatsapp_jid: jid, chat_type: chatType, enabled, last_pushed_message_id: 0, name: chatName }
      }

      if (!dbChat.enabled) {
        logOps.insert('info', 'sync', `Skipping disabled chat ${jid}`)
        return
      }

      const messages = await this.fetchMessageHistory(jid)
      if (messages.length === 0) {
        logOps.insert('info', 'sync', `No messages to sync for chat ${jid}`)
        return
      }

      for (const msg of messages) {
        if (this.messageTransformer) {
          await this.messageTransformer.processMessage(msg, dbChat.id)
          this.status.messageCount++
        }
      }

      logOps.insert('info', 'sync', `Synced ${messages.length} messages for chat ${jid}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logOps.insert('error', 'sync', `Error syncing chat ${jid}: ${msg}`)
      throw error
    }
  }

  private async fetchMessageHistory(jid: string): Promise<any[]> {
    try {
      logOps.insert('info', 'sync', `Message history for ${jid} will be populated via events`)
      return []
    } catch (error) {
      logOps.insert('error', 'sync', `Failed to fetch history for ${jid}: ${String(error)}`)
      return []
    }
  }

  bufferMessage(msg: any, chatId: number): void {
    if (!this.status.isSyncing) return
    if (!this.messageBuffer.has(chatId)) { this.messageBuffer.set(chatId, []) }
    this.messageBuffer.get(chatId)!.push(msg)
  }

  private async flushMessageBuffer(): Promise<void> {
    try {
      for (const [chatId, messages] of this.messageBuffer.entries()) {
        for (const msg of messages) {
          if (this.messageTransformer) {
            await this.messageTransformer.processMessage(msg, chatId)
            this.status.messageCount++
          }
        }
      }
      this.messageBuffer.clear()
      logOps.insert('info', 'sync', 'Message buffer flushed')
    } catch (error) {
      logOps.insert('error', 'sync', `Failed to flush message buffer: ${String(error)}`)
    }
  }

  async syncEnabledGroup(chatId: number): Promise<void> {
    try {
      const chat = chatOps.getById(chatId) as any
      if (!chat) { throw new Error(`Chat ${chatId} not found`) }
      logOps.insert('info', 'sync', `Syncing newly enabled group ${chat.whatsapp_jid}`)
      await this.syncChat({ id: chat.whatsapp_jid })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logOps.insert('error', 'sync', `Failed to sync enabled group: ${msg}`)
      throw error
    }
  }

  markSyncInProgress(): void {
    this.status.isSyncing = true
    this.isSyncInProgress = true
  }

  markSyncComplete(): void {
    this.status.isSyncing = false
    this.isSyncInProgress = false
  }

  getStatus(): SyncStatus {
    return { ...this.status }
  }
}

// Global instance
let syncOrchestrator: SyncOrchestrator | null = null

export function initializeSyncOrchestrator(socket: any): SyncOrchestrator {
  if (!syncOrchestrator) { syncOrchestrator = new SyncOrchestrator(socket) }
  return syncOrchestrator
}

export function getSyncOrchestrator(): SyncOrchestrator {
  if (!syncOrchestrator) { throw new Error('Sync orchestrator not initialized. Call initializeSyncOrchestrator() first.') }
  return syncOrchestrator
}

