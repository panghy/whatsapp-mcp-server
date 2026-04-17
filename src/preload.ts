import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  // App-level settings (no slug)
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke('set-auto-launch', enabled),
  getMinimizeToTray: () => ipcRenderer.invoke('get-minimize-to-tray'),
  setMinimizeToTray: (enabled: boolean) => ipcRenderer.invoke('set-minimize-to-tray', enabled),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onUpdateStatus: (callback: (status: any) => void) => {
    ipcRenderer.on('update-status', (_, status) => callback(status))
  },

  // Account registry
  accounts: {
    list: () => ipcRenderer.invoke('accounts-list'),
    add: (slug: string) => ipcRenderer.invoke('accounts-add', { slug }),
    remove: (slug: string) => ipcRenderer.invoke('accounts-remove', { slug }),
    rename: (oldSlug: string, newSlug: string) =>
      ipcRenderer.invoke('accounts-rename', { oldSlug, newSlug }),
    setDefault: (slug: string) => ipcRenderer.invoke('accounts-set-default', { slug }),
    getMcpUrls: (slug: string) => ipcRenderer.invoke('accounts-get-mcp-urls', { slug }),
  },

  // Per-account display name
  getUserDisplayName: (slug: string) =>
    ipcRenderer.invoke('get-user-display-name', { slug }),
  setUserDisplayName: (slug: string, name: string) =>
    ipcRenderer.invoke('set-user-display-name', { slug, name }),

  // Per-account WhatsApp connection
  whatsappConnect: (slug: string) => ipcRenderer.invoke('whatsapp-connect', { slug }),
  whatsappGetStatus: (slug: string) => ipcRenderer.invoke('whatsapp-status', { slug }),
  whatsappDisconnect: (slug: string) => ipcRenderer.invoke('whatsapp-disconnect', { slug }),
  whatsappLogout: (slug: string) => ipcRenderer.invoke('whatsapp-logout', { slug }),
  whatsappClearSession: (slug: string) => ipcRenderer.invoke('whatsapp-clear-session', { slug }),
  relinkWhatsApp: (slug: string) => ipcRenderer.invoke('relink-whatsapp', { slug }),

  // Per-account sync & activity
  getSyncStatus: (slug: string) => ipcRenderer.invoke('get-sync-status', { slug }),
  getGroupMetadataStatus: (slug: string) =>
    ipcRenderer.invoke('get-group-metadata-status', { slug }),
  getActivityStatus: (slug: string) => ipcRenderer.invoke('get-activity-status', { slug }),

  // Per-account chats / groups / messages / contacts
  getChats: (slug: string) => ipcRenderer.invoke('get-chats', { slug }),
  getGroups: (slug: string) => ipcRenderer.invoke('get-groups', { slug }),
  getChat: (slug: string, chatId: number) =>
    ipcRenderer.invoke('get-chat', { slug, chatId }),
  toggleChat: (slug: string, chatId: number, enabled: boolean) =>
    ipcRenderer.invoke('toggle-chat', { slug, chatId, enabled }),
  setGroupEnabled: (slug: string, groupId: number, enabled: boolean) =>
    ipcRenderer.invoke('set-group-enabled', { slug, groupId, enabled }),
  getMessages: (slug: string, chatId: number, limit?: number, offset?: number) =>
    ipcRenderer.invoke('get-messages', { slug, chatId, limit, offset }),
  getMessageCount: (slug: string, chatId: number) =>
    ipcRenderer.invoke('get-message-count', { slug, chatId }),
  getTotalMessageCount: (slug: string) =>
    ipcRenderer.invoke('get-total-message-count', { slug }),
  getContacts: (slug: string) => ipcRenderer.invoke('get-contacts', { slug }),
  sendMessage: (slug: string, jid: string, text: string) =>
    ipcRenderer.invoke('send-message', { slug, jid, text }),

  // Per-account logs
  getLogs: (
    slug: string,
    filters?: { levels?: string[]; categories?: string[]; searchText?: string; limit?: number }
  ) => ipcRenderer.invoke('get-logs', { slug, ...(filters || {}) }),
  clearLogs: (slug: string) => ipcRenderer.invoke('clear-logs', { slug }),
  exportLogs: (_slug: string, _format?: 'json' | 'text') => Promise.resolve(false),

  // MCP server (global)
  getMcpStatus: () => ipcRenderer.invoke('mcp-get-status'),
  getMcpPort: () => ipcRenderer.invoke('mcp-get-port'),
  setMcpPort: (port: number) => ipcRenderer.invoke('mcp-set-port', port),
  restartMcpServer: () => ipcRenderer.invoke('mcp-restart'),
  getMcpAutoStart: () => ipcRenderer.invoke('mcp-get-auto-start'),
  setMcpAutoStart: (enabled: boolean) => ipcRenderer.invoke('mcp-set-auto-start', enabled),
})

// Expose ipcRenderer for listening to events
contextBridge.exposeInMainWorld('ipcRenderer', {
  on: (channel: string, listener: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (_, ...args) => listener(...args))
  },
  removeListener: (channel: string, listener: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, listener)
  }
})

