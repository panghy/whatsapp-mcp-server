import { useState, useEffect, useCallback } from 'react'
import LogsViewer from './LogsViewer'
import { validateSlug } from './slug'
import type { Account, McpStatus, UpdateStatusData, WhatsAppStatus, McpUrlInfo } from './types'

interface Group {
  id: number
  whatsapp_jid: string
  chat_type: string
  enabled: boolean
  last_activity: string | null
  name?: string
}

interface SettingsProps {
  slug: string
  accounts: Account[]
  defaultSlug: string | null
  statusByAccount: Record<string, WhatsAppStatus>
  onAccountsChanged: (nextSelected?: string) => Promise<void> | void
  onBack?: () => void
  onLogoff?: () => void
}

export default function Settings({ slug, accounts, defaultSlug, statusByAccount, onAccountsChanged, onBack, onLogoff }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<'group-sync' | 'interface-system' | 'logs' | 'accounts'>('group-sync')
  const [groups, setGroups] = useState<Group[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [displayNameSaved, setDisplayNameSaved] = useState(false)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // MCP Server state
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({ status: 'stopped', port: 13491, running: false, error: null })
  const [mcpPort, setMcpPort] = useState('13491')
  const [mcpPortSaved, setMcpPortSaved] = useState(false)
  const [mcpAutoStart, setMcpAutoStart] = useState(false)
  const [mcpUrls, setMcpUrls] = useState<Record<string, McpUrlInfo>>({})
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null)
  // App version
  const [appVersion, setAppVersion] = useState('1.0.0')
  // Update state
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusData>({ status: 'idle', version: null, error: null, progress: null })
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  // Rename state (per-slug editing)
  const [renameSlug, setRenameSlug] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true); setError(null)
      const [groupsData, name, autoLaunchEnabled, trayEnabled, mcpStatusData, autoStart] = await Promise.all([
        window.electron.getGroups(slug),
        window.electron.getUserDisplayName(slug),
        window.electron.getAutoLaunch(),
        window.electron.getMinimizeToTray(),
        window.electron.getMcpStatus(),
        window.electron.getMcpAutoStart(),
      ])
      setGroups(groupsData)
      setDisplayName(name || '')
      setAutoLaunch(autoLaunchEnabled)
      setMinimizeToTray(trayEnabled)
      setMcpStatus(mcpStatusData); setMcpPort(String(mcpStatusData.port))
      setMcpAutoStart(autoStart)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load settings'
      setError(msg); console.error('Failed to load settings:', err)
    } finally { setLoading(false) }
  }, [slug])

  useEffect(() => { void loadSettings() }, [loadSettings])

  // Refresh MCP URLs whenever the account list changes.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const entries = await Promise.all(accounts.map(async (a) => [a.slug, await window.electron.accounts.getMcpUrls(a.slug)] as const))
        if (cancelled) return
        const map: Record<string, McpUrlInfo> = {}
        for (const [s, info] of entries) map[s] = info
        setMcpUrls(map)
      } catch (err) { console.error('Failed to load MCP URLs:', err) }
    }
    void run()
    return () => { cancelled = true }
  }, [accounts])

  useEffect(() => {
    const loadAppVersion = async () => {
      try {
        const ver = await window.electron.getAppVersion()
        setAppVersion(ver)
      } catch (err) { console.error('Failed to get app version:', err) }
    }
    loadAppVersion()

    // Load initial update status
    const loadUpdateStatus = async () => {
      try {
        const status = await window.electron.getUpdateStatus() as UpdateStatusData
        setUpdateStatus(status)
      } catch (err) { console.error('Failed to get update status:', err) }
    }
    loadUpdateStatus()

    // Listen for update status events
    window.electron.onUpdateStatus((status: UpdateStatusData) => {
      setUpdateStatus(status)
      setCheckingUpdates(false)
    })
  }, [])

  // MCP polling for status updates
  useEffect(() => {
    const pollMcp = setInterval(async () => {
      try {
        const status = await window.electron.getMcpStatus()
        setMcpStatus(status)
      } catch (err) { console.error('Failed to poll MCP status:', err) }
    }, 2000)
    return () => clearInterval(pollMcp)
  }, [])

  const handleGroupToggle = async (groupId: number, enabled: boolean) => {
    try {
      await window.electron.setGroupEnabled(slug, groupId, !enabled)
      setGroups(groups.map(g => g.id === groupId ? { ...g, enabled: !enabled } : g))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update group'
      setError(msg); console.error('Failed to toggle group:', err)
    }
  }

  const handleDisplayNameSave = async () => {
    try { await window.electron.setUserDisplayName(slug, displayName); setDisplayNameSaved(true); setTimeout(() => setDisplayNameSaved(false), 2000) }
    catch (err) { console.error('Failed to save display name:', err) }
  }

  const handleDisplayNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { void handleDisplayNameSave() } }
  const handleAutoLaunchChange = async (e: React.ChangeEvent<HTMLInputElement>) => { try { await window.electron.setAutoLaunch(e.target.checked); setAutoLaunch(e.target.checked) } catch (err) { console.error('Failed to update auto-launch:', err) } }
  const handleMinimizeToTrayChange = async (e: React.ChangeEvent<HTMLInputElement>) => { try { await window.electron.setMinimizeToTray(e.target.checked); setMinimizeToTray(e.target.checked) } catch (err) { console.error('Failed to update tray setting:', err) } }
  const handleMcpAutoStartChange = async (e: React.ChangeEvent<HTMLInputElement>) => { try { await window.electron.setMcpAutoStart(e.target.checked); setMcpAutoStart(e.target.checked) } catch (err) { console.error('Failed to update MCP auto-start:', err) } }

  // MCP handlers
  const handleMcpPortSave = async () => {
    const portNum = parseInt(mcpPort, 10)
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) { setError('Invalid port number (must be 1-65535)'); return }
    try { await window.electron.setMcpPort(portNum); setMcpPortSaved(true); setTimeout(() => setMcpPortSaved(false), 2000) }
    catch (err) { console.error('Failed to save MCP port:', err) }
  }
  const handleMcpPortKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { void handleMcpPortSave() } }

  const handleRelinkWhatsApp = async () => {
    if (window.confirm(`Re-link account "${slug}"? This clears its WhatsApp session and shows a new QR code. Messages are preserved.`)) {
      try { await window.electron.relinkWhatsApp(slug); setError(null) } catch (err) { setError(err instanceof Error ? err.message : 'Failed to relink WhatsApp') }
    }
  }

  const handleLogout = async () => {
    if (window.confirm(`Log out of "${slug}"? Your messages and settings are kept — the MCP endpoint will be disabled until you re-link.`)) {
      try { await window.electron.whatsappLogout(slug); setError(null); if (onLogoff) { onLogoff() } } catch (err) { setError(err instanceof Error ? err.message : 'Failed to log off') }
    }
  }

  const copyUrl = async (s: string, url: string) => {
    try { await navigator.clipboard.writeText(url); setCopiedSlug(s); setTimeout(() => setCopiedSlug((cur) => (cur === s ? null : cur)), 1500) }
    catch (err) { console.error('Failed to copy URL:', err) }
  }

  const handleSetDefault = async (s: string) => {
    try { await window.electron.accounts.setDefault(s); await onAccountsChanged(s) }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to set default account') }
  }

  const startRename = (s: string) => { setRenameSlug(s); setRenameValue(s); setRenameError(null) }
  const cancelRename = () => { setRenameSlug(null); setRenameValue(''); setRenameError(null) }
  const submitRename = async () => {
    if (!renameSlug) return
    const next = renameValue.trim()
    if (next === renameSlug) { cancelRename(); return }
    const otherSlugs = accounts.map((a) => a.slug).filter((s) => s !== renameSlug)
    const err = validateSlug(next, otherSlugs)
    if (err) { setRenameError(err); return }
    try { await window.electron.accounts.rename(renameSlug, next); cancelRename(); await onAccountsChanged(next) }
    catch (apiErr) { setRenameError(apiErr instanceof Error ? apiErr.message : 'Failed to rename account') }
  }

  const handleRemoveAccount = async (s: string) => {
    if (accounts.length <= 1) { setError('Cannot remove the last account'); return }
    if (!window.confirm(`Remove account "${s}"? Its database and session data will be deleted. This cannot be undone.`)) return
    try { await window.electron.accounts.remove(s); const next = accounts.find((a) => a.slug !== s)?.slug; await onAccountsChanged(next) }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to remove account') }
  }

  // Update handlers
  const handleCheckForUpdates = async () => {
    setCheckingUpdates(true)
    try { await window.electron.checkForUpdates() }
    catch (err) { console.error('Failed to check for updates:', err); setCheckingUpdates(false) }
  }

  const handleQuitAndInstall = async () => {
    try { await window.electron.quitAndInstall() }
    catch (err) { console.error('Failed to quit and install:', err) }
  }

  const filteredGroups = groups.filter(g => (g.name || g.whatsapp_jid).toLowerCase().includes(searchQuery.toLowerCase()))

  const formatLastActivity = (timestamp: string | null) => {
    if (!timestamp) return 'Never'
    const date = new Date(timestamp); const now = new Date()
    const diffMs = now.getTime() - date.getTime(); const diffMins = Math.floor(diffMs / 60000); const diffHours = Math.floor(diffMs / 3600000); const diffDays = Math.floor(diffMs / 86400000)
    if (diffMins < 1) return 'Just now'; if (diffMins < 60) return `${diffMins}m ago`; if (diffHours < 24) return `${diffHours}h ago`; if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && onBack) { onBack() } }
    window.addEventListener('keydown', handleKeyDown); return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onBack])

  return (
    <div className="settings-page">
      <div className="settings-header">
        <div className="settings-header-top">
          {onBack && (<button className="settings-back-btn" onClick={onBack}>← Back<kbd>Esc</kbd></button>)}
        </div>
        <h1>Settings <span className="settings-header-slug">— {slug}</span></h1>
      </div>
      <div className="settings-tabs">
        <button className={`tab-btn ${activeTab === 'group-sync' ? 'active' : ''}`} onClick={() => setActiveTab('group-sync')}>Group Visibility</button>
        <button className={`tab-btn ${activeTab === 'accounts' ? 'active' : ''}`} onClick={() => setActiveTab('accounts')}>Accounts</button>
        <button className={`tab-btn ${activeTab === 'interface-system' ? 'active' : ''}`} onClick={() => setActiveTab('interface-system')}>Interface & System</button>
        <button className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>Logs</button>
      </div>
      <div className="settings-content"><div className="settings-content-inner">
        {error && (<div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'hsl(var(--destructive) / 0.1)', borderRadius: '0.375rem', color: 'hsl(var(--destructive))' }}><p>{error}</p></div>)}

        {activeTab === 'group-sync' && (
          <div className="groups-tab">
            <h3>Group Visibility <span style={{ fontSize: '0.85rem', color: 'hsl(var(--muted-foreground))', fontWeight: 400 }}>— {slug}</span></h3>
            <p className="tab-description">Turning off a chat hides it from account <strong>{slug}</strong>'s MCP operations. Messages are still synced in the background, so re-enabling restores full history.</p>
            <div className="search-box"><input type="text" placeholder="Search groups..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} /></div>
            {loading ? (<p className="loading">Loading groups...</p>) : filteredGroups.length === 0 ? (<p className="no-groups">No groups found</p>) : (
              <div className="groups-list">
                {filteredGroups.map(group => (
                  <div key={group.id} className="group-item">
                    <div className="group-info">
                      <div className="group-name">{group.name || group.whatsapp_jid}</div>
                      {group.name && <div className="group-jid">{group.whatsapp_jid}</div>}
                      <div className="group-meta"><span className="last-activity">Last: {formatLastActivity(group.last_activity)}</span></div>
                    </div>
                    <label className="toggle-switch"><input type="checkbox" checked={group.enabled} onChange={() => handleGroupToggle(group.id, group.enabled)} /><span className="slider"></span></label>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'interface-system' && (
          <div>
            <h3>Interface & System</h3>
            <div className="setting-item" style={{ marginTop: '1rem' }}>
              <label htmlFor="display-name">Your Name <span style={{ fontSize: '0.75rem', color: 'hsl(var(--muted-foreground))', fontWeight: 400 }}>({slug})</span></label>
              <div style={{ position: 'relative' }}>
                <input id="display-name" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} onBlur={handleDisplayNameSave} onKeyDown={handleDisplayNameKeyDown} placeholder="Your name" />
                {displayNameSaved && (<span style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', color: 'hsl(var(--success, 142 76% 36%))', opacity: 0.8 }}>Saved</span>)}
              </div>
              <p className="setting-description">Your name as it appears in synced messages for this account</p>
            </div>
            <div className="setting-item" style={{ marginTop: '1rem', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontWeight: 500, fontSize: '0.95rem' }}>Launch on startup</span><label className="toggle-switch"><input type="checkbox" checked={autoLaunch} onChange={handleAutoLaunchChange} /><span className="slider"></span></label></div>
            <div className="setting-item" style={{ marginTop: '1rem', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontWeight: 500, fontSize: '0.95rem' }}>Minimize to tray on close</span><label className="toggle-switch"><input type="checkbox" checked={minimizeToTray} onChange={handleMinimizeToTrayChange} /><span className="slider"></span></label></div>

            {/* MCP Server Section */}
            <div style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid hsl(var(--border))' }}>
              <h4 style={{ marginBottom: '1rem' }}>MCP Server</h4>
              <div className="setting-item">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: mcpStatus.status === 'running' ? 'hsl(var(--success, 142 76% 36%))' : mcpStatus.status === 'port_conflict' ? 'hsl(var(--warning, 45 93% 47%))' : mcpStatus.status === 'error' ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))' }} />
                  <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>
                    {mcpStatus.status === 'running' ? `Running on port ${mcpStatus.port}` : mcpStatus.status === 'starting' ? 'Starting...' : mcpStatus.status === 'port_conflict' ? `Port ${mcpStatus.port} in use` : mcpStatus.status === 'error' ? 'Error' : 'Stopped'}
                  </span>
                </div>
                {mcpStatus.error && mcpStatus.status !== 'running' && (<p style={{ fontSize: '0.75rem', color: 'hsl(var(--destructive))', marginBottom: '0.5rem' }}>{mcpStatus.error}</p>)}
              </div>
              <div className="setting-item">
                <label htmlFor="mcp-port">Server Port</label>
                <div style={{ position: 'relative' }}>
                  <input id="mcp-port" type="text" inputMode="numeric" pattern="[0-9]*" value={mcpPort} onChange={(e) => setMcpPort(e.target.value)} onBlur={handleMcpPortSave} onKeyDown={handleMcpPortKeyDown} placeholder="13491" />
                  {mcpPortSaved && (<span style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', color: 'hsl(var(--success, 142 76% 36%))', opacity: 0.8 }}>Saved</span>)}
                </div>
                <p className="setting-description">Port for MCP HTTP server (requires restart). All accounts share this port and are routed by slug.</p>
              </div>
              <div className="setting-item" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 500, fontSize: '0.95rem' }}>Auto-start MCP server</span>
                <label className="toggle-switch"><input type="checkbox" checked={mcpAutoStart} onChange={handleMcpAutoStartChange} /><span className="slider"></span></label>
              </div>

              <div className="mcp-url-list" style={{ marginTop: '1rem' }}>
                <p className="setting-description" style={{ marginBottom: '0.5rem' }}>Account endpoints</p>
                {accounts.length === 0 ? (
                  <p style={{ fontSize: '0.85rem', color: 'hsl(var(--muted-foreground))' }}>No accounts configured.</p>
                ) : accounts.map((a) => {
                  const info = mcpUrls[a.slug]
                  const path = info?.path || `/mcp/${a.slug}`
                  const url = `http://localhost:${mcpStatus.port}${path}`
                  const aliasUrl = info?.alias ? `http://localhost:${mcpStatus.port}${info.alias}` : null
                  const st = statusByAccount[a.slug]
                  const disabled = !a.mcpEnabled
                  return (
                    <div key={a.slug} className="mcp-url-row" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid hsl(var(--border))', marginBottom: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <strong style={{ fontSize: '0.9rem' }}>{a.slug}</strong>
                        <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'hsl(var(--muted-foreground))' }}>{disabled ? 'Re-link required' : st?.state === 'connected' ? 'Connected' : 'Disconnected'}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <code style={{ fontSize: '0.8rem', color: disabled ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{url}</code>
                        <button className="action-btn" disabled={disabled} onClick={() => copyUrl(a.slug, url)} style={{ padding: '4px 8px', fontSize: '0.7rem' }}>{copiedSlug === a.slug ? 'Copied' : 'Copy'}</button>
                        {disabled && (<button className="action-btn" onClick={async () => { try { await window.electron.relinkWhatsApp(a.slug); await onAccountsChanged(a.slug) } catch (err) { setError(err instanceof Error ? err.message : 'Failed to re-link') } }} style={{ padding: '4px 8px', fontSize: '0.7rem' }}>Re-link</button>)}
                      </div>
                      {aliasUrl && (<p style={{ fontSize: '0.7rem', color: 'hsl(var(--muted-foreground))', margin: 0 }}>Default alias: <code>{aliasUrl}</code></p>)}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Updates Section */}
            <div style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid hsl(var(--border))' }}>
              <h4 style={{ marginBottom: '1rem' }}>Updates</h4>
              <div className="setting-item">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '0.875rem' }}>Current version: <strong>v{appVersion}</strong></span>
                  {updateStatus.status === 'downloaded' && updateStatus.version && (
                    <span style={{ fontSize: '0.75rem', color: 'hsl(var(--success, 142 76% 36%))' }}>v{updateStatus.version} ready to install</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                  {updateStatus.status === 'downloaded' ? (
                    <button className="action-btn" onClick={handleQuitAndInstall} style={{ backgroundColor: 'hsl(var(--success, 142 76% 36%))', color: 'white' }}>
                      Restart Now
                    </button>
                  ) : (
                    <button className="action-btn" onClick={handleCheckForUpdates} disabled={checkingUpdates || updateStatus.status === 'checking' || updateStatus.status === 'downloading'}>
                      {checkingUpdates || updateStatus.status === 'checking' ? 'Checking...' : updateStatus.status === 'downloading' ? `Downloading... ${updateStatus.progress ? Math.round(updateStatus.progress) + '%' : ''}` : 'Check for Updates'}
                    </button>
                  )}
                </div>
                {updateStatus.status === 'not-available' && (<p style={{ fontSize: '0.75rem', color: 'hsl(var(--muted-foreground))', marginTop: '0.5rem' }}>You're on the latest version</p>)}
                {updateStatus.status === 'available' && updateStatus.version && (<p style={{ fontSize: '0.75rem', color: 'hsl(var(--success, 142 76% 36%))', marginTop: '0.5rem' }}>Update v{updateStatus.version} is downloading...</p>)}
                {updateStatus.status === 'error' && updateStatus.error && (<p style={{ fontSize: '0.75rem', color: 'hsl(var(--destructive))', marginTop: '0.5rem' }}>{updateStatus.error}</p>)}
              </div>
            </div>

            <div style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid hsl(var(--border))' }}>
              <h4 style={{ marginBottom: '1rem' }}>Account actions <span style={{ fontSize: '0.8rem', color: 'hsl(var(--muted-foreground))', fontWeight: 400 }}>— {slug}</span></h4>
              <div className="action-group"><h5>Re-link WhatsApp</h5><p>Clear <strong>{slug}</strong>'s WhatsApp session and scan a new QR code. Messages are preserved.</p><button className="action-btn" onClick={handleRelinkWhatsApp}>Re-link WhatsApp</button></div>
              <div className="action-group danger" style={{ marginTop: '1.5rem' }}><h5>Log out</h5><p>Sign <strong>{slug}</strong> out of WhatsApp. Messages and settings are kept; the MCP endpoint is disabled until you re-link.</p><button className="action-btn danger" style={{ color: 'white' }} onClick={handleLogout}>Log out</button></div>
            </div>
          </div>
        )}

        {activeTab === 'accounts' && (
          <AccountsTabBody
            accounts={accounts}
            selectedSlug={slug}
            defaultSlug={defaultSlug}
            statusByAccount={statusByAccount}
            mcpPort={mcpStatus.port}
            mcpUrls={mcpUrls}
            renameSlug={renameSlug}
            renameValue={renameValue}
            renameError={renameError}
            onRenameValueChange={(v) => { setRenameValue(v); setRenameError(null) }}
            onSubmitRename={() => void submitRename()}
            onCancelRename={cancelRename}
            onStartRename={startRename}
            onSetDefault={handleSetDefault}
            onRemoveAccount={handleRemoveAccount}
          />
        )}

        {activeTab === 'logs' && (<div><LogsViewer slug={slug} /></div>)}
      </div></div>
      <div className="settings-footer">
        <div className="settings-footer-left"><strong>WhatsApp MCP Server</strong><span>v{appVersion}</span></div>
        <div className="settings-footer-right"><a href="https://github.com/panghy/whatsapp-mcp-server/issues" className="settings-footer-link" target="_blank" rel="noopener noreferrer">Help</a><span className="settings-footer-divider">•</span><a href="https://github.com/panghy/whatsapp-mcp-server" className="settings-footer-link" target="_blank" rel="noopener noreferrer">About</a></div>
      </div>
      <div style={{ textAlign: 'center', padding: '0.5rem 1rem', fontSize: '0.65rem', color: 'hsl(var(--muted-foreground))', opacity: 0.6 }}>
        This software is provided as-is, without warranty. Not affiliated with WhatsApp or Meta.
      </div>
    </div>
  )
}



interface AccountsTabBodyProps {
  accounts: Account[]
  selectedSlug: string
  defaultSlug: string | null
  statusByAccount: Record<string, WhatsAppStatus>
  mcpPort: number
  mcpUrls: Record<string, McpUrlInfo>
  renameSlug: string | null
  renameValue: string
  renameError: string | null
  onRenameValueChange: (value: string) => void
  onSubmitRename: () => void
  onCancelRename: () => void
  onStartRename: (slug: string) => void
  onSetDefault: (slug: string) => void
  onRemoveAccount: (slug: string) => void
}

export function AccountsTabBody({
  accounts, selectedSlug, defaultSlug, statusByAccount, mcpPort, mcpUrls,
  renameSlug, renameValue, renameError,
  onRenameValueChange, onSubmitRename, onCancelRename, onStartRename,
  onSetDefault, onRemoveAccount,
}: AccountsTabBodyProps) {
  return (
    <div>
      <h3>Accounts</h3>
      <p className="tab-description">Each account has its own WhatsApp session, database, and MCP endpoint.</p>
      <p className="tab-description" data-testid="default-explainer" style={{ marginTop: '0.5rem', padding: '0.75rem', backgroundColor: 'hsl(var(--muted) / 0.4)', borderRadius: '0.375rem', fontSize: '0.85rem' }}>
        The default account is also served at the bare <code>/mcp</code> path for back-compat with single-account MCP clients. Changing which account you&apos;re viewing at the top of the window does not change the default — click &quot;Make default&quot; below to change it.
      </p>
      <div className="accounts-list" style={{ marginTop: '1rem' }}>
        {accounts.map((a) => {
          const st = statusByAccount[a.slug]
          const isViewing = a.slug === selectedSlug
          const isDefault = a.slug === defaultSlug
          const editing = renameSlug === a.slug
          const info = mcpUrls[a.slug]
          const url = `http://localhost:${mcpPort}${info?.path || `/mcp/${a.slug}`}`
          return (
            <div key={a.slug} className="account-row" data-slug={a.slug} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid hsl(var(--border))', marginBottom: '0.75rem', backgroundColor: isViewing ? 'hsl(var(--muted) / 0.4)' : 'transparent' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: !a.mcpEnabled ? '#f97316' : st?.state === 'connected' ? 'hsl(var(--success))' : st?.state === 'connecting' ? 'hsl(var(--warning))' : st?.state === 'error' ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))' }} />
                {editing ? (
                  <>
                    <input type="text" autoFocus value={renameValue} onChange={(e) => onRenameValueChange(e.target.value.toLowerCase())} onKeyDown={(e) => { if (e.key === 'Enter') onSubmitRename(); if (e.key === 'Escape') onCancelRename() }} style={{ flex: 1, padding: '0.25rem 0.5rem', borderRadius: '0.25rem', border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--input))', color: 'hsl(var(--foreground))' }} />
                    <button className="action-btn" onClick={onSubmitRename} style={{ padding: '4px 8px', fontSize: '0.75rem' }}>Save</button>
                    <button className="action-btn" onClick={onCancelRename} style={{ padding: '4px 8px', fontSize: '0.75rem' }}>Cancel</button>
                  </>
                ) : (
                  <>
                    <strong style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span>{a.slug}</span>
                      {isDefault && (
                        <span
                          className="account-default-badge"
                          data-testid="default-badge"
                          title="MCP clients pointed at /mcp route to this account."
                          style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '2px 6px', borderRadius: '9999px', backgroundColor: 'hsl(var(--primary, 210 90% 50%))', color: 'white', fontWeight: 600 }}
                        >
                          Default
                        </span>
                      )}
                      {isViewing && (
                        <span style={{ fontSize: '0.7rem', color: 'hsl(var(--muted-foreground))', fontWeight: 400 }}>viewing</span>
                      )}
                    </strong>
                    <button className="action-btn" data-testid={`make-default-${a.slug}`} onClick={() => onSetDefault(a.slug)} disabled={isDefault} style={{ padding: '4px 8px', fontSize: '0.75rem' }} title="Make this the default account; MCP clients pointed at /mcp will route here.">Make default</button>
                    <button className="action-btn" onClick={() => onStartRename(a.slug)} style={{ padding: '4px 8px', fontSize: '0.75rem' }}>Rename</button>
                    <button className="action-btn danger" onClick={() => onRemoveAccount(a.slug)} disabled={accounts.length <= 1} style={{ padding: '4px 8px', fontSize: '0.75rem', color: 'white' }}>Remove</button>
                  </>
                )}
              </div>
              {editing && renameError && (<p style={{ fontSize: '0.75rem', color: 'hsl(var(--destructive))', margin: 0 }}>{renameError}</p>)}
              <code style={{ fontSize: '0.75rem', color: 'hsl(var(--muted-foreground))' }}>{url}</code>
            </div>
          )
        })}
      </div>
    </div>
  )
}
