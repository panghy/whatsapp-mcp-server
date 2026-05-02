import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Settings, {
  AccountsTabBody,
  buildRemoveAccountMessage,
  getAccountStateLabel,
  makeAccountSelectChangeHandler,
  performAccountRemoval,
  sortGroupsByLastActivity,
} from './Settings'
import type { Account, WhatsAppStatus } from './types'

function mkAccount(slug: string, mcpEnabled = true): Account {
  return { slug, mcpEnabled }
}

function render(overrides: Partial<React.ComponentProps<typeof AccountsTabBody>> = {}): string {
  const defaults: React.ComponentProps<typeof AccountsTabBody> = {
    accounts: [mkAccount('alpha'), mkAccount('beta'), mkAccount('gamma')],
    selectedSlug: 'alpha',
    defaultSlug: 'alpha',
    statusByAccount: {} as Record<string, WhatsAppStatus>,
    renameSlug: null,
    renameValue: '',
    renameError: null,
    onRenameValueChange: () => {},
    onSubmitRename: () => {},
    onCancelRename: () => {},
    onStartRename: () => {},
    onSetDefault: () => {},
    onRemoveAccount: () => {},
  }
  return renderToStaticMarkup(createElement(AccountsTabBody, { ...defaults, ...overrides }))
}

function extractRow(html: string, slug: string): string {
  const start = html.indexOf(`data-slug="${slug}"`)
  if (start === -1) return ''
  const end = html.indexOf('data-slug=', start + 1)
  return end === -1 ? html.slice(start) : html.slice(start, end)
}

