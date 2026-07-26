# pebble-tino

A voice assistant on the **Pebble Time 2**. Dictate a question on your wrist →
an LLM (Gemini via OpenRouter) answers, using your connected tools (Notion,
Slack, live data like TfL & weather) → the answer streams back to the watch.
A companion **Translate** app gives a rolling, phrase-by-phrase translation of
foreign speech ([`apps/translate`](#translate-app-appstranslate)).

```
watch (dictate) → phone JS → backend /ask → LLM (OpenRouter, ZDR)
                                              ├─ MCP tools:   Notion, Slack
                                              └─ local tools: TfL tube, weather, …
watch (answer)  ← phone JS ← backend  ←──────  final text (chunked, scrollable)
```

## Layout

```
apps/
  watch/     Pebble app (C + PebbleKit JS). Builds with the `pebble` tool.
  translate/ Pebble app for live-ish speech translation (own launcher icon).
  server/    Backend the phone calls. Node/TypeScript. Deployed to Railway.
```

The backend is an **MCP client** (connects to remote MCP servers and exposes
their tools to the LLM) **plus a small runtime for local tools** — functions it
implements directly to wrap plain REST APIs (no MCP server required).

## Watch controls

| Button | Action |
|---|---|
| **SELECT** (tap) | Speak a question / follow-up (keeps conversation context) |
| **SELECT** (hold) | Start a new conversation (clears context) |
| **BACK** | Page back through earlier turns; exits at the first |
| **UP / DOWN** | Scroll the current answer |

Long answers stream in chunk-by-chunk and buzz when complete.

## Quick start (Justfile)

Common tasks are wrapped in a [`Justfile`](./Justfile) (`brew install just`):

```bash
just               # list all recipes
just setup         # create .env + watch secrets.js from templates
just install       # install deps
just dev           # run the backend locally (http://localhost:8080)
just setup-notion  # connect Notion  (browser OAuth)
just setup-slack   # connect Slack   (needs a Slack app — see below)
just watch-install # build + install the watch app via CloudPebble
just apps-install  # build + install ALL watch apps (assistant + translate)
just watch-phone <ip>   # build + install to a phone by IP
just health        # ping the deployed backend
just ask "what's the tube status?"
just deploy        # push to main (Railway auto-deploys)
```

## Secrets & `.env`

**No secrets live in this repo.** Everything comes from environment variables /
gitignored files:

- Backend: copy `apps/server/.env.example` → `apps/server/.env` (gitignored).
  On Railway, set the same variables in the service's **Variables** tab.
- Watch: `apps/watch/src/pkjs/index.js` imports `./secrets.js` (gitignored) —
  copy `secrets.example.js` → `secrets.js` and set `BACKEND_URL` + `ASSISTANT_TOKEN`.
- OAuth tokens are stored in gitignored `*-tokens.json` files (never committed).

Minimum backend env: `OPENROUTER_API_KEY`, `MODEL` (default
`google/gemini-3-flash-preview`), `ASSISTANT_TOKEN` (shared secret the watch sends).

## Privacy

Every LLM request pins OpenRouter to strict privacy routing
(`provider: { zdr: true, data_collection: "deny" }`): **Zero-Data-Retention
endpoints only**, and never a provider that stores or trains on inputs. For
belt-and-suspenders, also set this account-wide in OpenRouter → Settings →
Privacy and disable prompt logging.

## Capabilities

### MCP integrations (OAuth)

**Notion** — easiest; no app to create (dynamic client registration):

```bash
just setup-notion         # browser OAuth (PKCE); tokens → apps/server/.notion-tokens.json
just ask "what's on my Notion tasks?"
```

**Slack** — needs a one-time Slack app:

1. Create an app at <https://api.slack.com/apps> → **From scratch**.
2. **OAuth & Permissions** → add redirect URL `http://localhost:8789/callback`.
3. Add **User Token Scopes** (e.g. `search:read.public`, `channels:history`,
   `channels:read`, `users:read`, `chat:write`).
4. **Basic Information** → copy the **Client ID** + **Client Secret** into
   `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`.
5. Enable the app for **Slack MCP server access** (Slack shows the exact URL if
   it's off).
6. `just setup-slack` → browser OAuth.

Both auto-refresh their tokens. See "Connecting services to prod" for Railway.

### Local tools (no MCP)

Implemented directly in [`apps/server/src/localTools.ts`](apps/server/src/localTools.ts) —
the go-to for wrapping any REST API you control:

- **`tfl_tube_status`** — London Underground line status (TfL API). Works
  keyless; set `TFL_APP_KEY` for higher rate limits.
- **`get_weather`** — current conditions + today's forecast for any city
  (Open-Meteo, no key).

Ask: *"any tube delays?"*, *"do I need a coat?"*, *"weather in Tokyo?"*

**Add your own** — append a `LocalTool` (`name`, `description`, JSON-schema
`parameters`, and an async `run(args)`), then `just deploy`. No OAuth, no
separate server, no watch reinstall. This is preferred over building a standalone
MCP server unless you need the tool reusable from other MCP clients.

## Deploy to Railway

1. New Railway project → deploy from this GitHub repo.
2. Service → **Settings → Root Directory** = `apps/server`.
3. Add env vars (`OPENROUTER_API_KEY`, `MODEL`, `ASSISTANT_TOKEN`, tool keys).
4. Add a **Volume** mounted at `/data` (persists OAuth tokens across deploys).
5. Railway builds via `railway.json` and gives you a public URL.
6. Put that URL + `ASSISTANT_TOKEN` into the watch's `secrets.js`.

### Connecting services to prod

Railway's filesystem is ephemeral, so OAuth tokens live on the volume and are
seeded once via env. After `just setup-<service>` locally:

1. `NOTION_TOKENS_PATH=/data/.notion-tokens.json` (per service).
2. `NOTION_TOKENS_SEED=<base64 of the local token file>` +
   `NOTION_TOKENS_SEED_FORCE=1` for one deploy (writes it to the volume).
3. After it connects, set `NOTION_TOKENS_SEED_FORCE=0` so later deploys don't
   overwrite the live (rotated) token. (Same pattern for `SLACK_*`.)

> **One token owner.** Prod owns the OAuth tokens. `just dev` deliberately
> runs with `DISABLE_MCP_AUTH=1` so local development never refreshes prod's
> tokens (some providers revoke the whole token family on refresh-reuse). Local
> tools (TfL, weather) still work under `just dev`; MCP tools are tested on prod.

## Watch app (`apps/watch`)

```bash
cp apps/watch/src/pkjs/secrets.example.js apps/watch/src/pkjs/secrets.js
# edit secrets.js: BACKEND_URL + ASSISTANT_TOKEN
just watch-install            # via CloudPebble
# or: just watch-phone <your-phone-ip>
```

Open the app, press **SELECT**, speak, read the answer.

## Translate app (`apps/translate`)

A separate Pebble app that turns overheard foreign speech into a rolling English
transcript on your wrist.

```
watch (dictate phrase) → phone JS → backend /translate → LLM (OpenRouter, ZDR)
watch (English line)   ← phone JS ← backend  ←────────── translation
```

Press **SELECT** to start listening. Each phrase it hears is dictated, sent to
the backend, translated, and appended to the transcript — then it **listens
again automatically**, so a whole conversation streams in phrase-by-phrase.
Press **SELECT** again (or **BACK**) to pause; **UP/DOWN** scroll.

| Button | Action |
|---|---|
| **SELECT** | Start / pause continuous listening |
| **SELECT** (hold) | Open the target-language menu |
| **BACK** | Pause (if listening), else exit |
| **UP / DOWN** | Scroll the transcript |

**Target language.** Hold SELECT for a menu of target languages (English,
Greek, French, German, Italian, Spanish, Portuguese); the choice persists across
launches and shows in the header (e.g. `> English`). Leave it on English to
understand others; switch it to translate *your own* speech so you can reply.
The **source** language is never picked here — it's auto-detected by the backend
(and by the phone's "auto" Voice Language).

**Platform limits (honest expectations).** Pebble's dictation API returns only a
*final* transcription per utterance — there are no streaming/partial results and
no per-app language — so this is phrase-by-phrase, not word-by-word. For it to
capture the spoken language, set the Pebble mobile app's **Voice Language** to
that language (or the experimental **"auto"**). Dictation needs a Rebble
subscription.

The backend endpoint is tool-less and low-latency:

```bash
just translate "καλημέρα, τι κάνεις;"   # -> {"translation":"Good morning, how are you?"}
```

Build + install like the main watch app:

```bash
cp apps/translate/src/pkjs/secrets.example.js apps/translate/src/pkjs/secrets.js
# edit secrets.js: BACKEND_URL (…/translate) + ASSISTANT_TOKEN + TARGET_LANG
just translate-install         # via CloudPebble
# or: just translate-phone <your-phone-ip>   /   just translate-emu
```
