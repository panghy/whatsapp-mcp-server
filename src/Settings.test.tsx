import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountsTabBody } from './Settings'
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
    mcpPort: 13491,
    mcpUrls: {},
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
})