describe('Settings AccountsTabBody', () => {
  it('renders the Default badge only on the defaultSlug row', () => {
    const html = render({ selectedSlug: 'beta', defaultSlug: 'alpha' })

    const badgeMatches = html.match(/data-testid="default-badge"/g) || []
    expect(badgeMatches.length).toBe(1)

    expect(extractRow(html, 'alpha')).toContain('data-testid="default-badge"')
    expect(extractRow(html, 'beta')).not.toContain('data-testid="default-badge"')
    expect(extractRow(html, 'gamma')).not.toContain('data-testid="default-badge"')
  })

  it('badge follows defaultSlug, NOT selectedSlug', () => {
    // Viewing beta but default is gamma — badge must appear on gamma.
    const html = render({ selectedSlug: 'beta', defaultSlug: 'gamma' })
    expect(extractRow(html, 'gamma')).toContain('data-testid="default-badge"')
    expect(extractRow(html, 'beta')).not.toContain('data-testid="default-badge"')
    expect(extractRow(html, 'alpha')).not.toContain('data-testid="default-badge"')
  })

  it('"Make default" is disabled only on the defaultSlug row (regardless of which slug is selected)', () => {
    const html = render({ selectedSlug: 'alpha', defaultSlug: 'beta' })
    const alphaBtn = extractRow(html, 'alpha')
    const betaBtn = extractRow(html, 'beta')
    const gammaBtn = extractRow(html, 'gamma')

    // Alpha is the currently-viewed row but NOT default — button must NOT be disabled.
    expect(alphaBtn).toMatch(/data-testid="make-default-alpha"[^>]*>Make default/)
    expect(alphaBtn).not.toMatch(/data-testid="make-default-alpha"[^>]*disabled/)

    // Beta is the default — button MUST be disabled.
    expect(betaBtn).toMatch(/data-testid="make-default-beta"[^>]*disabled/)

    // Gamma is neither viewed nor default — must NOT be disabled.
    expect(gammaBtn).not.toMatch(/data-testid="make-default-gamma"[^>]*disabled/)
  })

  it('renders the inline explainer paragraph above the accounts list', () => {
    const html = render()
    expect(html).toContain('data-testid="default-explainer"')
    expect(html).toContain('The default account is also served at the bare')
    expect(html).toContain('/mcp')
    expect(html).toContain('does not change the default')
    const explainerIdx = html.indexOf('data-testid="default-explainer"')
    const listIdx = html.indexOf('class="accounts-list"')
    expect(explainerIdx).toBeGreaterThan(-1)
    expect(listIdx).toBeGreaterThan(explainerIdx)
  })

  it('highlights the currently-viewed row via background only (no "viewing" or "active" label)', () => {
    const html = render({ selectedSlug: 'beta', defaultSlug: 'alpha' })
    const betaRow = extractRow(html, 'beta')
    const alphaRow = extractRow(html, 'alpha')
    // Row is still identifiable by data-slug.
    expect(betaRow).toContain('data-slug="beta"')
    // Currently-viewed row gets the muted background highlight; non-viewed rows do not.
    expect(betaRow).toContain('hsl(var(--muted) / 0.4)')
    expect(alphaRow).toContain('background-color:transparent')
    // No "viewing" or "active" text labels anywhere.
    expect(html).not.toMatch(/>viewing</)
    expect(html).not.toMatch(/>active</)
  })

  it('renders no Default badge when defaultSlug is null', () => {
    const html = render({ defaultSlug: null })
    expect(html).not.toContain('data-testid="default-badge"')
  })

  it('renders a state pill per row with the correct label for each state', () => {
    const statusByAccount: Record<string, WhatsAppStatus> = {
      alpha: { state: 'connected', qrCode: null, error: null },
      beta: { state: 'connecting', qrCode: null, error: null },
      gamma: { state: 'error', qrCode: null, error: 'boom' },
    }
    const html = render({ statusByAccount })
    expect(extractRow(html, 'alpha')).toMatch(/data-testid="state-pill-alpha"[^>]*data-state="connected"[^>]*>Connected</)
    expect(extractRow(html, 'beta')).toMatch(/data-testid="state-pill-beta"[^>]*data-state="connecting"[^>]*>Connecting/)
    expect(extractRow(html, 'gamma')).toMatch(/data-testid="state-pill-gamma"[^>]*data-state="error"[^>]*>Error</)
  })

  it('defaults the state pill to Disconnected when no status is known', () => {
    const html = render({ statusByAccount: {} })
    expect(extractRow(html, 'alpha')).toMatch(/data-testid="state-pill-alpha"[^>]*data-state="disconnected"[^>]*>Disconnected</)
  })

  it('disables the Remove button when only one account remains', () => {
    const html = render({ accounts: [mkAccount('solo')], selectedSlug: 'solo', defaultSlug: 'solo' })
    const row = extractRow(html, 'solo')
    expect(row).toMatch(/<button[^>]*disabled[^>]*>Remove</)
  })

  it('leaves the Remove button enabled when multiple accounts exist', () => {
    const html = render()
    const row = extractRow(html, 'alpha')
    // Match the Remove button element, ensure `disabled` isn't one of its attributes.
    const match = row.match(/<button[^>]*>Remove<\/button>/)
    expect(match).not.toBeNull()
    expect(match![0]).not.toContain('disabled')
  })

  it('omits the "Add account" button when no onAddAccount handler is provided', () => {
    const html = render()
    expect(html).not.toContain('data-testid="settings-add-account-btn"')
  })

  it('renders an "Add account" button at the top of the section when onAddAccount is provided', () => {
    const onAddAccount = () => {}
    const html = render({ onAddAccount })
    expect(html).toContain('data-testid="settings-add-account-btn"')
    // The Add-account row sits above the accounts list.
    const addBtnIdx = html.indexOf('data-testid="settings-add-account-btn"')
    const listIdx = html.indexOf('class="accounts-list"')
    expect(addBtnIdx).toBeGreaterThan(-1)
    expect(listIdx).toBeGreaterThan(addBtnIdx)
  })

  it('renders an Accounts heading inside the section header', () => {
    const html = render()
    expect(html).toMatch(/<h3>Accounts<\/h3>/)
  })
})

describe('getAccountStateLabel', () => {
  it('maps each ConnectionState to its pill label', () => {
    expect(getAccountStateLabel({ state: 'connected', qrCode: null, error: null })).toBe('Connected')
    expect(getAccountStateLabel({ state: 'connecting', qrCode: null, error: null })).toBe('Connecting…')
    expect(getAccountStateLabel({ state: 'disconnected', qrCode: null, error: null })).toBe('Disconnected')
    expect(getAccountStateLabel({ state: 'error', qrCode: null, error: 'x' })).toBe('Error')
  })

  it('falls back to Disconnected when the status is undefined', () => {
    expect(getAccountStateLabel(undefined)).toBe('Disconnected')
  })
})

