import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  // Settings
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke('set-auto-launch', enabled),
  getUserDisplayName: () => ipcRenderer.invoke('get-user-display-name'),
  setUserDisplayName: (name: string) => ipcRenderer.invoke('set-user-display-name', name),
  getMinimizeToTray: () => ipcRenderer.invoke('get-minimize-to-tray'),
  setMinimizeToTray: (enabled: boolean) => ipcRenderer.invoke('set-minimize-to-tray', enabled),
  // WhatsApp connection
  whatsappConnect: () => ipcRenderer.invoke('whatsapp-connect'),
  whatsappGetStatus: () => ipcRenderer.invoke('whatsapp-status'),
  whatsappDisconnect: () => ipcRenderer.invoke('whatsapp-disconnect'),
  whatsappClearSession: () => ipcRenderer.invoke('whatsapp-logout'),
  relinkWhatsApp: () => ipcRenderer.invoke('whatsapp-logout'),
  logoff: () => ipcRenderer.invoke('whatsapp-logout'),
  // Sync & Activity
  getSyncStatus: () => ipcRenderer.invoke('get-sync-status'),
  getActivityStatus: async () => {
    const messages = await ipcRenderer.invoke('get-total-message-count')
    return { lastActivityTime: Date.now(), totalMessagesStored: messages || 0 }
  },
  // Chats & Groups
  getGroups: () => ipcRenderer.invoke('get-chats'),
  setGroupEnabled: (groupId: number, enabled: boolean) => ipcRenderer.invoke('toggle-chat', groupId, enabled),
  // Logs
  getLogs: (filters?: { levels?: string[], categories?: string[], searchText?: string, limit?: number }) =>
    ipcRenderer.invoke('get-logs', filters || {}),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  exportLogs: (_format?: 'json' | 'text') => Promise.resolve(false), // not implemented yet
  // MCP Server
  getMcpStatus: () => ipcRenderer.invoke('mcp-get-status'),
  getMcpPort: () => ipcRenderer.invoke('mcp-get-port'),
  setMcpPort: (port: number) => ipcRenderer.invoke('mcp-set-port', port),
  restartMcpServer: () => ipcRenderer.invoke('mcp-restart'),
  getMcpAutoStart: () => ipcRenderer.invoke('mcp-get-auto-start'),
  setMcpAutoStart: (enabled: boolean) => ipcRenderer.invoke('mcp-set-auto-start', enabled)
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

