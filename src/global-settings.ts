import Settings from 'electron-settings'

// Global MCP configuration lives in electron-settings (not in any account's
// SQLite settings table). These are app-wide keys shared across all accounts.
const MCP_PORT_KEY = 'mcp_port'
const MCP_AUTO_START_KEY = 'mcp_auto_start'
const MEDIA_INLINE_MAX_BYTES_KEY = 'media_inline_max_bytes'

export const DEFAULT_MCP_PORT = 13491
export const DEFAULT_MCP_AUTO_START = true
export const DEFAULT_MEDIA_INLINE_MAX_BYTES = 25 * 1024 * 1024 // 25MB

export function getMcpPort(): number {
  const v = Settings.getSync(MCP_PORT_KEY)
  return typeof v === 'number' ? v : DEFAULT_MCP_PORT
}

export function setMcpPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP port: ${port}`)
  }
  Settings.setSync(MCP_PORT_KEY, port)
}

export function getMcpAutoStart(): boolean {
  const v = Settings.getSync(MCP_AUTO_START_KEY)
  return typeof v === 'boolean' ? v : DEFAULT_MCP_AUTO_START
}

export function setMcpAutoStart(enabled: boolean): void {
  Settings.setSync(MCP_AUTO_START_KEY, enabled)
}

// Effective default cap for inline `get_message_media` payloads. Over this
// limit the tool returns a host file path / resource_link instead of base64.
// The per-call `maxInlineBytes` argument overrides this when provided.
export function getMediaInlineMaxBytes(): number {
  const v = Settings.getSync(MEDIA_INLINE_MAX_BYTES_KEY)
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_MEDIA_INLINE_MAX_BYTES
}

export function setMediaInlineMaxBytes(bytes: number): void {
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new Error(`Invalid media inline max bytes: ${bytes}`)
  }
  Settings.setSync(MEDIA_INLINE_MAX_BYTES_KEY, bytes)
}

