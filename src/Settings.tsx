import { useState, useEffect, useCallback } from 'react'
import LogsViewer from './LogsViewer'
import { validateSlug } from './slug'
import type { Account, ConnectionState, McpStatus, UpdateStatusData, WhatsAppStatus, McpUrlInfo } from './types'

export interface RemoveAccountDeps {
  confirm: (message: string) => boolean
  whatsappLogout: (slug: string) => Promise<unknown>
  accountsRemove: (slug: string) => Promise<unknown>
}

export type RemoveAccountResult =
  | { ok: true }
  | { ok: false; cancelled: true }
  | { ok: false; error: string }

export function buildRemoveAccountMessage(slug: string): string {
  return (
    `Remove account "${slug}"? ` +
    'This will log out of WhatsApp on this device, clear all local data for this account, ' +
    'and cannot be undone.'
  )
}

export async function performAccountRemoval(
  slug: string,
  state: ConnectionState | undefined,
  deps: RemoveAccountDeps,
): Promise<RemoveAccountResult> {
  if (!deps.confirm(buildRemoveAccountMessage(slug))) return { ok: false, cancelled: true }
  const needsLogout = state === 'connected' || state === 'connecting'
  if (needsLogout) {
    try { await deps.whatsappLogout(slug) }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Failed to log out' } }
  }
  try { await deps.accountsRemove(slug) }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Failed to remove account' } }
  return { ok: true }
}

const STATE_PILL_LABELS: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  error: 'Error',
}

export function getAccountStateLabel(status: WhatsAppStatus | undefined): string {
  const state = status?.state ?? 'disconnected'
  return STATE_PILL_LABELS[state]
}

// Sidebar account-selector onChange wiring. Extracted so it can be unit-tested
// without spinning up a DOM (no jsdom is configured in this repo).
export function makeAccountSelectChangeHandler(
  onSelectAccount: ((slug: string) => void) | undefined,
): (e: { target: { value: string } }) => void {
  return (e) => { if (onSelectAccount) onSelectAccount(e.target.value) }
}

interface Group {
  id: number
  whatsapp_jid: string
  chat_type: string
  enabled: boolean
  last_activity: string | null
  name?: string
}

