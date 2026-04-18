// Pure helpers for account slugs and MCP URL construction.
// Kept out of accounts.ts so the renderer can import without pulling in
// better-sqlite3/electron.

// Slug charset: 1 lowercase letter, or 2-32 chars starting with a letter,
// ending with letter/digit, body may contain letter/digit/hyphen.
export const SLUG_REGEX = /^(?:[a-z]|[a-z][a-z0-9-]{0,30}[a-z0-9])$/

export function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_REGEX.test(slug)
}

export function describeSlugRules(): string {
  return 'Lowercase letters, digits, hyphens. Must start with a letter and end with a letter or digit. 1-32 characters.'
}

export function validateSlug(
  slug: string,
  existingSlugs: readonly string[] = []
): string | null {
  if (!slug) return 'Slug is required.'
  if (!isValidSlug(slug)) return describeSlugRules()
  if (existingSlugs.includes(slug)) return 'An account with this slug already exists.'
  return null
}

export function buildMcpUrl(port: number, path: string): string {
  const safePort = Number.isInteger(port) && port > 0 ? port : 13491
  const safePath = path.startsWith('/') ? path : `/${path}`
  return `http://localhost:${safePort}${safePath}`
}

export function accountMcpPath(slug: string): string {
  return `/mcp/${slug}`
}

