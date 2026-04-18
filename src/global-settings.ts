import Settings from 'electron-settings'

// Global MCP configuration lives in electron-settings (not in any account's
// SQLite settings table). These are app-wide keys shared across all accounts.
const MCP_PORT_KEY = 'mcp_port'
const MCP_AUTO_START_KEY = 'mcp_auto_start'

export const DEFAULT_MCP_PORT = 13491
export const DEFAULT_MCP_AUTO_START = true

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

