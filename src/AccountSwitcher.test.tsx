import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountSwitcher from './AccountSwitcher'
import type { Account, WhatsAppStatus } from './types'

function mkAccount(slug: string, mcpEnabled = true): Account {
  return { slug, mcpEnabled }
}

function render(props: React.ComponentProps<typeof AccountSwitcher>): string {
  return renderToStaticMarkup(createElement(AccountSwitcher, props))
}

describe('AccountSwitcher — default marker', () => {
  const accounts: Account[] = [mkAccount('primary'), mkAccount('secondary'), mkAccount('tertiary')]
  const statusByAccount: Record<string, WhatsAppStatus | undefined> = {}

  it('marks only the defaultSlug account (not the selectedSlug)', () => {
    const html = render({
      accounts,
      selectedSlug: 'secondary',
      defaultSlug: 'primary',
      statusByAccount,
      onSelect: () => {},
      onAdd: () => {},
    })
    // Default marker class appears exactly once and is on the primary pill.
    const markerMatches = html.match(/account-default-marker/g) || []
    expect(markerMatches.length).toBe(1)

    // The primary pill carries the is-default class; secondary/tertiary do not.
    expect(html).toContain('account-pill  is-default')
    const primarySection = html.slice(html.indexOf('primary'))
    expect(primarySection).toContain('account-default-marker')

    // The secondary pill is the "active" one (selected) but has no default marker.
    expect(html).toContain('account-pill active')
    const secondaryIdx = html.indexOf('>secondary<')
    expect(secondaryIdx).toBeGreaterThan(-1)
    // Make sure there's no default marker between "secondary" pill start and its close.
    const secondaryEnd = html.indexOf('</button>', secondaryIdx)
    const secondaryPill = html.slice(secondaryIdx, secondaryEnd)
    expect(secondaryPill).not.toContain('account-default-marker')
  })

  it('does not mark any pill when defaultSlug is null', () => {
    const html = render({
      accounts,
      selectedSlug: 'primary',
      defaultSlug: null,
      statusByAccount,
      onSelect: () => {},
      onAdd: () => {},
    })
    expect(html).not.toContain('account-default-marker')
    expect(html).not.toContain('is-default')
  })

  it('tooltip on the default pill explains /mcp routing', () => {
    const html = render({
      accounts,
      selectedSlug: 'secondary',
      defaultSlug: 'primary',
      statusByAccount,
      onSelect: () => {},
      onAdd: () => {},
    })
    expect(html).toContain('MCP clients pointed at /mcp route to this account.')
  })
})

