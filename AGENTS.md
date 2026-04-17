# AGENTS.md — Release Documentation for AI Agents

## Release Architecture

- **semantic-release** for versioning (config: `.releaserc.json`)
- **electron-builder** for building/packaging (config: `package.json` → `"build"` section)
- **GitHub Actions** workflow at `.github/workflows/release.yml`
- Builds for:
  - macOS: dmg + zip
  - Linux: AppImage
  - Windows: nsis + portable
- **Auto-updater**: Uses `electron-updater`, checks `latest-mac.yml` / `latest-linux.yml` / `latest.yml` on the GitHub release

## How Releases Are Triggered

Two trigger methods:

1. **Manual (preferred)**: Go to GitHub Actions → "Release" workflow → "Run workflow". Optionally provide a tag (e.g. `v1.2.3`) to rebuild a specific version, or leave empty to let semantic-release auto-determine version.
2. **Rebuild existing tag**: Use the workflow_dispatch with a specific tag input (e.g. `v1.2.3`) to rebuild and re-upload artifacts for an existing release.

**IMPORTANT**: Do NOT add push-to-main triggers — this caused race conditions in the past where two parallel runs (push + tag) uploaded conflicting assets with mismatched SHA512 checksums, breaking the auto-updater.

## Workflow Jobs

1. **semantic-release** — Only runs on branch pushes (`workflow_dispatch`). Analyzes commits and creates a new GitHub release + tag if warranted. Uses `RELEASE_TOKEN` secret (PAT) to bypass branch protection.
2. **build** — Runs on all 3 OS matrix (`macos-latest`, `ubuntu-latest`, `windows-latest`). Checks out the tagged commit, syncs `package.json` version, builds with electron-builder, and uploads artifacts to the GitHub release with `--publish always`.
3. **publish-release** — Ensures the release is not a draft after all builds complete.

## Commit Conventions

semantic-release uses Angular preset with these release rules (from `.releaserc.json`):

- `feat:` → minor
- `fix:` → patch
- `perf:` → patch
- `refactor:` → patch
- `chore:` → patch

## Key Configuration

- `package.json` → `"build.publish"`: `releaseType` must be `"release"` (not `"draft"`) — electron-builder skips upload if the release isn't in the expected state.
- `.releaserc.json`: `npmPublish` is `false` (this is an Electron app, not an npm package).
- **Secrets needed**:
  - `RELEASE_TOKEN` (PAT with repo scope)
  - `APPLE_CERTIFICATE`
  - `APPLE_CERTIFICATE_PASSWORD`
  - `APPLE_ID`
  - `APPLE_PASSWORD`

## Fixing a Broken Release

If a release has mismatched assets (e.g. SHA512 in `latest-mac.yml` doesn't match the actual zip):

1. Delete all assets from the release:
   ```bash
   gh release delete-asset vX.Y.Z "<asset-name>" --repo panghy/whatsapp-mcp-server --yes
   ```
   Repeat for each asset.

2. Trigger a clean rebuild:
   ```bash
   gh workflow run release.yml --repo panghy/whatsapp-mcp-server -f tag=vX.Y.Z
   ```

3. Wait for all 3 platform builds to complete.

4. Verify checksums match: download `latest-mac.yml` and compare the `size`/`sha512` with the actual zip asset size on the release.

## CI Workflow

There's also a CI workflow (`.github/workflows/ci.yml`) that runs on PRs to main and `merge_group`. It runs:

- lint
- type-check
- build:renderer
- tests

## Development

- Node.js 22 required
- `npm ci` to install
- `npm run dev` for local development
- `npm run build` for production build
- `npm test` for tests (vitest)

### Multi-account testing

The multi-account feature is covered by a set of unit tests under `src/`. When changing multi-account behavior, run the full suite (`npm test`) and pay attention to these files:

- `src/accounts.test.ts` — accounts registry (`accounts.json`), slug validation, add/rename/remove, default slug handling, legacy-layout migration into `accounts/default/`.
- `src/global-settings.test.ts` — global MCP settings (`mcp_port`, `mcp_auto_start`) stored in `electron-settings` outside any per-account SQLite database.
- `src/database.test.ts` — per-account SQLite file isolation (`accounts/<slug>/nodexa.db`), schema bootstrap, and close/reopen behavior.
- `src/mcp-server.test.ts` — HTTP path routing (`/mcp/<slug>`, `/mcp` alias to the default account), 404 for unknown slugs, 503 when `mcpEnabled === false`, and per-account `McpServer` instance isolation.
- `src/main-ipc.test.ts` — IPC handlers for account management (`accounts-add`, `accounts-rename`, `accounts-remove`, `accounts-set-default`) including the "must be disconnected" guards.

Run `npm test` to execute the whole vitest suite; these files are part of the standard CI run.

