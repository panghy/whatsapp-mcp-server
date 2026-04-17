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
- **Multiple Accounts** — Run several WhatsApp accounts side-by-side, each with isolated storage and its own MCP endpoint
- **Automatic Message Syncing** — Messages sync to a per-account local SQLite database
- **MCP Server** — Exposes each account through a dedicated path on a single configurable port (default 13491)
- **Group Visibility Controls** — Hide specific chats from MCP access, per account
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
2. On first launch, create an account by choosing a short **slug** (e.g. `personal`). The slug identifies the account and becomes part of its MCP URL.
3. Enter your name when prompted
4. Scan the QR code with WhatsApp on your phone (Settings → Linked Devices → Link a Device)
5. Messages will begin syncing automatically

> **Upgrading from a single-account version?** Your existing data is migrated automatically to an account with the slug `default` on first launch. The legacy `http://localhost:13491/mcp` URL keeps working (see [Migration from older versions](#migration-from-older-versions)).

## MCP Server

The app runs a single MCP HTTP server (port configurable in Settings, default `13491`) and serves each account at its own path:

```
http://localhost:13491/mcp/<slug>
```

For backward compatibility, `http://localhost:13491/mcp` (no slug) is an alias for the **default** account. You can pick which account is the default from Settings → Accounts → "Make default".

If an account is disconnected because the device was removed from the phone, its MCP endpoint responds with HTTP 503 until the account is re-linked. Requests to a non-existent slug return HTTP 404.

### Available Tools

| Tool | Description |
| --- | --- |
| search_chats | Search chats by phone number or name fragment |
| get_chat_history | Get messages for a specific chat by JID |
| get_recent_messages | Get messages across all chats since a timestamp |
| get_unread_messages | Get unread/new messages across all chats |
| send_message | Send a text message (with optional attachment) to a chat |

Each tool operates only on the account whose slug is in the URL path — accounts are fully isolated.

### Connecting from AI Assistants

Add to your MCP client configuration (e.g., Claude Desktop `claude_desktop_config.json`). Use the per-account URL form:

```json
{
  "mcpServers": {
    "whatsapp-personal": {
      "url": "http://localhost:13491/mcp/personal"
    },
    "whatsapp-work": {
      "url": "http://localhost:13491/mcp/work"
    }
  }
}
```

If you only have one account and prefer the short URL, the default-account alias also works:

```json
{
  "mcpServers": {
    "whatsapp": {
      "url": "http://localhost:13491/mcp"
    }
  }
}
```

The alias always routes to whichever account is currently marked as default.

### Health Check

A health endpoint is available at `http://localhost:13491/health` to verify the server is running. The health endpoint is global — it is not tied to any specific account.

## Multiple accounts

The app can run several WhatsApp accounts simultaneously on a single MCP port. Each account has its own:

- **Auth / Baileys session** — separate pairing, separate linked device on your phone.
- **SQLite database** — messages, chats, and sync state are never mixed between accounts.
- **MCP server instance** — served at `/mcp/<slug>`, with its own tool handlers bound to that account.
- **Settings** — per-account group visibility, user name, etc.

On disk, account data lives under Electron's `userData` directory:

```
userData/
  accounts.json                      # registry: slugs, createdAt, mcpEnabled, defaultSlug
  accounts/
    <slug>/
      whatsapp-auth/                 # Baileys auth dir
      nodexa.db                      # SQLite database
```

### Adding an account

1. Click the account switcher in the header (top-left).
2. Choose **+ Add account**.
3. Enter a slug and confirm.
4. Scan the QR code with a different WhatsApp account on your phone.

Slug rules:

- Lowercase letters, digits, and dashes only.
- Must start with a letter.
- 1–32 characters (single letters are allowed).
- Regex: `^[a-z]$|^[a-z][a-z0-9-]{0,30}[a-z0-9]$`

Examples of valid slugs: `personal`, `work`, `client-acme`, `a`, `team-1`. Invalid: `Work` (uppercase), `1personal` (starts with digit), `my_account` (underscore), `work-` (trailing dash).

### Switching between accounts

Use the account switcher in the header to select which account the UI is showing. Switching does not disconnect any account — the other accounts keep syncing in the background and keep serving their MCP endpoints.

### Setting the default account

From Settings → **Accounts**, click **Make default** next to the account you want as default. The default account is also served at the bare `/mcp` alias, which is useful for MCP clients that only support one server URL.

### Renaming an account

1. The account must be **disconnected** first (the UI shows an error if it is connected).
2. Settings → **Accounts** → **Rename** next to the account.
3. Enter the new slug (same rules as above) and save.

Renaming changes the account's MCP URL (`/mcp/<old-slug>` → `/mcp/<new-slug>`), so any MCP client configured for the old URL needs to be updated. If the renamed account was the default, the alias `/mcp` continues to route to it.

### Removing an account

1. The account must be **disconnected** first.
2. Settings → **Accounts** → **Remove** next to the account.
3. Confirm the prompt.

Removing an account **permanently deletes** its SQLite database and auth directory (`accounts/<slug>/`). This cannot be undone. The last remaining account cannot be removed.

### Re-linking after removing the device from your phone

If you remove the linked device from the WhatsApp app on your phone, Baileys will disconnect that account. The app will:

- Mark the account as **disconnected** and show a **"Re-link required"** badge in Settings → Accounts.
- Return HTTP 503 from the account's MCP endpoint until it is re-linked.
- **Preserve** the local SQLite database and account settings — only the Baileys session is invalidated.

To re-link, use the **Re-link** button next to the account (either on the hero screen or in Settings → Account actions). Scan the new QR code with the same phone; your existing messages remain available as soon as the account reconnects.

### Migration from older versions

When you upgrade from a single-account build, the first launch runs a one-time migration:

- The legacy `whatsapp-auth/` directory and `nodexa-whatsapp/nodexa.db` file are moved into `accounts/default/`.
- An account with the slug `default` is registered and marked as the default.
- Legacy `http://localhost:13491/mcp` URLs keep working because `/mcp` is an alias for the default account — no change is required in existing MCP client configurations.
- A `migration-backup/` directory is created in `userData` containing a copy of the pre-migration `whatsapp-auth/` directory and `nodexa.db` file, alongside a README with restore instructions. Delete it once you are confident the migrated data is healthy.

The migration is idempotent: once `accounts.json` exists, it is not run again.

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