// Slack MCP OAuth (2.0 + PKCE, confidential client).
//
// Slack has no dynamic client registration — create a Slack app and provide its
// SLACK_CLIENT_ID / SLACK_CLIENT_SECRET via env. Slack's token endpoint is a Web
// API method (returns {ok: ...}), and user tokens are long-lived unless the app
// enables Token Rotation (then we refresh). We handle both.

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServerConfig } from "./config.js";

export const SLACK_MCP_URL = process.env.SLACK_MCP_URL || "https://mcp.slack.com/mcp";

const AUTH_ENDPOINT = "https://slack.com/oauth/v2_user/authorize";
const TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.user.access";
const REDIRECT_PORT = 8789;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// User-token scopes. These must match the "User Token Scopes" added to the Slack app.
const SCOPES = (
  process.env.SLACK_SCOPES ??
  [
    "search:read.public",
    "search:read.private",
    "channels:history",
    "channels:read",
    "users:read",
    "chat:write",
  ].join(" ")
).trim();

const CLIENT_ID = process.env.SLACK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || "";
const TOKENS_PATH = process.env.SLACK_TOKENS_PATH
  ? resolve(process.env.SLACK_TOKENS_PATH)
  : resolve(process.cwd(), ".slack-tokens.json");

interface Tokens {
  access_token: string;
  refresh_token?: string; // only with Token Rotation enabled
  expires_at?: number; // epoch ms; absent => long-lived token
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start \"\"" :
    "xdg-open";
  exec(`${cmd} "${url}"`);
}

function saveTokens(t: Tokens): void {
  writeFileSync(TOKENS_PATH, JSON.stringify(t, null, 2));
}

function loadTokens(): Tokens {
  return JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as Tokens;
}

export function slackTokensExist(): boolean {
  return existsSync(TOKENS_PATH);
}

export function seedSlackIfNeeded(): void {
  const force = process.env.SLACK_TOKENS_SEED_FORCE === "1";
  if (existsSync(TOKENS_PATH) && !force) return;
  const seed = process.env.SLACK_TOKENS_SEED;
  if (!seed) return;
  try {
    writeFileSync(TOKENS_PATH, Buffer.from(seed, "base64").toString("utf8"));
    console.log(`[slack] seeded tokens to ${TOKENS_PATH}${force ? " (forced overwrite)" : ""}`);
  } catch (err) {
    console.error("[slack] failed to seed tokens:", err);
  }
}

// Slack's token endpoint returns {ok: bool, ...}; the user token may be at the
// top level or under authed_user depending on the flow.
function parseSlackToken(data: any): { access_token: string; refresh_token?: string; expires_in?: number } {
  if (!data.ok) throw new Error(`Slack error: ${data.error || JSON.stringify(data).slice(0, 200)}`);
  const au = data.authed_user ?? {};
  const access_token = data.access_token || au.access_token;
  if (!access_token) throw new Error(`Slack: no access_token in response ${JSON.stringify(data).slice(0, 200)}`);
  return {
    access_token,
    refresh_token: data.refresh_token || au.refresh_token,
    expires_in: data.expires_in || au.expires_in,
  };
}

export async function runLogin(): Promise<void> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET first (see README).");
  }

  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  const code = await new Promise<string>((resolveCode, rejectCode) => {
    const server = http.createServer((req, res) => {
      if (!req.url || !req.url.startsWith("/callback")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const u = new URL(req.url, REDIRECT_URI);
      const returnedState = u.searchParams.get("state");
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body style='font-family:sans-serif'><h2>Slack connected ✓</h2>You can close this tab and return to the terminal.</body></html>");
      server.close();
      if (err) return rejectCode(new Error(`Authorization error: ${err}`));
      if (returnedState !== state) return rejectCode(new Error("State mismatch"));
      if (!c) return rejectCode(new Error("No code returned"));
      resolveCode(c);
    });
    server.listen(REDIRECT_PORT, () => {
      console.log("\nOpening your browser to authorize Slack…");
      console.log("If it doesn't open, paste this URL:\n" + authUrl.toString() + "\n");
      openBrowser(authUrl.toString());
    });
  });

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tok = parseSlackToken(await res.json());

  saveTokens({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
  });
  console.log(`\n✓ Slack connected. Tokens saved to ${TOKENS_PATH}`);
  console.log("Restart the server (`just dev`) — Slack tools will load.\n");
}

export async function getSlackAccessToken(): Promise<string> {
  const t = loadTokens();
  // Long-lived token (no rotation) — use as-is.
  if (!t.expires_at || !t.refresh_token) return t.access_token;
  if (Date.now() < t.expires_at - 120_000) return t.access_token;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tok = parseSlackToken(await res.json());
  const updated: Tokens = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? t.refresh_token,
    expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
  };
  saveTokens(updated);
  return updated.access_token;
}

export function slackServers(token: string): McpServerConfig[] {
  return [{ key: "slack", url: SLACK_MCP_URL, token }];
}
