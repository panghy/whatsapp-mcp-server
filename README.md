# WhatsApp MCP Server

An Electron desktop app that connects to WhatsApp, syncs messages to a local SQLite database, and exposes them through a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server. Enables AI assistants to read and send WhatsApp messages.

## ⚠️ Disclaimer

**This software is provided as-is, without warranty of any kind.** By using this software, you acknowledge and accept the following:

- This project uses [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial, reverse-engineered WhatsApp Web API**. It is **not endorsed, supported, or affiliated with WhatsApp or Meta** in any way.
- **Using unofficial WhatsApp clients may violate WhatsApp's Terms of Service** and could result in your account being **temporarily or permanently banned**.
- The authors are not responsible for any account bans, data loss, or other consequences resulting from the use of this software.
- Use this software **at your own risk** and preferably with a secondary phone number.

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## Features

- **WhatsApp Connection** — Connect via QR code scan, just like WhatsApp Web
- **Automatic Message Syncing** — Messages sync to a local SQLite database
- **MCP Server** — Exposes messages through MCP on a configurable port (default 13491)
- **Group Visibility Controls** — Hide specific chats from MCP access
- **Auto-Updates** — Automatically downloads and installs updates
- **Cross-Platform** — Available for macOS, Windows, and Linux

## Installation

### macOS

Download the latest `.dmg` from the [Releases page](https://github.com/panghy/whatsapp-mcp-server/releases).

1. Open the DMG file
2. Drag the app to your Applications folder
3. Launch from Applications

The app is signed and notarized by Apple.

### Windows

Download the latest installer (`.exe`) from the [Releases page](https://github.com/panghy/whatsapp-mcp-server/releases).

Run the installer and follow the prompts.

### Linux

Download the latest `.AppImage` from the [Releases page](https://github.com/panghy/whatsapp-mcp-server/releases).

```bash
chmod +x WhatsApp*.AppImage
./WhatsApp*.AppImage
```

## Getting Started

1. Launch the app
2. Enter your name when prompted
3. Scan the QR code with WhatsApp on your phone (Settings → Linked Devices → Link a Device)
4. Messages will begin syncing automatically

## MCP Server

The app runs an MCP server at `http://localhost:13491/mcp` (port configurable in Settings).

### Available Tools

| Tool | Description |
| --- | --- |
| search_chats | Search chats by phone number or name fragment |
| get_chat_history | Get messages for a specific chat by JID |
| get_recent_messages | Get messages across all chats since a timestamp |
| get_unread_messages | Get unread/new messages across all chats |
| send_message | Send a text message (with optional attachment) to a chat |

### Connecting from AI Assistants

Add to your MCP client configuration (e.g., Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "whatsapp": {
      "url": "http://localhost:13491/mcp"
    }
  }
}
```

### Health Check

A health endpoint is available at `http://localhost:13491/health` to verify the server is running.

## Auto-Updates

The app checks for updates on launch and automatically downloads new versions. Updates are installed when you quit the app.

## Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
git clone https://github.com/panghy/whatsapp-mcp-server.git
cd whatsapp-mcp-server
npm install
npm run dev
```

### Build

```bash
npm run build
```

### Type Check

```bash
npx tsc --noEmit
```

## License

MIT License — see [LICENSE](LICENSE) file.