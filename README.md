# Heisenberg

Heisenberg is an AI-assisted weekly meal planner—because he was *the cook*. It creates a five-day menu every Friday, keeps rotation history in small JSON files, posts drafts to a dedicated Telegram group, and lets the household change the plan conversationally.

## What it does

- Generates Monday, Tuesday, Thursday, Friday, and Saturday menus at 6:00 PM IST every Friday.
- Validates generated menus against dish categories and household guardrails before saving them.
- Stores dishes, menus, preferences, and the last 100 conversations with lowdb.
- Runs a dedicated Telegram bot in a dedicated Telegram group.
- Exposes the same operations as authenticated MCP tools at `/mcp`.
- Supports Telegram commands: `/menu`, `/generate`, `/confirm`, `/dishes`, `/backup`, and `/help`.
- Lets the Telegram agent add, rename, recategorise, retag, enable, and disable dishes, then apply routine menu changes without an extra confirmation step.
- In groups, responds only to slash commands, direct `@bot` mentions, or replies to one of its messages; interactive responses are linked to the triggering Telegram message.
- Tracks each speaker by stable Telegram user ID and stores their display name with conversation history, keeping Aniket and his brother distinct.

## Local setup

Requirements: Node.js 20 or newer, an OpenAI API key, and a new Telegram bot and group.

```bash
cd /Users/aniket/Code/heisenberg
npm install
cp .env.example .env
# Fill in OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
# API_BEARER_TOKEN, and MCP_BEARER_TOKEN
npm start
```

The web API and MCP server share `http://localhost:3000`. Health is at `/health`, and MCP is at `/mcp`. The API requires `Authorization: Bearer <API_BEARER_TOKEN>` on every API route except `/health`, which remains public for Railway health checks. The application refuses to start if the API secret is absent.

Telegram is a trusted internal entry point: the bot accepts updates only from `TELEGRAM_CHAT_ID` and calls application services directly rather than going through the public HTTP API. Set `TELEGRAM_ALLOWED_USER_IDS` to a comma-separated list of numeric user IDs for per-user authorization. If it is empty, every member of the configured group is trusted. No bypass header or externally spoofable “Telegram source” flag is used.

Every MCP request must include `Authorization: Bearer <MCP_BEARER_TOKEN>`. The application refuses to start the MCP server if this secret is absent.

Generate a strong token locally:

```bash
openssl rand -hex 32
```

Example MCP request:

```bash
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"local-client","version":"1.0.0"}}}'
```

The JSON files under `src/data` are created and seeded on first run.

## Create the new Telegram bot and group

1. In Telegram, open the verified **@BotFather** account and send `/newbot`.
2. Choose a display name such as `Heisenberg Meal Planner`, then a unique username ending in `bot`.
3. Copy the token BotFather returns into `.env` as `TELEGRAM_BOT_TOKEN`.
4. The bot may keep privacy mode enabled while it remains a group administrator; Telegram delivers all group messages to bot administrators. Alternatively, disable privacy mode through `/setprivacy` in BotFather.
5. Create a fresh Telegram group for the meal planner and add the new bot.
6. Make the bot an administrator so it can reliably post messages and files.
7. Temporarily run the app without `TELEGRAM_CHAT_ID`, send a message in the new group, then visit:

   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`

8. Find `message.chat.id` in the response. Group IDs are negative and supergroup IDs commonly begin with `-100`. Put the complete number in `.env` as `TELEGRAM_CHAT_ID`.
9. In the same update, copy the intended users’ `message.from.id` values into `TELEGRAM_ALLOWED_USER_IDS`, separated by commas.
10. Restart the app and send `/help` in the group.

Keep the token secret. If it is exposed, revoke it with BotFather and create a replacement.

## Railway deployment

1. Create a Git repository in this folder and push it to a private GitHub repository.
2. In [Railway](https://railway.com), create a project from that GitHub repository.
3. Generate separate production secrets for `API_BEARER_TOKEN` and `MCP_BEARER_TOKEN` with `openssl rand -hex 32`.
4. In the service’s **Variables**, add every value from `.env.example` except `PORT`, which Railway supplies. Store bearer tokens only as Railway secrets and in clients that need access.
5. Generate a domain for the service and verify `/health` returns `{"status":"ok"}`.
6. Railway deploys every push to the connected production branch.
7. Mount a Railway Volume at `/app/src/data` so menus, preferences, dishes, and conversations survive deployments.
8. Use `/backup` in Telegram periodically to download `dishes.json`, `menus.json`, and `preferences.json`.

### Persistence warning

Railway’s ordinary service filesystem is ephemeral and JSON files can be wiped during a redeploy. Mount a persistent Railway Volume at `/app/src/data`. The `/backup` command provides an additional recoverable copy, but is not a substitute for a volume.

The MCP endpoint shares the application’s Railway `PORT` at `/mcp` and requires its own bearer token on every request. API and MCP authentication remain independent even though they share one listener.

## Environment variables

See `.env.example`. `OPENAI_MENU_MODEL`, `OPENAI_AGENT_MODEL`, and `TZ` are optional. Menu generation defaults to `gpt-5.6-luna`, conversational tool use defaults to `gpt-5.6-terra`, and the timezone defaults to `Asia/Kolkata`.

For backward compatibility, the application still accepts `OPENAI_MODEL` as a shared fallback when a task-specific model variable is absent.

The application serializes all JSON-store operations, limits conversational and MCP request rates, and limits manual menu generation to three attempts per ten minutes. Scheduled generation catches up after a missed Friday run through the following Tuesday and skips weeks that already have a menu.

Custom rules use deterministic formats so the server can enforce them after AI generation:

- `never:<term>`
- `max_category:<category>:<0-5>`
- `require_main:<dish>`
- `not_on:<day>:<dish>`
- `pair:<dish>|<dish>`

## Local release check

```bash
npm ci
npm test
npm audit --omit=dev
npm start
```

Then verify `/health`, `/menu`, `/generate`, a natural-language menu change, `/confirm`, and `/backup` before deploying.

## Project map

- `index.js` — initializes storage, the shared API/MCP server, cron, and Telegram.
- `src/db/store.js` — lowdb files and all storage helpers.
- `src/db/seed.js` — first-run master dish seeding.
- `src/scheduler/generator.js` — prompt execution, retries, and rule validation.
- `src/scheduler/cron.js` — Friday 6:00 PM IST schedule.
- `src/prompts/` — menu and conversation system prompts.
- `src/mcp/tools.js` — shared tool definitions and implementations.
- `src/mcp/server.js` — authenticated MCP HTTP transport mounted at `/mcp`.
- `src/telegram/agent.js` — conversational tool-calling agent.
- `src/telegram/bot.js` — Telegram commands, group restriction, and backups.
- `src/telegram/format.js` — readable Telegram output.
- `test/generator.test.js` — core date and validation checks.