export function sortGroupsByLastActivity<T extends { last_activity: string | null }>(groups: readonly T[]): T[] {
  const parse = (v: string | null): number | null => {
    if (!v) return null
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return [...groups].sort((a, b) => {
    const ta = parse(a.last_activity); const tb = parse(b.last_activity)
    if (ta === null && tb === null) return 0
    if (ta === null) return 1
    if (tb === null) return -1
    return tb - ta
  })
}

// New sidebar section IDs. The sidebar groups them under "This account" and "Application".
export type SettingsTab =
  | 'this-account-profile'
  | 'this-account-groups'
  | 'this-account-logs'
  | 'this-account-logoff'
  | 'app-accounts'
  | 'app-mcp'
  | 'app-system'

// Legacy tab IDs accepted via the `initialTab` prop (used by IPC `open-logs` and any
// existing callers). Mapped onto the new section IDs by `resolveInitialTab` below.
type LegacySettingsTab = 'group-sync' | 'interface-system' | 'logs'

// Map legacy tab IDs to the new sidebar section IDs:
// - 'group-sync'       -> 'this-account-groups' (Group Visibility now lives under This account)
// - 'interface-system' -> 'app-system'          (System / Launch-on-startup lives under Application)
// - 'logs'             -> 'this-account-logs'   (Logs remains per-account, just relocated)
function resolveInitialTab(tab: SettingsTab | LegacySettingsTab | null | undefined): SettingsTab {
  if (tab === 'group-sync') return 'this-account-groups'
  if (tab === 'interface-system') return 'app-system'
  if (tab === 'logs') return 'this-account-logs'
  return tab ?? 'this-account-groups'
}

interface SettingsProps {
  slug: string
  accounts: Account[]
  defaultSlug: string | null
  statusByAccount: Record<string, WhatsAppStatus>
  onAccountsChanged: (nextSelected?: string) => Promise<void> | void
  onBack?: () => void
  onLogoff?: () => void
  onAddAccount?: () => void
  onSelectAccount?: (slug: string) => void
  initialTab?: SettingsTab | LegacySettingsTab | null
}

export default function Settings({ slug, accounts, defaultSlug, statusByAccount, onAccountsChanged, onBack, onAddAccount, onSelectAccount, initialTab }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(resolveInitialTab(initialTab))
  const [groups, setGroups] = useState<Group[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [displayNameSaved, setDisplayNameSaved] = useState(false)
  const [autoLaunch, setAutoLaunch] = useState(false)
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
      const [groupsData, name, autoLaunchEnabled, mcpStatusData, autoStart] = await Promise.all([
        window.electron.getGroups(slug),
        window.electron.getUserDisplayName(slug),
        window.electron.getAutoLaunch(),
        window.electron.getMcpStatus(),
        window.electron.getMcpAutoStart(),
      ])
      setGroups(groupsData)
      setDisplayName(name || '')
      setAutoLaunch(autoLaunchEnabled)
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
    const result = await performAccountRemoval(s, statusByAccount[s]?.state, {
      confirm: (m) => window.confirm(m),
      whatsappLogout: (slug) => window.electron.whatsappLogout(slug),
      accountsRemove: (slug) => window.electron.accounts.remove(slug),
    })
    if (!result.ok) {
      if ('error' in result) setError(result.error)
      return
    }
    setError(null)
    const next = accounts.find((a) => a.slug !== s)?.slug
    await onAccountsChanged(next)
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

  const filteredGroups = sortGroupsByLastActivity(groups.filter(g => (g.name || g.whatsapp_jid).toLowerCase().includes(searchQuery.toLowerCase())))

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

  useEffect(() => {
    if (initialTab) { setActiveTab(resolveInitialTab(initialTab)) }
  }, [initialTab])

  useEffect(() => {
    // Tray "Open Logs" jumps straight to This account → Logs.
    const handleOpenLogs = () => { setActiveTab('this-account-logs') }
    const ipcRenderer = (window as any).ipcRenderer
    if (ipcRenderer) {
      ipcRenderer.on('open-logs', handleOpenLogs)
      return () => { ipcRenderer.removeListener('open-logs', handleOpenLogs) }
    }
    return undefined
  }, [])

  const navBtn = (id: SettingsTab, label: string, danger = false) => (
    <button
      className={`settings-sidebar-nav-btn ${activeTab === id ? 'active' : ''} ${danger ? 'danger' : ''}`}
      data-section={id}
      onClick={() => setActiveTab(id)}
    >
      {label}
    </button>
  )

  return (
    <div className="settings-page">
      <aside className="settings-sidebar">
        <div className="settings-sidebar-top">
          {onBack && (<button className="settings-back-btn" onClick={onBack}>← Back<kbd>Esc</kbd></button>)}
        </div>
        <nav>
          <div className="settings-sidebar-group" data-group="this-account">
            <label htmlFor="settings-account-select" className="settings-sidebar-account-select-label">Account</label>
            <select
              id="settings-account-select"
              data-testid="settings-account-select"
              className="settings-sidebar-account-select"
              aria-label="Select account to configure"
              value={slug}
              onChange={makeAccountSelectChangeHandler(onSelectAccount)}
            >
              {accounts.map((a) => {
                const isDefault = a.slug === defaultSlug
                const defaultSuffix = isDefault ? ' (default)' : ''
                return (
                  <option key={a.slug} value={a.slug}>{`${a.slug}${defaultSuffix}`}</option>
                )
              })}
            </select>
            {navBtn('this-account-profile', 'Profile')}
            {navBtn('this-account-groups', 'Group Visibility')}
            {navBtn('this-account-logs', 'Logs')}
            {navBtn('this-account-logoff', 'Log-off')}
          </div>
          <div className="settings-sidebar-group" data-group="application">
            <div className="settings-sidebar-group-header">Application</div>
            {navBtn('app-accounts', 'Accounts')}
            {navBtn('app-mcp', 'MCP Server')}
            {navBtn('app-system', 'System')}
          </div>
        </nav>
      </aside>
      <div className="settings-content"><div className="settings-content-inner">
        {error && (<div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'hsl(var(--destructive) / 0.1)', borderRadius: '0.375rem', color: 'hsl(var(--destructive))' }}><p>{error}</p></div>)}

        {activeTab === 'this-account-profile' && (() => {
          const info = mcpUrls[slug]
          const path = info?.path || `/mcp/${slug}`
          const url = `http://localhost:${mcpStatus.port}${path}`
          const aliasUrl = info?.alias ? `http://localhost:${mcpStatus.port}${info.alias}` : null
          const account = accounts.find((a) => a.slug === slug)
          const disabled = !(account?.mcpEnabled ?? true)
          return (
            <div>
              <div className="settings-section-header"><h3>Profile</h3></div>
              <div className="setting-item" style={{ marginTop: '1rem' }}>
                <label htmlFor="display-name">Your Name</label>
                <div style={{ position: 'relative' }}>
                  <input id="display-name" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} onBlur={handleDisplayNameSave} onKeyDown={handleDisplayNameKeyDown} placeholder="Your name" />
                  {displayNameSaved && (<span style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', color: 'hsl(var(--success, 142 76% 36%))', opacity: 0.8 }}>Saved</span>)}
                </div>
              </div>
              <div className="setting-item" style={{ marginTop: '2rem' }}>
                <label htmlFor="profile-mcp-url" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                  MCP Endpoint
                  <span
                    className="settings-hint-icon"
                    role="img"
                    aria-label="What is the MCP Endpoint?"
                    tabIndex={0}
                    title="Point your MCP client (e.g. Claude Desktop, Cursor) at this URL to access this WhatsApp account."
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
                  </span>
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <code id="profile-mcp-url" style={{ fontSize: '0.85rem', color: disabled ? 'hsl(var(--muted-foreground))' : 'hsl(var(--foreground))', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0.4rem 0.6rem', borderRadius: '0.375rem', border: '1px solid hsl(var(--border))', backgroundColor: 'hsl(var(--background))' }}>{url}</code>
                  {disabled && (<button className="action-btn" onClick={handleRelinkWhatsApp} style={{ padding: '4px 8px', fontSize: '0.75rem', width: 'auto', flex: '0 0 auto' }}>Re-link</button>)}
                  <button
                    type="button"
                    className="settings-icon-btn"
                    aria-label="Copy MCP endpoint URL"
                    title={copiedSlug === slug ? 'Copied' : 'Copy MCP endpoint URL'}
                    disabled={disabled}
                    onClick={() => copyUrl(slug, url)}
                    data-copied={copiedSlug === slug ? 'true' : undefined}
                  >
                    {copiedSlug === slug ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    )}
                  </button>
                </div>
                {aliasUrl && (<p className="setting-description" style={{ marginTop: '0.4rem' }}>Default alias: <code>{aliasUrl}</code></p>)}
              </div>
            </div>
          )
        })()}

        {activeTab === 'this-account-groups' && (
          <div className="groups-tab">
            <div className="settings-section-header"><h3>Group Visibility</h3></div>
            <p className="tab-description">Turning off a chat hides it from this account's MCP operations. Messages are still synced in the background, so re-enabling restores full history.</p>
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

        {activeTab === 'this-account-logs' && (
          <div>
            <div className="settings-section-header"><h3>Logs</h3></div>
            <LogsViewer slug={slug} />
          </div>
        )}

        {activeTab === 'this-account-logoff' && (
          <div>
            <div className="settings-section-header"><h3>Log-off</h3></div>
            <div className="action-group" style={{ marginTop: '1rem' }}><h5>Re-link WhatsApp</h5><p>Clear this account's WhatsApp session and scan a new QR code. Messages are preserved.</p><button className="action-btn" onClick={handleRelinkWhatsApp}>Re-link WhatsApp</button></div>
            <div className="action-group" style={{ marginTop: '1.5rem' }}><h5>Remove account</h5><p>Permanently remove this account. This logs out of WhatsApp on this device and clears all local data for this account. {accounts.length <= 1 && (<em>You can&apos;t remove the last account.</em>)}</p><button className="action-btn danger" onClick={() => handleRemoveAccount(slug)} disabled={accounts.length <= 1}>Remove account</button></div>
          </div>
        )}

        {activeTab === 'app-accounts' && (
          <AccountsTabBody
            accounts={accounts}
            selectedSlug={slug}
            defaultSlug={defaultSlug}
            statusByAccount={statusByAccount}
            renameSlug={renameSlug}
            renameValue={renameValue}
            renameError={renameError}
            onRenameValueChange={(v) => { setRenameValue(v); setRenameError(null) }}
            onSubmitRename={() => void submitRename()}
            onCancelRename={cancelRename}
            onStartRename={startRename}
            onSetDefault={handleSetDefault}
            onRemoveAccount={handleRemoveAccount}
            onAddAccount={onAddAccount}
          />
        )}

        {activeTab === 'app-mcp' && (
          <div>
            <div className="settings-section-header"><h3>MCP Server</h3></div>
            <div className="setting-item">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: mcpStatus.status === 'running' ? 'hsl(var(--success, 142 76% 36%))' : mcpStatus.status === 'port_conflict' ? 'hsl(var(--warning, 45 93% 47%))' : mcpStatus.status === 'error' ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))' }} />
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>
                  {mcpStatus.status === 'running' ? 'Running' : mcpStatus.status === 'starting' ? 'Starting…' : mcpStatus.status === 'port_conflict' ? 'Port in use' : mcpStatus.status === 'error' ? 'Error' : 'Stopped'}
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
              <p className="setting-description">Restart required to apply changes.</p>
            </div>
            <div className="setting-item" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 500, fontSize: '0.95rem' }}>Auto-start MCP server</span>
              <label className="toggle-switch"><input type="checkbox" checked={mcpAutoStart} onChange={handleMcpAutoStartChange} /><span className="slider"></span></label>
            </div>

            <div className="mcp-url-list" style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid hsl(var(--border))' }} data-testid="mcp-all-endpoints">
              <h4 style={{ marginBottom: '0.5rem' }}>All endpoints</h4>
              <p className="setting-description" style={{ marginBottom: '0.75rem' }}>Every account&apos;s MCP URL. The default account is also served at the bare <code>/mcp</code> alias.</p>
              {accounts.length === 0 ? (
                <p style={{ fontSize: '0.85rem', color: 'hsl(var(--muted-foreground))' }}>No accounts configured.</p>
              ) : (
                <>
                  {accounts.map((a) => {
                    const aInfo = mcpUrls[a.slug]
                    const aPath = aInfo?.path || `/mcp/${a.slug}`
                    const aUrl = `http://localhost:${mcpStatus.port}${aPath}`
                    return (
                      <div key={a.slug} className="mcp-url-row" data-slug={a.slug} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.6rem', borderRadius: '0.375rem', border: '1px solid hsl(var(--border))', marginBottom: '0.4rem' }}>
                        <strong style={{ fontSize: '0.85rem', minWidth: '6rem' }}>{a.slug}</strong>
                        <code style={{ fontSize: '0.85rem', color: 'hsl(var(--foreground))', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{aUrl}</code>
                        <button
                          type="button"
                          className="settings-icon-btn"
                          aria-label="Copy MCP endpoint URL"
                          title={copiedSlug === a.slug ? 'Copied' : 'Copy MCP endpoint URL'}
                          onClick={() => copyUrl(a.slug, aUrl)}
                          data-copied={copiedSlug === a.slug ? 'true' : undefined}
                        >
                          {copiedSlug === a.slug ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                          )}
                        </button>
                      </div>
                    )
                  })}
                  {defaultSlug && (
                    <div className="mcp-url-row" data-slug="__alias__" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.6rem', borderRadius: '0.375rem', border: '1px dashed hsl(var(--border))', marginBottom: '0.4rem' }}>
                      <strong style={{ fontSize: '0.85rem', minWidth: '6rem' }}>/mcp</strong>
                      <code style={{ fontSize: '0.85rem', color: 'hsl(var(--foreground))', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{`http://localhost:${mcpStatus.port}/mcp`}</code>
                      <button
                        type="button"
                        className="settings-icon-btn"
                        aria-label="Copy MCP endpoint URL"
                        title={copiedSlug === '__alias__' ? 'Copied' : 'Copy MCP endpoint URL'}
                        onClick={() => copyUrl('__alias__', `http://localhost:${mcpStatus.port}/mcp`)}
                        data-copied={copiedSlug === '__alias__' ? 'true' : undefined}
                      >
                        {copiedSlug === '__alias__' ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                        )}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {activeTab === 'app-system' && (
          <div>
            <div className="settings-section-header"><h3>System</h3></div>
            <div className="setting-item" style={{ marginTop: '1rem', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontWeight: 500, fontSize: '0.95rem' }}>Launch on startup</span><label className="toggle-switch"><input type="checkbox" checked={autoLaunch} onChange={handleAutoLaunchChange} /><span className="slider"></span></label></div>
            <h4 className="settings-subheading" data-testid="system-updates-subheading" style={{ marginTop: '1.5rem' }}>Updates</h4>
            <div className="setting-item">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.875rem' }}>Current version: <strong>v{appVersion}</strong></span>
                {updateStatus.status === 'downloaded' && updateStatus.version && (
                  <span style={{ fontSize: '0.75rem', color: 'hsl(var(--success, 142 76% 36%))' }}>v{updateStatus.version} ready to install</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                {updateStatus.status === 'downloaded' ? (
                  <button className="action-btn" onClick={handleQuitAndInstall} style={{ backgroundColor: 'hsl(var(--success, 142 76% 36%))', color: 'white' }}>Restart Now</button>
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
        )}
      </div></div>
      <div className="settings-footer">
        <div className="settings-footer-left"><strong>WhatsApp MCP Server</strong><span>v{appVersion}</span></div>
        <div className="settings-footer-right"><a href="https://github.com/panghy/whatsapp-mcp-server/issues" className="settings-footer-link" target="_blank" rel="noopener noreferrer">Help</a><span className="settings-footer-divider">•</span><a href="https://github.com/panghy/whatsapp-mcp-server" className="settings-footer-link" target="_blank" rel="noopener noreferrer">About</a></div>
      </div>
      <div className="settings-disclaimer">
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
  renameSlug: string | null
  renameValue: string
  renameError: string | null
  onRenameValueChange: (value: string) => void
  onSubmitRename: () => void
  onCancelRename: () => void
  onStartRename: (slug: string) => void
  onSetDefault: (slug: string) => void
  onRemoveAccount: (slug: string) => void
  onAddAccount?: () => void
}

export function AccountsTabBody({
  accounts, selectedSlug, defaultSlug, statusByAccount,
  renameSlug, renameValue, renameError,
  onRenameValueChange, onSubmitRename, onCancelRename, onStartRename,
  onSetDefault, onRemoveAccount, onAddAccount,
}: AccountsTabBodyProps) {
  return (
    <div>
      <div className="settings-section-header"><h3>Accounts</h3></div>
      {onAddAccount && (
        <div className="settings-add-account-row">
          <button className="settings-link-btn" data-testid="settings-add-account-btn" onClick={onAddAccount}>+ Add account</button>
        </div>
      )}
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
                    <strong style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
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
                      <span
                        className="account-state-pill"
                        data-testid={`state-pill-${a.slug}`}
                        data-state={st?.state ?? 'disconnected'}
                        style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '2px 6px', borderRadius: '9999px', color: 'white', fontWeight: 600, backgroundColor: st?.state === 'connected' ? 'hsl(var(--success))' : st?.state === 'connecting' ? 'hsl(var(--warning))' : st?.state === 'error' ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))' }}
                      >
                        {getAccountStateLabel(st)}
                      </span>
                    </strong>
                    <div className="account-row-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
                      <button className="action-btn" data-testid={`make-default-${a.slug}`} onClick={() => onSetDefault(a.slug)} disabled={isDefault} style={{ padding: '4px 8px', fontSize: '0.75rem', width: 'auto' }} title="Make this the default account; MCP clients pointed at /mcp will route here.">Make default</button>
                      <button className="action-btn" onClick={() => onStartRename(a.slug)} style={{ padding: '4px 8px', fontSize: '0.75rem', width: 'auto' }}>Rename</button>
                      <button className="action-btn danger" onClick={() => onRemoveAccount(a.slug)} disabled={accounts.length <= 1} style={{ padding: '4px 8px', fontSize: '0.75rem', width: 'auto', color: 'white' }}>Remove</button>
                    </div>
                  </>
                )}
              </div>
              {editing && renameError && (<p style={{ fontSize: '0.75rem', color: 'hsl(var(--destructive))', margin: 0 }}>{renameError}</p>)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
