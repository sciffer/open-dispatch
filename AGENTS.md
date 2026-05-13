# Open Dispatch

Bridge app connecting Slack/Teams/Discord to AI coding assistants (OpenCode/Claude Code).

## Commands

```bash
npm install
npm test                    # node --test tests/*.test.js (fast tests only)
npm run test:slow           # RUN_SLOW_TESTS=1 node --test tests/sprite-slow.test.js
npm run test:all            # RUN_SLOW_TESTS=1 node --test tests/*.test.js (includes slow)

# Local mode dev (with auto-reload via --watch):
npm run dev:opencode        # Slack + OpenCode
npm run dev:teams:opencode   # Teams + OpenCode
npm run dev:discord:opencode # Discord + OpenCode
npm run dev:discord          # Discord + Claude Code
# Start without watch:
npm run start:opencode      # npm start for Slack+Claude
npm run start:sprite         # provider-agnostic sprite mode, set CHAT_PROVIDER=slack|teams|discord
```

All dev commands use `node --watch`. All start commands use plain `node` (no `--watch`). Both run the same entry-point files.

## Architecture

- **Entry points** (`src/*.js`): one per chat+backend combo, e.g. `bot.js` (Slack+Claude), `opencode-bot.js` (Slack+OpenCode), `sprite-bot.js` (any provider + Fly.io backend)
- **Core**: `bot-engine.js` — platform-agnostic command parsing (`/od-start`, `/od-run`, `/od-list`, `/od-stop`, `/od-send`, `/od-jobs`) and instance routing
- **Providers** (`src/providers/`): `ChatProvider` base class in `chat-provider.js`, implementations in `slack-provider.js`, `teams-provider.js`, `discord-provider.js`. Registered via `registerProvider()` at import time.
- **AI backends**: `claude-core.js`, `opencode-core.js` (local process spawn), `sprite-core.js` + `sprite-orchestrator.js` (Fly Machines API) or `github-actions-orchestrator.js` (GitHub Actions sandbox)
- **Sidecar** (`sidecar/`): published as `ghcr.io/bobum/open-dispatch/sidecar`. `sprite-reporter.sh` is the entrypoint; `output-relay.js` is the buffered webhook relay.

## Key facts

- Two mutually exclusive deployment modes: **Local** (Node.js runs on machine, agents spawn as local CLI processes) and **Sprite** (agents in ephemeral sandboxes). Same codebase, different entry points.
- Sprite mode has two sandbox types: `fly` (Fly Machines, default) and `github` (GitHub Actions workflows). Set via `SPRITE_SANDBOX` env var.
- Fly sandbox requires a webhook server on port **8080** (`webhook-server.js`) for Sprites to stream output back. GitHub sandbox polls the GH API for output — no webhook server needed (but still required for Sprite mode compatibility).
- Chat provider connections use port **3978** by default.
- **Slash commands are unified** — same syntax in both modes: `/od-start`, `/od-run`, `/od-stop`, `/od-list`, `/od-send`, `/od-jobs`
- **Image aliases**: `/od-start --image <alias>` — aliases resolve from config, not Docker image names. Sprite mode uses them to select the machine image; local mode ignores them.
- Environment config lives in `.env` (via `dotenv`). Entry points call `require('dotenv').config()` early. Each entry point's required env vars are documented in the file header.
- **Teams single-tenant bots** require `MICROSOFT_APP_TENANT_ID` — missing it produces an opaque "Authorization has been denied" error.
- **Discord:** Global slash commands take up to 1 hour to propagate. Set `DISCORD_GUILD_ID` for instant registration during development.
- **process-handlers.js** must be imported and `registerFatalHandlers()` called at the top of each entry point.

## Testing quirks

- Uses Node.js built-in `node:test` + `node:assert` — NOT Jest/Mocha.
- Slow tests (`sprite-slow.test.js`) are gated behind `RUN_SLOW_TESTS=1` env var. CI runs them nightly only.
- Mock spawn functions are used extensively (e.g., `createMockSpawn` in `opencode-core.test.js`) — the test suit does not spawn real processes.
- Import the module directly (e.g., `require('../src/providers/slack-provider')`) to trigger provider registration in tests.

## CI/CD (GitHub Actions)

- `ci.yml` — runs `npm test` on push/PR to `main` (Node 20, 22 matrix)
- `slow-tests.yml` — nightly cron + manual dispatch, `npm run test:all`
- `docker-build.yml` — builds and pushes `ghcr.io/bobum/open-dispatch` on push to main/master
- `sidecar-publish.yml` — builds and pushes `ghcr.io/bobum/open-dispatch/sidecar` on changes to `sidecar/` on main

## Project structure (key dirs)

```
src/providers/                  — ChatProvider interface + Slack/Teams/Discord impls
src/github-actions-orchestrator.js  — GitHub Actions sandbox orchestrator
sidecar/                        — Sprite sidecar (Docker image for agent VMs)
sidecar/formatters/             — Output formatters (set OUTPUT_FORMATTER env var)
sidecar/github-actions-workflow.yml — Reusable workflow template for GH Actions sandbox
tests/                          — node:test test files
teams-manifest/                 — Manual Teams app manifest (optional, Developer Portal is recommended)
.github/workflows/              — CI/CD pipelines
```

## Gotchas

- OpenAI/open models in OpenCode often default to `gpt-4o` which may hit rate limits. Set `OPENCODE_MODEL` explicitly.
- The `.env` example file doubles as inline docs for which env vars each entry point needs — check the comment headers.
- When adding a new provider, implement the `ChatProvider` interface (see `chat-provider.js`) and register it with `registerProvider()`.
- The `GithubActionsOrchestrator` only supports one-shot jobs — persistent sessions and streaming are not supported. Output is fetched via GH API after the workflow completes (batch, not streaming).
