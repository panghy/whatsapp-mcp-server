import { useState, useEffect } from 'react'
import LogsViewer from './LogsViewer'

interface Group {
  id: number
  whatsapp_jid: string
  chat_type: string
  enabled: boolean
  last_activity: string | null
  name?: string
}

interface SettingsProps {
  onBack?: () => void
  onLogoff?: () => void
}

interface McpStatusData {
  status: 'stopped' | 'starting' | 'running' | 'port_conflict' | 'error'
  port: number
  running: boolean
  error: string | null
}

export default function Settings({ onBack, onLogoff }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<'group-sync' | 'interface-system' | 'logs'>('group-sync')
  const [groups, setGroups] = useState<Group[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [displayNameSaved, setDisplayNameSaved] = useState(false)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // MCP Server state
  const [mcpStatus, setMcpStatus] = useState<McpStatusData>({ status: 'stopped', port: 13491, running: false, error: null })
  const [mcpPort, setMcpPort] = useState('13491')
  const [mcpPortSaved, setMcpPortSaved] = useState(false)

  useEffect(() => { loadSettings() }, [])

  const loadSettings = async () => {
    try {
      setLoading(true); setError(null)
      const groupsData = await window.electron.getGroups(); setGroups(groupsData)
      const name = await window.electron.getUserDisplayName(); setDisplayName(name || '')
      const autoLaunchEnabled = await window.electron.getAutoLaunch(); setAutoLaunch(autoLaunchEnabled)
      // Load MCP settings
      const mcpStatusData = await window.electron.getMcpStatus(); setMcpStatus(mcpStatusData); setMcpPort(String(mcpStatusData.port))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load settings'
      setError(msg); console.error('Failed to load settings:', err)
    } finally { setLoading(false) }
  }

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
      await window.electron.setGroupEnabled(groupId, !enabled)
      setGroups(groups.map(g => g.id === groupId ? { ...g, enabled: !enabled } : g))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update group'
      setError(msg); console.error('Failed to toggle group:', err)
    }
  }

  const handleDisplayNameSave = async () => {
    try { await window.electron.setUserDisplayName(displayName); setDisplayNameSaved(true); setTimeout(() => setDisplayNameSaved(false), 2000) }
    catch (err) { console.error('Failed to save display name:', err) }
  }

  const handleDisplayNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { handleDisplayNameSave() } }
  const handleAutoLaunchChange = async (e: React.ChangeEvent<HTMLInputElement>) => { try { await window.electron.setAutoLaunch(e.target.checked); setAutoLaunch(e.target.checked) } catch (err) { console.error('Failed to update auto-launch:', err) } }

  // MCP handlers
  const handleMcpPortSave = async () => {
    const portNum = parseInt(mcpPort, 10)
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) { setError('Invalid port number (must be 1-65535)'); return }
    try { await window.electron.setMcpPort(portNum); setMcpPortSaved(true); setTimeout(() => setMcpPortSaved(false), 2000) }
    catch (err) { console.error('Failed to save MCP port:', err) }
  }
  const handleMcpPortKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { handleMcpPortSave() } }

  const handleRelinkWhatsApp = async () => {
    if (window.confirm('This will clear your WhatsApp session and show the QR code again. Your messages will be preserved.')) {
      try { await window.electron.relinkWhatsApp(); setError(null) } catch (err) { setError(err instanceof Error ? err.message : 'Failed to relink WhatsApp') }
    }
  }

  const handleLogoff = async () => {
    if (window.confirm('This will delete ALL local data including messages and attachments. This action cannot be undone. Continue?')) {
      try { await window.electron.logoff(); setError(null); if (onLogoff) { onLogoff() } } catch (err) { setError(err instanceof Error ? err.message : 'Failed to log off') }
    }
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
        <h1>Settings</h1>
      </div>
      <div className="settings-tabs">
        <button className={`tab-btn ${activeTab === 'group-sync' ? 'active' : ''}`} onClick={() => setActiveTab('group-sync')}>Group Sync</button>
        <button className={`tab-btn ${activeTab === 'interface-system' ? 'active' : ''}`} onClick={() => setActiveTab('interface-system')}>Interface & System</button>
        <button className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>Logs</button>
      </div>
      <div className="settings-content"><div className="settings-content-inner">
        {error && (<div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'hsl(var(--destructive) / 0.1)', borderRadius: '0.375rem', color: 'hsl(var(--destructive))' }}><p>{error}</p></div>)}

        {activeTab === 'group-sync' && (
          <div className="groups-tab">
            <h3>Select Groups to Sync</h3><p className="tab-description">Enable groups to sync their messages.</p>
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
              <label htmlFor="display-name">Your Name</label>
              <div style={{ position: 'relative' }}>
                <input id="display-name" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} onBlur={handleDisplayNameSave} onKeyDown={handleDisplayNameKeyDown} placeholder="Your name" />
                {displayNameSaved && (<span style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', color: 'hsl(var(--success, 142 76% 36%))', opacity: 0.8 }}>Saved</span>)}
              </div>
              <p className="setting-description">Your name as it appears in synced messages</p>
            </div>
            <div className="setting-item" style={{ marginTop: '1rem', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontWeight: 500, fontSize: '0.95rem' }}>Launch on startup</span><label className="toggle-switch"><input type="checkbox" checked={autoLaunch} onChange={handleAutoLaunchChange} /><span className="slider"></span></label></div>

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
                <p className="setting-description">Port for MCP HTTP server (requires restart)</p>
              </div>
            </div>

            <div style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid hsl(var(--border))' }}>
              <h4 style={{ marginBottom: '1rem' }}>Account Actions</h4>
              <div className="action-group"><h5>Re-link WhatsApp</h5><p>Clear your WhatsApp session and scan the QR code again.</p><button className="action-btn" onClick={handleRelinkWhatsApp}>Re-link WhatsApp</button></div>
              <div className="action-group danger" style={{ marginTop: '1.5rem' }}><h5>Log Off</h5><p>Delete all local data including messages.</p><button className="action-btn danger" style={{ color: 'white' }} onClick={handleLogoff}>Log Off</button></div>
            </div>
          </div>
        )}
        {activeTab === 'logs' && (<div><LogsViewer /></div>)}
      </div></div>
      <div className="settings-footer">
        <div className="settings-footer-left"><strong>WhatsApp MCP Bridge</strong><span>v1.0.0</span></div>
        <div className="settings-footer-right"><a href="#" className="settings-footer-link">Help</a><span className="settings-footer-divider">•</span><a href="#" className="settings-footer-link">About</a></div>
      </div>
    </div>
  )
}

