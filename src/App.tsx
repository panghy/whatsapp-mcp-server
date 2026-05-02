import { useState, useEffect, useCallback, useRef } from 'react'
import Settings from './Settings'
import AccountSwitcher, { AddAccountModal } from './AccountSwitcher'
import type {
  Account,
  ActivityStatus,
  ConnectionState,
  McpStatus,
  SyncStatus,
  WhatsAppStatus,
} from './types'

type ViewType = 'hero' | 'loading' | 'sync-status' | 'settings'
type SettingsTab = 'group-sync' | 'interface-system' | 'logs'

const SELECTED_SLUG_KEY = 'selectedAccountSlug'

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
  const [accounts, setAccounts] = useState<Account[]>([])
  const [defaultSlug, setDefaultSlug] = useState<string | null>(null)
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [statusByAccount, setStatusByAccount] = useState<Record<string, WhatsAppStatus>>({})
  const [showAddModal, setShowAddModal] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)

  const [currentView, setCurrentView] = useState<ViewType>('hero')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ isSyncing: false, totalChats: 0, completedChats: 0, currentChat: null, messageCount: 0, lastError: null })
  const [activityStatus, setActivityStatus] = useState<ActivityStatus>({ lastActivityTime: null, totalMessagesStored: 0 })
  const [connecting, setConnecting] = useState(false)
  const [isAutoReconnecting, setIsAutoReconnecting] = useState(false)
  const [userName, setUserName] = useState('')
  const [nameConfirmed, setNameConfirmed] = useState(false)
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null)
  const [pendingInitialTab, setPendingInitialTab] = useState<SettingsTab | null>(null)

  const accountsRef = useRef<Account[]>([])
  useEffect(() => { accountsRef.current = accounts }, [accounts])

  const refreshAccounts = useCallback(async (): Promise<Account[]> => {
    const { accounts: list, defaultSlug: nextDefault } = await window.electron.accounts.list()
    setAccounts(list)
    setDefaultSlug(nextDefault)
    return list
  }, [])

  // Bootstrap: load accounts, restore persisted slug, pick a fallback if needed.
  useEffect(() => {
    const init = async () => {
      try {
        const list = await refreshAccounts()
        if (list.length === 0) { setSelectedSlug(null); return }
        const persisted = localStorage.getItem(SELECTED_SLUG_KEY)
        const chosen = persisted && list.some((a) => a.slug === persisted) ? persisted : list[0].slug
        setSelectedSlug(chosen)
        localStorage.setItem(SELECTED_SLUG_KEY, chosen)
      } catch (err) { console.error('Failed to load accounts:', err) }
      finally { setInitialLoading(false) }
    }
    init()
  }, [refreshAccounts])

  // Reload per-account state whenever the selected slug changes.
  useEffect(() => {
    if (!selectedSlug) return undefined
    const slug = selectedSlug
    let cancelled = false
    // Reset view-local state so stale data from another slug never flashes.
    setConnecting(false); setIsAutoReconnecting(false)
    setUserName(''); setNameConfirmed(false)
    setSyncStatus({ isSyncing: false, totalChats: 0, completedChats: 0, currentChat: null, messageCount: 0, lastError: null })
    setActivityStatus({ lastActivityTime: null, totalMessagesStored: 0 })

    const load = async () => {
      try {
        const st = await window.electron.whatsappGetStatus(slug)
        if (cancelled) return
        setStatusByAccount((prev) => ({ ...prev, [slug]: st }))
        if (currentView !== 'settings') {
          if (st.state === 'connected') setCurrentView('sync-status')
          else if (st.state === 'connecting') { setIsAutoReconnecting(true); setCurrentView('loading') }
          else if (st.hasAuth) { setIsAutoReconnecting(true); setCurrentView('loading') }
          else setCurrentView('hero')
        }
        const [syncSt, activitySt, savedName, mcpSt] = await Promise.all([
          window.electron.getSyncStatus(slug),
          window.electron.getActivityStatus(slug),
          window.electron.getUserDisplayName(slug),
          window.electron.getMcpStatus(),
        ])
        if (cancelled) return
        setSyncStatus(syncSt); setActivityStatus(activitySt); setMcpStatus(mcpSt)
        if (savedName && st.hasAuth) { setUserName(savedName); setNameConfirmed(true) }
      } catch (err) { console.error('Failed to load per-account status:', err) }
    }
    load()
    return () => { cancelled = true }
  }, [selectedSlug])

  // Poll status for the selected account and refresh status dots for others.
  useEffect(() => {
    if (!selectedSlug) return undefined
    const slug = selectedSlug
    const id = setInterval(async () => {
      try {
        const [st, syncSt, activitySt, mcpSt, envelope] = await Promise.all([
          window.electron.whatsappGetStatus(slug),
          window.electron.getSyncStatus(slug),
          window.electron.getActivityStatus(slug),
          window.electron.getMcpStatus(),
          window.electron.accounts.list(),
        ])
        const list = envelope.accounts
        setStatusByAccount((prev) => ({ ...prev, [slug]: st }))
        setSyncStatus(syncSt); setActivityStatus(activitySt); setMcpStatus(mcpSt)
        setAccounts(list)
        setDefaultSlug(envelope.defaultSlug)
        // Refresh status dots for other accounts in the background.
        await Promise.all(list.filter((a) => a.slug !== slug).map(async (a) => {
          try {
            const other = await window.electron.whatsappGetStatus(a.slug)
            setStatusByAccount((prev) => ({ ...prev, [a.slug]: other }))
          } catch { /* ignore */ }
        }))
        if (st.qrCode) setConnecting(false)
        const state: ConnectionState = st.state
        if (state === 'connected') { setConnecting(false); setIsAutoReconnecting(false); if (currentView !== 'settings') setCurrentView('sync-status') }
        else if (state === 'connecting' && isAutoReconnecting && currentView !== 'settings') setCurrentView('loading')
        else if (state === 'disconnected' && currentView === 'sync-status') setCurrentView('hero')
        else if (state === 'disconnected' && currentView === 'loading') { setIsAutoReconnecting(false); setCurrentView('hero') }
      } catch (err) { console.error('Failed to poll status:', err) }
    }, 2000)
    return () => clearInterval(id)
  }, [selectedSlug, currentView, isAutoReconnecting])

  useEffect(() => {
    const handleOpenSettings = () => { setPendingInitialTab(null); setCurrentView('settings') }
    const handleOpenLogs = () => { setPendingInitialTab('logs'); setCurrentView('settings') }
    const ipcRenderer = (window as { ipcRenderer?: { on: (c: string, l: (...a: unknown[]) => void) => void; removeListener: (c: string, l: (...a: unknown[]) => void) => void } }).ipcRenderer
    if (ipcRenderer) {
      ipcRenderer.on('open-settings', handleOpenSettings)
      ipcRenderer.on('open-logs', handleOpenLogs)
      return () => {
        ipcRenderer.removeListener('open-settings', handleOpenSettings)
        ipcRenderer.removeListener('open-logs', handleOpenLogs)
      }
    }
    return undefined
  }, [])

  useEffect(() => {
    if (pendingInitialTab !== null) {
      const id = setTimeout(() => setPendingInitialTab(null), 0)
      return () => clearTimeout(id)
    }
    return undefined
  }, [pendingInitialTab])

  const handleSelectSlug = useCallback((slug: string) => {
    setSelectedSlug(slug)
    localStorage.setItem(SELECTED_SLUG_KEY, slug)
  }, [])

  useEffect(() => {
    const handleFocusAccount = (...args: unknown[]) => {
      const slug = args[0]
      if (typeof slug !== 'string') return
      const known = accountsRef.current.some((a) => a.slug === slug)
      if (known || accountsRef.current.length === 0) handleSelectSlug(slug)
    }
    const ipcRenderer = (window as { ipcRenderer?: { on: (c: string, l: (...a: unknown[]) => void) => void; removeListener: (c: string, l: (...a: unknown[]) => void) => void } }).ipcRenderer
    if (ipcRenderer) {
      ipcRenderer.on('focus-account', handleFocusAccount)
      return () => { ipcRenderer.removeListener('focus-account', handleFocusAccount) }
    }
    return undefined
  }, [handleSelectSlug])

  const handleAccountAdded = useCallback((account: Account) => {
    setShowAddModal(false)
    setAccounts((prev) => prev.some((a) => a.slug === account.slug) ? prev : [...prev, account])
    setSelectedSlug(account.slug)
    localStorage.setItem(SELECTED_SLUG_KEY, account.slug)
  }, [])

  const handleAccountsChanged = useCallback(async (nextSelected?: string) => {
    const list = await refreshAccounts()
    if (list.length === 0) { setSelectedSlug(null); localStorage.removeItem(SELECTED_SLUG_KEY); return }
    const target = nextSelected && list.some((a) => a.slug === nextSelected)
      ? nextSelected
      : (selectedSlug && list.some((a) => a.slug === selectedSlug) ? selectedSlug : list[0].slug)
    setSelectedSlug(target)
    localStorage.setItem(SELECTED_SLUG_KEY, target)
  }, [refreshAccounts, selectedSlug])

  const handleConnect = async () => {
    if (!selectedSlug) return
    const slug = selectedSlug
    setConnecting(true); setNameConfirmed(true)
    try {
      await window.electron.setUserDisplayName(slug, userName.trim())
      const status = await window.electron.whatsappConnect(slug)
      setStatusByAccount((prev) => ({ ...prev, [slug]: status }))
    } catch (error) {
      console.error('Failed to connect WhatsApp:', error)
      setConnecting(false)
      setStatusByAccount((prev) => ({ ...prev, [slug]: { ...(prev[slug] || { state: 'disconnected', qrCode: null, error: null }), state: 'error', error: error instanceof Error ? error.message : 'Unknown error' } }))
    }
  }

  const whatsappStatus: WhatsAppStatus = (selectedSlug && statusByAccount[selectedSlug]) || { state: 'disconnected', qrCode: null, error: null }

  if (initialLoading) {
    return (<div className="hero-layout"><div className="hero-content"><h1 className="hero-title">WhatsApp MCP Server</h1><p className="hero-subtitle">Loading...</p></div></div>)
  }

  if (accounts.length === 0 || !selectedSlug) {
    return (
      <div className="hero-layout"><div className="hero-content">
        <h1 className="hero-title">WhatsApp MCP Server</h1>
        <p className="hero-subtitle">Add your first account to get started.</p>
        <button onClick={() => setShowAddModal(true)}>+ Add account</button>
        {showAddModal && (
          <AddAccountModal existingSlugs={accounts.map((a) => a.slug)} onClose={() => setShowAddModal(false)} onAdded={handleAccountAdded} />
        )}
      </div></div>
    )
  }

  const switcher = (
    <AccountSwitcher
      accounts={accounts}
      selectedSlug={selectedSlug}
      defaultSlug={defaultSlug}
      statusByAccount={statusByAccount}
      onSelect={handleSelectSlug}
      onAdd={() => setShowAddModal(true)}
    />
  )
  const addModal = showAddModal ? (
    <AddAccountModal existingSlugs={accounts.map((a) => a.slug)} onClose={() => setShowAddModal(false)} onAdded={handleAccountAdded} />
  ) : null

  const slug = selectedSlug

  if (currentView === 'loading') {
    return (
      <div className="app-shell">
        {switcher}
        <div className="hero-layout"><div className="hero-content">
          <h1 className="hero-title">WhatsApp MCP Server</h1>
          <p className="hero-subtitle">Reconnecting <strong>{slug}</strong> to WhatsApp…</p>
          <div className="loading-spinner" />
          <p className="hero-status" style={{ fontSize: '0.875rem', color: 'hsl(var(--muted-foreground))' }}>Restoring your session</p>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid hsl(var(--border) / 0.3)' }}>
            <button className="btn-secondary" onClick={async () => { setIsAutoReconnecting(false); await window.electron.relinkWhatsApp(slug); setNameConfirmed(false); setUserName(''); setCurrentView('hero') }}>Re-link Device</button>
            <button className="btn-destructive" onClick={async () => { if (window.confirm(`Log out of "${slug}"? Your messages and settings are kept — the MCP endpoint will be disabled until you re-link.`)) { setIsAutoReconnecting(false); await window.electron.whatsappLogout(slug); setStatusByAccount((prev) => ({ ...prev, [slug]: { state: 'disconnected', qrCode: null, error: null } })); setNameConfirmed(false); setUserName(''); setCurrentView('hero') } }}>Log Out</button>
          </div>
        </div></div>
        {addModal}
      </div>
    )
  }

  if (currentView === 'hero') {
    const awaitingQr = nameConfirmed && connecting && !whatsappStatus.qrCode
    return (
      <div className="app-shell">
        {switcher}
        <div className="hero-layout"><div className="hero-content">
          <h1 className="hero-title">WhatsApp MCP Server</h1>
          <p className="hero-subtitle">{awaitingQr ? 'Connecting to WhatsApp…' : `Connect account "${slug}" to get started`}</p>
          {awaitingQr && (<><div className="loading-spinner" /><p className="hero-status" style={{ fontSize: '0.875rem', color: 'hsl(var(--muted-foreground))' }}>Waiting for QR code</p></>)}
          {!awaitingQr && nameConfirmed && whatsappStatus.qrCode && (<div className="qr-display"><img src={whatsappStatus.qrCode} alt="WhatsApp QR Code" /><p className="hero-status">Scan with WhatsApp to connect</p></div>)}
          {!awaitingQr && !nameConfirmed && (
            <>
              <div style={{ marginBottom: '1rem', width: '100%', maxWidth: '300px' }}>
                <label htmlFor="userName" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'hsl(var(--muted-foreground))' }}>Your full name</label>
                <input id="userName" type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Enter your name" style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--input))', color: 'hsl(var(--foreground))', fontSize: '1rem' }} disabled={connecting} />
              </div>
              <button onClick={handleConnect} disabled={connecting || !userName.trim()}>{connecting ? 'Connecting…' : 'Connect WhatsApp'}</button>
            </>
          )}
          {!awaitingQr && nameConfirmed && !whatsappStatus.qrCode && !connecting && (<button onClick={handleConnect}>Connect WhatsApp</button>)}
          {whatsappStatus.error && (<p style={{ color: 'hsl(var(--destructive))', marginTop: '1rem' }}>{whatsappStatus.error}</p>)}
          <button className="btn-secondary" style={{ marginTop: '1.5rem' }} onClick={() => setCurrentView('settings')}>Settings</button>
        </div></div>
        {addModal}
      </div>
    )
  }

  if (currentView === 'sync-status') {
    const aliasUrl = mcpStatus && accounts.find((a) => a.slug === slug) ? `http://localhost:${mcpStatus.port}/mcp/${slug}` : ''
    return (
      <div className="app-shell">
        {switcher}
        <div className="hero-layout"><div className="hero-content">
          <h1 className="hero-title">Syncing Messages</h1>
          <p className="hero-subtitle">Account <strong>{slug}</strong> — {syncStatus.isSyncing ? `syncing ${syncStatus.completedChats} of ${syncStatus.totalChats} chats` : 'all messages synced'}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem', color: 'hsl(var(--foreground))' }}>
            <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: syncStatus.isSyncing ? 'hsl(var(--warning))' : 'hsl(var(--success))' }} />
            {syncStatus.isSyncing ? 'Syncing…' : 'Connected'}
          </div>
          <div className="activity-stats">
            <div className="activity-stat-row"><span className="activity-stat-label">Last activity:</span><span className="activity-stat-value">{formatRelativeTime(activityStatus.lastActivityTime)}</span></div>
            <div className="activity-stat-row"><span className="activity-stat-label">Messages stored:</span><span className="activity-stat-value">{activityStatus.totalMessagesStored.toLocaleString()}</span></div>
          </div>
          <div style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: 'hsl(var(--muted))', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1 }}>
              <span style={{ fontSize: '0.75rem', color: 'hsl(var(--muted-foreground))', textTransform: 'uppercase', letterSpacing: '0.05em' }}>MCP endpoint</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <code style={{ fontSize: '0.85rem', color: 'hsl(var(--foreground))' }}>{aliasUrl}</code>
                <button onClick={() => { if (aliasUrl) void navigator.clipboard.writeText(aliasUrl) }} style={{ padding: '4px 8px', fontSize: '0.7rem', cursor: 'pointer' }}>Copy</button>
              </div>
            </div>
          </div>
          <button onClick={() => setCurrentView('settings')} style={{ marginTop: '2rem' }}>Settings</button>
        </div></div>
        {addModal}
      </div>
    )
  }

  if (currentView === 'settings') {
    // The redesigned Settings page has its own sidebar with an active-account chip,
    // so the global AccountSwitcher is hidden while in Settings.
    return (
      <div className="app-shell">
        <Settings
          slug={slug}
          accounts={accounts}
          defaultSlug={defaultSlug}
          statusByAccount={statusByAccount}
          onAccountsChanged={handleAccountsChanged}
          onBack={() => { whatsappStatus.state === 'connected' ? setCurrentView('sync-status') : whatsappStatus.state === 'connecting' ? setCurrentView('loading') : setCurrentView('hero') }}
          onLogoff={() => { setNameConfirmed(false); setUserName(''); setStatusByAccount((prev) => ({ ...prev, [slug]: { state: 'disconnected', qrCode: null, error: null } })); setCurrentView('hero') }}
          onAddAccount={() => setShowAddModal(true)}
          onSelectAccount={handleSelectSlug}
          initialTab={pendingInitialTab}
        />
        {addModal}
      </div>
    )
  }
  return null
}
