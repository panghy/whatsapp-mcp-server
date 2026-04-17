import { useState } from 'react'
import type { Account, ConnectionState, WhatsAppStatus } from './types'
import { describeSlugRules, validateSlug } from './slug'

export function accountDotColor(
  mcpEnabled: boolean,
  state: ConnectionState | undefined
): string {
  if (!mcpEnabled) return '#f97316'
  switch (state) {
    case 'connected': return 'hsl(var(--success))'
    case 'connecting': return 'hsl(var(--warning))'
    case 'error': return 'hsl(var(--destructive))'
    default: return 'hsl(var(--muted-foreground))'
  }
}

export function accountStatusLabel(
  account: Account,
  status: WhatsAppStatus | undefined
): string {
  if (!account.mcpEnabled) return 'Re-link required'
  if (!status) return 'Disconnected'
  switch (status.state) {
    case 'connected': return 'Connected'
    case 'connecting': return status.qrCode ? 'Waiting for scan' : 'Connecting'
    case 'error': return status.error || 'Error'
    default: return status.hasAuth ? 'Reconnecting' : 'Not linked'
  }
}

interface AccountSwitcherProps {
  accounts: Account[]
  selectedSlug: string
  statusByAccount: Record<string, WhatsAppStatus | undefined>
  onSelect: (slug: string) => void
  onAdd: () => void
}

export default function AccountSwitcher({
  accounts, selectedSlug, statusByAccount, onSelect, onAdd,
}: AccountSwitcherProps) {
  return (
    <div className="account-switcher" role="tablist" aria-label="Accounts">
      <div className="account-switcher-pills">
        {accounts.map((account) => {
          const status = statusByAccount[account.slug]
          const color = accountDotColor(account.mcpEnabled, status?.state)
          const isActive = account.slug === selectedSlug
          return (
            <button
              key={account.slug}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`account-pill ${isActive ? 'active' : ''}`}
              onClick={() => onSelect(account.slug)}
              title={`${account.slug} — ${accountStatusLabel(account, status)}`}
            >
              <span className="account-dot" style={{ backgroundColor: color }} />
              <span className="account-slug">{account.slug}</span>
            </button>
          )
        })}
      </div>
      <button type="button" className="account-add-btn" onClick={onAdd}>
        + Add account
      </button>
    </div>
  )
}

interface AddAccountModalProps {
  existingSlugs: string[]
  onClose: () => void
  onAdded: (account: Account) => void
}

export function AddAccountModal({ existingSlugs, onClose, onAdded }: AddAccountModalProps) {
  const [slug, setSlug] = useState('')
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const touched = slug.length > 0
  const validationError = touched ? validateSlug(slug, existingSlugs) : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const err = validateSlug(slug, existingSlugs)
    if (err || submitting) { setServerError(err); return }
    setSubmitting(true)
    setServerError(null)
    try {
      const account = await window.electron.accounts.add(slug)
      onAdded(account)
    } catch (apiErr) {
      setServerError(apiErr instanceof Error ? apiErr.message : 'Failed to create account')
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add account">
        <h2 className="modal-title">Add account</h2>
        <form onSubmit={handleSubmit}>
          <label htmlFor="new-account-slug" className="modal-label">Account slug</label>
          <input
            id="new-account-slug"
            type="text"
            autoFocus
            value={slug}
            onChange={(e) => { setSlug(e.target.value.toLowerCase()); setServerError(null) }}
            placeholder="e.g. work"
            className="modal-input"
            disabled={submitting}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="modal-hint">
            {describeSlugRules()} Your MCP URL will be <code>/mcp/{slug || '<slug>'}</code>.
          </p>
          {validationError && <p className="modal-error">{validationError}</p>}
          {serverError && !validationError && <p className="modal-error">{serverError}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" disabled={!slug || !!validationError || submitting}>
              {submitting ? 'Adding…' : 'Add account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