describe('performAccountRemoval', () => {
  const makeDeps = (overrides: Partial<Parameters<typeof performAccountRemoval>[2]> = {}) => ({
    confirm: overrides.confirm ?? (() => true),
    whatsappLogout: overrides.whatsappLogout ?? vi.fn(async () => ({ success: true })),
    accountsRemove: overrides.accountsRemove ?? vi.fn(async () => ({ success: true })),
  })

  it('uses the Wave 3 confirm wording', () => {
    const message = buildRemoveAccountMessage('alpha')
    expect(message).toContain('Remove account "alpha"')
    expect(message).toContain('log out of WhatsApp on this device')
    expect(message).toContain('clear all local data for this account')
    expect(message).toContain('cannot be undone')
  })

  it('no-ops and returns cancelled when the user declines the confirm', async () => {
    const deps = makeDeps({ confirm: () => false })
    const result = await performAccountRemoval('alpha', 'connected', deps)
    expect(result).toEqual({ ok: false, cancelled: true })
    expect(deps.whatsappLogout).not.toHaveBeenCalled()
    expect(deps.accountsRemove).not.toHaveBeenCalled()
  })

  it('calls whatsappLogout before accountsRemove for a connected account', async () => {
    const order: string[] = []
    const whatsappLogout = vi.fn(async () => { order.push('logout'); return { success: true } })
    const accountsRemove = vi.fn(async () => { order.push('remove'); return { success: true } })
    const deps = makeDeps({ whatsappLogout, accountsRemove })
    const result = await performAccountRemoval('alpha', 'connected', deps)
    expect(result).toEqual({ ok: true })
    expect(order).toEqual(['logout', 'remove'])
    expect(whatsappLogout).toHaveBeenCalledWith('alpha')
    expect(accountsRemove).toHaveBeenCalledWith('alpha')
  })

  it('also logs out first for a connecting account', async () => {
    const deps = makeDeps()
    await performAccountRemoval('beta', 'connecting', deps)
    expect(deps.whatsappLogout).toHaveBeenCalledWith('beta')
    expect(deps.accountsRemove).toHaveBeenCalledWith('beta')
  })

  it('skips the logout step when the account is already disconnected', async () => {
    const deps = makeDeps()
    const result = await performAccountRemoval('gamma', 'disconnected', deps)
    expect(result).toEqual({ ok: true })
    expect(deps.whatsappLogout).not.toHaveBeenCalled()
    expect(deps.accountsRemove).toHaveBeenCalledWith('gamma')
  })

  it('skips the logout step when the state is unknown (undefined)', async () => {
    const deps = makeDeps()
    await performAccountRemoval('delta', undefined, deps)
    expect(deps.whatsappLogout).not.toHaveBeenCalled()
    expect(deps.accountsRemove).toHaveBeenCalledWith('delta')
  })

  it('surfaces a logout failure and does not proceed to remove', async () => {
    const whatsappLogout = vi.fn(async () => { throw new Error('boom-logout') })
    const accountsRemove = vi.fn(async () => ({ success: true }))
    const deps = makeDeps({ whatsappLogout, accountsRemove })
    const result = await performAccountRemoval('alpha', 'connected', deps)
    expect(result).toEqual({ ok: false, error: 'boom-logout' })
    expect(accountsRemove).not.toHaveBeenCalled()
  })

  it('surfaces a remove failure', async () => {
    const accountsRemove = vi.fn(async () => { throw new Error('still-connected') })
    const deps = makeDeps({ accountsRemove })
    const result = await performAccountRemoval('beta', 'disconnected', deps)
    expect(result).toEqual({ ok: false, error: 'still-connected' })
  })

  it('falls back to a generic message when a non-Error value is thrown', async () => {
    const whatsappLogout = vi.fn(async () => { throw 'str-error' })
    const deps = makeDeps({ whatsappLogout })
    const result = await performAccountRemoval('alpha', 'connected', deps)
    expect(result).toEqual({ ok: false, error: 'Failed to log out' })
  })
})

describe('sortGroupsByLastActivity', () => {
  type G = { id: number; last_activity: string | null }

  it('sorts groups by last_activity descending', () => {
    const input: G[] = [
      { id: 1, last_activity: '2025-01-01T00:00:00Z' },
      { id: 2, last_activity: '2026-04-01T00:00:00Z' },
      { id: 3, last_activity: '2025-06-15T12:00:00Z' },
    ]
    expect(sortGroupsByLastActivity(input).map(g => g.id)).toEqual([2, 3, 1])
  })

  it('places null last_activity entries at the end, preserving their input order', () => {
    const input: G[] = [
      { id: 1, last_activity: null },
      { id: 2, last_activity: '2026-04-01T00:00:00Z' },
      { id: 3, last_activity: null },
      { id: 4, last_activity: '2025-01-01T00:00:00Z' },
      { id: 5, last_activity: null },
    ]
    expect(sortGroupsByLastActivity(input).map(g => g.id)).toEqual([2, 4, 1, 3, 5])
  })

  it('places unparseable last_activity entries at the end', () => {
    const input: G[] = [
      { id: 1, last_activity: 'not-a-date' },
      { id: 2, last_activity: '2026-04-01T00:00:00Z' },
      { id: 3, last_activity: 'also bogus' },
    ]
    expect(sortGroupsByLastActivity(input).map(g => g.id)).toEqual([2, 1, 3])
  })

  it('is stable for equal timestamps', () => {
    const ts = '2026-04-01T00:00:00Z'
    const input: G[] = [
      { id: 1, last_activity: ts },
      { id: 2, last_activity: ts },
      { id: 3, last_activity: ts },
    ]
    expect(sortGroupsByLastActivity(input).map(g => g.id)).toEqual([1, 2, 3])
  })

  it('does not mutate the input array', () => {
    const input: G[] = [
      { id: 1, last_activity: '2025-01-01T00:00:00Z' },
      { id: 2, last_activity: '2026-04-01T00:00:00Z' },
      { id: 3, last_activity: null },
    ]
    const snapshot = input.map(g => g.id)
    const result = sortGroupsByLastActivity(input)
    expect(input.map(g => g.id)).toEqual(snapshot)
    expect(result).not.toBe(input)
  })

  it('returns a new array even when input is already sorted', () => {
    const input: G[] = [{ id: 1, last_activity: '2026-04-01T00:00:00Z' }]
    const result = sortGroupsByLastActivity(input)
    expect(result).not.toBe(input)
    expect(result.map(g => g.id)).toEqual([1])
  })
})

