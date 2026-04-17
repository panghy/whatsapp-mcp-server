// Shared renderer-side type definitions.

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WhatsAppStatus {
  state: ConnectionState
  qrCode: string | null
  error: string | null
  hasAuth?: boolean
}

export interface SyncStatus {
  isSyncing: boolean
  totalChats: number
  completedChats: number
  currentChat: string | null
  messageCount: number
  lastError: string | null
}

export interface ActivityStatus {
  lastActivityTime: number | null
  totalMessagesStored: number
}

export interface McpStatus {
  status: 'stopped' | 'starting' | 'running' | 'port_conflict' | 'error'
  port: number
  running: boolean
  error: string | null
}

export interface Account {
  slug: string
  mcpEnabled: boolean
  createdAt?: string
}

export interface McpUrlInfo {
  path: string
  alias?: string
}

export interface UpdateStatusData {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version: string | null
  error: string | null
  progress: number | null
}

export interface LogFilters {
  levels?: string[]
  categories?: string[]
  searchText?: string
  limit?: number
}

declare global {
  interface Window {
    electron: {
      // App-level settings
      getAutoLaunch: () => Promise<boolean>
      setAutoLaunch: (enabled: boolean) => Promise<boolean>
      getMinimizeToTray: () => Promise<boolean>
      setMinimizeToTray: (enabled: boolean) => Promise<boolean>
      getAppVersion: () => Promise<string>
      checkForUpdates: () => Promise<{ success: boolean; error?: string }>
      getUpdateStatus: () => Promise<UpdateStatusData>
      quitAndInstall: () => Promise<void>
      onUpdateStatus: (callback: (status: UpdateStatusData) => void) => void

      // Account registry
      accounts: {
        list: () => Promise<Account[]>
        add: (slug: string) => Promise<Account>
        remove: (slug: string) => Promise<{ success: boolean }>
        rename: (oldSlug: string, newSlug: string) => Promise<{ success: boolean }>
        setDefault: (slug: string) => Promise<{ success: boolean }>
        getMcpUrls: (slug: string) => Promise<McpUrlInfo>
      }

      // Per-account display name
      getUserDisplayName: (slug: string) => Promise<string>
      setUserDisplayName: (slug: string, name: string) => Promise<boolean>

      // Per-account WhatsApp lifecycle
      whatsappConnect: (slug: string) => Promise<WhatsAppStatus>
      whatsappGetStatus: (slug: string) => Promise<WhatsAppStatus>
      whatsappDisconnect: (slug: string) => Promise<{ success: boolean }>
      whatsappLogout: (slug: string) => Promise<{ success: boolean }>
      whatsappClearSession: (slug: string) => Promise<{ success: boolean }>
      relinkWhatsApp: (slug: string) => Promise<{ success: boolean }>

      // Per-account sync / activity
      getSyncStatus: (slug: string) => Promise<SyncStatus>
      getGroupMetadataStatus: (slug: string) => Promise<unknown>
      getActivityStatus: (slug: string) => Promise<ActivityStatus>

      // Per-account chats / groups / messages / contacts
      getChats: (slug: string) => Promise<unknown[]>
      getGroups: (slug: string) => Promise<Array<{ id: number; whatsapp_jid: string; chat_type: string; enabled: boolean; last_activity: string | null; name?: string }>>
      getChat: (slug: string, chatId: number) => Promise<unknown>
      toggleChat: (slug: string, chatId: number, enabled: boolean) => Promise<unknown>
      setGroupEnabled: (slug: string, groupId: number, enabled: boolean) => Promise<boolean>
      getMessages: (slug: string, chatId: number, limit?: number, offset?: number) => Promise<unknown[]>
      getMessageCount: (slug: string, chatId: number) => Promise<number>
      getTotalMessageCount: (slug: string) => Promise<number>
      getContacts: (slug: string) => Promise<unknown[]>
      sendMessage: (slug: string, jid: string, text: string) => Promise<unknown>

      // Per-account logs
      getLogs: (slug: string, filters?: LogFilters) => Promise<Array<{ id: number; timestamp: string; level: string; category: string; message: string; details_json: unknown }>>
      clearLogs: (slug: string) => Promise<{ success: boolean }>
      exportLogs: (slug: string, format?: 'json' | 'text') => Promise<boolean>

      // MCP server (global)
      getMcpStatus: () => Promise<McpStatus>
      getMcpPort: () => Promise<number>
      setMcpPort: (port: number) => Promise<{ success: boolean }>
      restartMcpServer: () => Promise<{ status: string; error: string | null }>
      getMcpAutoStart: () => Promise<boolean>
      setMcpAutoStart: (enabled: boolean) => Promise<{ success: boolean }>
    }
  }
}

