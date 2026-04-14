import { useState, useEffect } from 'react'
import Settings from './Settings'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'
type ViewType = 'hero' | 'loading' | 'sync-status' | 'settings'

interface WhatsAppStatus {
  state: ConnectionState
  qrCode: string | null
  error: string | null
  hasAuth?: boolean
}

interface SyncStatus {
  isSyncing: boolean
  totalChats: number
  completedChats: number
  currentChat: string | null
  messageCount: number
  lastError: string | null
}

interface ActivityStatus {
  lastActivityTime: number | null
  totalMessagesStored: number
}

declare global {
  interface Window {
    electron: {
      getAutoLaunch: () => Promise<boolean>
      setAutoLaunch: (enabled: boolean) => Promise<boolean>
      getUserDisplayName: () => Promise<string>
      setUserDisplayName: (name: string) => Promise<boolean>
      whatsappConnect: () => Promise<WhatsAppStatus>
      whatsappGetStatus: () => Promise<WhatsAppStatus>
      whatsappDisconnect: () => Promise<boolean>
      whatsappClearSession: () => Promise<boolean>
      getGroups: () => Promise<any[]>
      setGroupEnabled: (groupId: number, enabled: boolean) => Promise<boolean>
      getMinimizeToTray: () => Promise<boolean>
      setMinimizeToTray: (enabled: boolean) => Promise<boolean>
      relinkWhatsApp: () => Promise<boolean>
      logoff: () => Promise<boolean>
      getSyncStatus: () => Promise<SyncStatus>
      getActivityStatus: () => Promise<ActivityStatus>
      getLogs: (options: any) => Promise<any[]>
      clearLogs: () => Promise<boolean>
      exportLogs: (format: string) => Promise<boolean>
    }
  }
}

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return 'Never'
  const now = Date.now()
  const diffMs = now - timestamp
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  if (diffSecs < 5) return 'just now'
  if (diffSecs < 60) return `${diffSecs} seconds ago`
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`
}

export default function App() {
  const [currentView, setCurrentView] = useState<ViewType>('hero')
  const [loading, setLoading] = useState(true)
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppStatus>({ state: 'disconnected', qrCode: null, error: null })
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ isSyncing: false, totalChats: 0, completedChats: 0, currentChat: null, messageCount: 0, lastError: null })
  const [activityStatus, setActivityStatus] = useState<ActivityStatus>({ lastActivityTime: null, totalMessagesStored: 0 })
  const [connecting, setConnecting] = useState(false)
  const [isAutoReconnecting, setIsAutoReconnecting] = useState(false)
  const [userName, setUserName] = useState('')
  const [nameConfirmed, setNameConfirmed] = useState(false)

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const whatsappSt = await window.electron.whatsappGetStatus()
        setWhatsappStatus(whatsappSt)
        if (whatsappSt.state === 'connected') { setCurrentView('sync-status') }
        else if (whatsappSt.state === 'connecting') { setIsAutoReconnecting(true); setCurrentView('loading') }
        else { setCurrentView('hero') }
        const syncSt = await window.electron.getSyncStatus()
        setSyncStatus(syncSt)
        const activitySt = await window.electron.getActivityStatus()
        setActivityStatus(activitySt)
        const savedName = await window.electron.getUserDisplayName()
        if (savedName && whatsappSt.hasAuth) { setUserName(savedName); setNameConfirmed(true) }
      } catch (error) { console.error('Failed to load status:', error) }
      finally { setLoading(false) }
    }
    loadStatus()
  }, [])

  useEffect(() => {
    const pollInterval = setInterval(async () => {
      try {
        const whatsappSt = await window.electron.whatsappGetStatus()
        setWhatsappStatus(whatsappSt)
        if (whatsappSt.qrCode) setConnecting(false)
        if (whatsappSt.state === 'connected') { setConnecting(false); setIsAutoReconnecting(false); if (currentView !== 'settings') setCurrentView('sync-status') }
        else if (whatsappSt.state === 'connecting' && isAutoReconnecting && currentView !== 'settings') { setCurrentView('loading') }
        else if (whatsappSt.state !== 'connected' && currentView === 'sync-status') { setCurrentView('hero') }
        else if (whatsappSt.state === 'disconnected' && currentView === 'loading') { setIsAutoReconnecting(false); setCurrentView('hero') }
        const syncSt = await window.electron.getSyncStatus(); setSyncStatus(syncSt)
        const activitySt = await window.electron.getActivityStatus(); setActivityStatus(activitySt)
      } catch (error) { console.error('Failed to poll status:', error) }
    }, 2000)
    return () => clearInterval(pollInterval)
  }, [currentView, isAutoReconnecting])

  useEffect(() => {
    const handleOpenSettings = () => { setCurrentView('settings') }
    const ipcRenderer = (window as any).ipcRenderer
    if (ipcRenderer) {
      ipcRenderer.on('open-settings', handleOpenSettings)
      return () => { ipcRenderer.removeListener('open-settings', handleOpenSettings) }
    }
    return undefined
  }, [])

  const handleConnect = async () => {
    setConnecting(true)
    setNameConfirmed(true)
    try {
      await window.electron.setUserDisplayName(userName.trim())
      const status = await window.electron.whatsappConnect()
      setWhatsappStatus(status)
    } catch (error) {
      console.error('Failed to connect WhatsApp:', error)
      setConnecting(false)
      setWhatsappStatus(prev => ({ ...prev, state: 'error', error: error instanceof Error ? error.message : 'Unknown error' }))
    }
  }

  if (loading) {
    return (<div className="hero-layout"><div className="hero-content"><h1 className="hero-title">WhatsApp Bridge</h1><p className="hero-subtitle">Loading...</p></div></div>)
  }

  if (currentView === 'loading') {
    return (
      <div className="hero-layout"><div className="hero-content">
        <h1 className="hero-title">WhatsApp Bridge</h1><p className="hero-subtitle">Reconnecting to WhatsApp...</p>
        <div className="loading-spinner" />
        <p className="hero-status" style={{ fontSize: '0.875rem', color: 'hsl(var(--muted-foreground))' }}>Restoring your session</p>
        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid hsl(var(--border) / 0.3)' }}>
          <button className="btn-secondary" onClick={async () => { setIsAutoReconnecting(false); await window.electron.relinkWhatsApp(); setNameConfirmed(false); setUserName(''); setCurrentView('hero') }}>Re-link Device</button>
          <button className="btn-destructive" onClick={async () => { if (window.confirm('Are you sure you want to log off?')) { setIsAutoReconnecting(false); await window.electron.logoff(); setWhatsappStatus({ state: 'disconnected', qrCode: null, error: null }); setNameConfirmed(false); setUserName(''); setCurrentView('hero') } }}>Log Off</button>
        </div>
      </div></div>
    )
  }

  if (currentView === 'hero') {
    if (nameConfirmed && connecting && !whatsappStatus.qrCode) {
      return (<div className="hero-layout"><div className="hero-content"><h1 className="hero-title">WhatsApp Bridge</h1><p className="hero-subtitle">Connecting to WhatsApp...</p><div className="loading-spinner" /><p className="hero-status" style={{ fontSize: '0.875rem', color: 'hsl(var(--muted-foreground))' }}>Waiting for QR code</p></div></div>)
    }
    return (
      <div className="hero-layout"><div className="hero-content">
        <h1 className="hero-title">WhatsApp Bridge</h1><p className="hero-subtitle">Connect your WhatsApp account to get started</p>
        {nameConfirmed && whatsappStatus.qrCode && (<div className="qr-display"><img src={whatsappStatus.qrCode} alt="WhatsApp QR Code" /><p className="hero-status">Scan with WhatsApp to connect</p></div>)}
        {!nameConfirmed && (<>
          <div style={{ marginBottom: '1rem', width: '100%', maxWidth: '300px' }}>
            <label htmlFor="userName" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'hsl(var(--muted-foreground))' }}>Your full name</label>
            <input id="userName" type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Enter your name" style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--input))', color: 'hsl(var(--foreground))', fontSize: '1rem' }} disabled={connecting} />
          </div>
          <button onClick={handleConnect} disabled={connecting || !userName.trim()}>{connecting ? 'Connecting...' : 'Connect WhatsApp'}</button>
        </>)}
        {nameConfirmed && !whatsappStatus.qrCode && !connecting && (<button onClick={handleConnect}>Connect WhatsApp</button>)}
        {whatsappStatus.error && (<p style={{ color: 'hsl(var(--destructive))', marginTop: '1rem' }}>{whatsappStatus.error}</p>)}
      </div></div>
    )
  }

  if (currentView === 'sync-status') {
    return (
      <div className="hero-layout"><div className="hero-content">
        <h1 className="hero-title">Syncing Messages</h1>
        <p className="hero-subtitle">{syncStatus.isSyncing ? `Syncing ${syncStatus.completedChats} of ${syncStatus.totalChats} chats` : 'All messages synced'}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem', color: 'hsl(var(--foreground))' }}>
          <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: syncStatus.isSyncing ? 'hsl(var(--warning))' : 'hsl(var(--success))' }} />
          {syncStatus.isSyncing ? 'Syncing...' : 'Connected'}
        </div>
        <div className="activity-stats">
          <div className="activity-stat-row"><span className="activity-stat-label">Last activity:</span><span className="activity-stat-value">{formatRelativeTime(activityStatus.lastActivityTime)}</span></div>
          <div className="activity-stat-row"><span className="activity-stat-label">Messages stored:</span><span className="activity-stat-value">{activityStatus.totalMessagesStored.toLocaleString()}</span></div>
        </div>
        <button onClick={() => setCurrentView('settings')} style={{ marginTop: '2rem' }}>Settings</button>
      </div></div>
    )
  }

  if (currentView === 'settings') {
    return (
      <Settings
        onBack={() => { whatsappStatus.state === 'connected' ? setCurrentView('sync-status') : whatsappStatus.state === 'connecting' ? setCurrentView('loading') : setCurrentView('hero') }}
        onLogoff={() => { setNameConfirmed(false); setUserName(''); setWhatsappStatus({ state: 'disconnected', qrCode: null, error: null }); setCurrentView('hero') }}
      />
    )
  }
  return null
}