describe('Settings sidebar', () => {
  function renderSidebar(overrides: Partial<React.ComponentProps<typeof Settings>> = {}): string {
    const defaults: React.ComponentProps<typeof Settings> = {
      slug: 'alpha',
      accounts: [{ slug: 'alpha', mcpEnabled: true }, { slug: 'beta', mcpEnabled: true }],
      defaultSlug: 'alpha',
      statusByAccount: {
        alpha: { state: 'connected', qrCode: null, error: null },
        beta: { state: 'disconnected', qrCode: null, error: null },
      },
      onAccountsChanged: () => {},
    }
    return renderToStaticMarkup(createElement(Settings, { ...defaults, ...overrides }))
  }

  it('does not render a "This account — slug" group header', () => {
    const html = renderSidebar()
    expect(html).not.toContain('This account — alpha')
    expect(html).not.toMatch(/This account — [a-z]+/)
  })

  it('renders the Application group header', () => {
    const html = renderSidebar()
    expect(html).toContain('>Application<')
  })

  it('renders the dropdown selector with one option per account', () => {
    const html = renderSidebar()
    expect(html).toContain('data-testid="settings-account-select"')
    expect(html).toMatch(/aria-label="Select account to configure"/)
    // Two accounts → two options.
    const optionMatches = html.match(/<option /g) || []
    expect(optionMatches.length).toBe(2)
  })

  it('marks the default account with a "(default)" suffix in its option label', () => {
    const html = renderSidebar()
    expect(html).toMatch(/<option[^>]*value="alpha"[^>]*>alpha \(default\) — connected<\/option>/)
    expect(html).toMatch(/<option[^>]*value="beta"[^>]*>beta — disconnected<\/option>/)
  })

  it('includes a connection-state suffix per option', () => {
    const html = renderSidebar({
      statusByAccount: {
        alpha: { state: 'connecting', qrCode: null, error: null },
        beta: { state: 'error', qrCode: null, error: 'x' },
      },
    })
    expect(html).toContain('alpha (default) — connecting')
    expect(html).toContain('beta — error')
  })

  it('selects the current slug in the dropdown', () => {
    const html = renderSidebar({ slug: 'beta' })
    // React SSR adds `selected` on the matching option element.
    expect(html).toMatch(/<option value="beta" selected/)
    expect(html).not.toMatch(/<option value="alpha" selected/)
  })

  it('renders the "Log-off" nav button under the This-account group', () => {
    const html = renderSidebar()
    expect(html).toMatch(/data-section="this-account-logoff"[^>]*>[^<]*Log-off/)
    // Old section ID and label must not appear anywhere.
    expect(html).not.toMatch(/this-account-dan[g]er/)
    expect(html).not.toMatch(/Dan[g]er zone/)
  })

  it('renders the Log-off nav button without the destructive (danger) accent', () => {
    const html = renderSidebar()
    const match = html.match(/<button[^>]*data-section="this-account-logoff"[^>]*>/)
    expect(match).not.toBeNull()
    expect(match![0]).not.toMatch(/class="[^"]*\bdanger\b/)
  })

  it('does not render an Endpoint nav button under the This-account group', () => {
    const html = renderSidebar()
    expect(html).not.toMatch(/data-section="this-account-endpoint"/)
    expect(html).not.toMatch(/<button[^>]*data-section="[^"]*"[^>]*>Endpoint</)
  })

  it('does not render an Updates nav button under Application', () => {
    const html = renderSidebar()
    expect(html).not.toMatch(/data-section="app-updates"/)
    // No top-level "Updates" nav button label in the sidebar nav.
    expect(html).not.toMatch(/<button[^>]*data-section="[^"]*"[^>]*>Updates<\/button>/)
  })

  it('dropdown onChange invokes onSelectAccount with the picked slug', () => {
    // No jsdom is configured, so the dropdown's onChange wiring is extracted to
    // makeAccountSelectChangeHandler and exercised directly with a synthetic event.
    const onSelectAccount = vi.fn()
    const handler = makeAccountSelectChangeHandler(onSelectAccount)
    handler({ target: { value: 'beta' } })
    expect(onSelectAccount).toHaveBeenCalledTimes(1)
    expect(onSelectAccount).toHaveBeenCalledWith('beta')
  })
})

