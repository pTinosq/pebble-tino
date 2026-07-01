# pebble-tino

A voice assistant on the **Pebble Time 2**. Dictate a question on your wrist →
an LLM (Gemini via OpenRouter) answers, using your **Notion**, **Gmail**, and
**Google Calendar** through their official MCP servers → the answer shows on the
watch.

```
watch (dictate) → phone JS → backend (/ask) → Gemini + MCP tools
                                                 ├─ Notion MCP
                                                 ├─ Gmail MCP
                                                 └─ Google Calendar MCP
watch (answer)  ← phone JS ← backend  ←──────────  final text
```

## Layout

```
apps/
  watch/    Pebble watch app (C + PebbleKit JS). Builds with the pebble tool.
  server/   Backend the phone calls. Node/TypeScript. Deployed to Railway.
```

The `server/` folder is an **MCP client** — it connects to the remote MCP
servers for Notion/Gmail/Calendar and exposes their tools to the LLM.

## Secrets & `.env`

**No secrets live in this repo.** All keys and tokens come from environment
variables:

- Local dev: copy `apps/server/.env.example` → `apps/server/.env` (gitignored)
  and fill it in.
- Railway: set the same variables in the service's **Variables** tab.
- The watch's `apps/watch/src/pkjs/index.js` holds only your **backend URL** and
  a shared `ASSISTANT_TOKEN` — set these locally; don't commit real values.

## Backend (`apps/server`)

```bash
cd apps/server
cp .env.example .env      # then fill in OPENROUTER_API_KEY etc.
npm install
npm run dev               # local, hot-reload on http://localhost:8080
# or: npm run build && npm start
```

Test it:

```bash
curl -s localhost:8080/ask \
  -H 'content-type: application/json' \
  -H "x-assistant-token: $ASSISTANT_TOKEN" \
  -d '{"question":"what is on my calendar today?"}'
```

### Model note

Gemini **3** models (e.g. `google/gemini-3.1-flash-lite`) currently error with
`missing thought_signature` on tool calls via OpenRouter, so `MODEL` defaults to
`google/gemini-2.5-flash`. Switch back once that's fixed upstream.

## OAuth setup (MCP servers)

Each service authenticates via OAuth. Official remote endpoints:

| Service         | MCP URL                          |
| --------------- | -------------------------------- |
| Notion          | `https://mcp.notion.com/mcp`     |
| Gmail           | Google Workspace remote MCP      |
| Google Calendar | Google Workspace remote MCP      |

Obtain an access token per service and set `*_MCP_TOKEN` in the backend env.
Tokens are short-lived (Notion ~1h) — `src/oauth.ts` has the refresh helper;
wiring automatic refresh is the next milestone. Start with **Notion only** to
get the loop working end-to-end, then add Gmail/Calendar.

## Deploy to Railway

1. Push this repo to GitHub.
2. New Railway project → Deploy from GitHub repo.
3. Service settings → set **Root Directory** to `apps/server`.
4. Add environment variables (from `.env.example`).
5. Railway builds via `railway.json` and gives you a public URL.
6. Put that URL (+ `ASSISTANT_TOKEN`) into `apps/watch/src/pkjs/index.js`.

## Watch app (`apps/watch`)

```bash
cd apps/watch
# edit src/pkjs/index.js: set BACKEND_URL and ASSISTANT_TOKEN
pebble build
pebble install --phone <your-phone-ip>
```

Press **SELECT** on the watch, speak your question, read the answer.
