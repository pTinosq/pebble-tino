// Google Workspace MCP OAuth (2.0 + PKCE).
//
// Unlike Notion, Google has NO dynamic client registration — you create an
// OAuth "Web application" client in Google Cloud and provide its id/secret via
// env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). One token covers all the
// scopes you consented to, so a single login enables both the Calendar and
// Gmail MCP servers.
//
// `runLogin()` does a one-time browser flow; `getGoogleAccessToken()` returns a
// valid access token at runtime, refreshing (Google refresh tokens don't rotate)
// when near expiry.

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServerConfig } from "./config.js";

// `||` (not `??`) so an empty env value falls back to the default too.
export const CALENDAR_MCP_URL =
  process.env.CALENDAR_MCP_URL || "https://calendarmcp.googleapis.com/mcp/v1";
export const GMAIL_MCP_URL =
  process.env.GMAIL_MCP_URL || "https://gmailmcp.googleapis.com/mcp/v1";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REDIRECT_PORT = 8788;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// Calendar + Gmail. These must match the scopes added on the OAuth consent
// screen, or the login will fail.
const SCOPES = (
  process.env.GOOGLE_SCOPES ??
  [
    "https://www.googleapis.com/auth/calendar.calendarlist",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.modify",
  ].join(" ")
).trim();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const TOKENS_PATH = process.env.GOOGLE_TOKENS_PATH
  ? resolve(process.env.GOOGLE_TOKENS_PATH)
  : resolve(process.cwd(), ".google-tokens.json");

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
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

export function googleTokensExist(): boolean {
  return existsSync(TOKENS_PATH);
}

// Prod bootstrap (mirror of Notion): seed the volume from a base64 blob once.
export function seedGoogleIfNeeded(): void {
  const force = process.env.GOOGLE_TOKENS_SEED_FORCE === "1";
  if (existsSync(TOKENS_PATH) && !force) return;
  const seed = process.env.GOOGLE_TOKENS_SEED;
  if (!seed) return;
  try {
    writeFileSync(TOKENS_PATH, Buffer.from(seed, "base64").toString("utf8"));
    console.log(`[google] seeded tokens to ${TOKENS_PATH}${force ? " (forced overwrite)" : ""}`);
  } catch (err) {
    console.error("[google] failed to seed tokens:", err);
  }
}

// One-time interactive login. Run via `npm run auth:google` / `just setup-google`.
export async function runLogin(): Promise<void> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see README).");
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
  authUrl.searchParams.set("access_type", "offline"); // get a refresh token
  authUrl.searchParams.set("prompt", "consent");      // force refresh token issuance

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
      res.end("<html><body style='font-family:sans-serif'><h2>Google connected ✓</h2>You can close this tab and return to the terminal.</body></html>");
      server.close();
      if (err) return rejectCode(new Error(`Authorization error: ${err}`));
      if (returnedState !== state) return rejectCode(new Error("State mismatch"));
      if (!c) return rejectCode(new Error("No code returned"));
      resolveCode(c);
    });
    server.listen(REDIRECT_PORT, () => {
      console.log("\nOpening your browser to authorize Google…");
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
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  if (!tok.refresh_token) {
    throw new Error("No refresh_token returned — remove app access at myaccount.google.com and retry (needs prompt=consent).");
  }

  saveTokens({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
  });
  console.log(`\n✓ Google connected. Tokens saved to ${TOKENS_PATH}`);
  console.log("Restart the server (`just dev`) — Calendar tools will load.\n");
}

// Returns a valid access token, refreshing if within 2 min of expiry.
export async function getGoogleAccessToken(): Promise<string> {
  const t = loadTokens();
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
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const tok = (await res.json()) as { access_token: string; expires_in: number };
  const updated: Tokens = {
    access_token: tok.access_token,
    refresh_token: t.refresh_token, // Google keeps the same refresh token
    expires_at: Date.now() + tok.expires_in * 1000,
  };
  saveTokens(updated);
  return updated.access_token;
}

// The MCP servers to add when Google is connected (same token for both).
export function googleServers(token: string): McpServerConfig[] {
  return [
    { key: "gcal", url: CALENDAR_MCP_URL, token },
    { key: "gmail", url: GMAIL_MCP_URL, token },
  ];
}