describe('Settings Profile tab', () => {
  function renderProfile(): string {
    return renderToStaticMarkup(createElement(Settings, {
      slug: 'alpha',
      accounts: [{ slug: 'alpha', mcpEnabled: true }, { slug: 'beta', mcpEnabled: false }],
      defaultSlug: 'alpha',
      statusByAccount: { alpha: { state: 'connected', qrCode: null, error: null } },
      onAccountsChanged: () => {},
      initialTab: 'this-account-profile' as const,
    }))
  }

  it('renders a plain "Profile" heading without the "— {slug}" suffix', () => {
    const html = renderProfile()
    expect(html).toMatch(/<h3>Profile<\/h3>/)
    expect(html).not.toContain('— alpha')
    expect(html).not.toContain('settings-section-slug')
  })

  it('renders "Your Name" without the "({slug})" repetition', () => {
    const html = renderProfile()
    expect(html).toMatch(/<label[^>]*for="display-name"[^>]*>Your Name<\/label>/)
    expect(html).not.toMatch(/Your Name[^<]*\(alpha\)/)
  })

  it('renders the per-account MCP endpoint URL with a Copy icon button inside Profile', () => {
    const html = renderProfile()
    // MCP Endpoint label and URL live in Profile now.
    expect(html).toMatch(/<label[^>]*for="profile-mcp-url"[^>]*>MCP Endpoint/)
    expect(html).toContain('/mcp/alpha')
    // Copy is now a small icon-only button identified by aria-label, not text.
    expect(html).toMatch(/<button[^>]*aria-label="Copy MCP endpoint URL"/)
    expect(html).toContain('class="settings-icon-btn"')
    // The URL <code> truncates with ellipsis when overflowing.
    expect(html).toMatch(/<code[^>]*id="profile-mcp-url"[^>]*style="[^"]*white-space:nowrap/)
  })
})

describe('Settings MCP Server tab', () => {
  function renderMcp(): string {
    return renderToStaticMarkup(createElement(Settings, {
      slug: 'alpha',
      accounts: [{ slug: 'alpha', mcpEnabled: true }],
      defaultSlug: 'alpha',
      statusByAccount: { alpha: { state: 'connected', qrCode: null, error: null } },
      onAccountsChanged: () => {},
      initialTab: 'app-mcp' as const,
    }))
  }

  it('shows a single status word with no port number in the status row', () => {
    const html = renderMcp()
    // Status row has just a word (Stopped, since no IPC mock returns a running status here).
    expect(html).not.toMatch(/Running on port \d+/)
    expect(html).not.toMatch(/Port \d+ in use/)
  })

  it('uses the short "Restart required to apply changes." hint under the Server Port input', () => {
    const html = renderMcp()
    expect(html).toContain('Restart required to apply changes.')
    expect(html).not.toContain('All accounts share this port and are routed by slug')
  })
})

describe('Settings System tab', () => {
  function renderWithInitialTab(initialTab: 'app-system'): string {
    return renderToStaticMarkup(createElement(Settings, {
      slug: 'alpha',
      accounts: [{ slug: 'alpha', mcpEnabled: true }],
      defaultSlug: 'alpha',
      statusByAccount: { alpha: { state: 'connected', qrCode: null, error: null } },
      onAccountsChanged: () => {},
      initialTab,
    }))
  }

  it('renders an Updates sub-heading inside the System section content', () => {
    const html = renderWithInitialTab('app-system')
    expect(html).toContain('data-testid="system-updates-subheading"')
    expect(html).toMatch(/<h4[^>]*data-testid="system-updates-subheading"[^>]*>Updates<\/h4>/)
  })

  it('renders the Check for Updates button inside the System section', () => {
    const html = renderWithInitialTab('app-system')
    expect(html).toContain('Check for Updates')
    expect(html).toContain('Current version:')
  })
})
