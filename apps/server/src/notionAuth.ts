// Notion MCP OAuth (2.0 + PKCE + dynamic client registration).
//
// The hosted Notion MCP server is OAuth-only — no static token / ntn_ header.
// `runLogin()` does a one-time interactive browser flow and stores tokens in a
// gitignored file; `getNotionAccessToken()` returns a valid token at runtime,
// refreshing (rotating refresh token) when near expiry.

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MCP_BASE = "https://mcp.notion.com";
export const NOTION_MCP_URL = `${MCP_BASE}/mcp`;
const RESOURCE = MCP_BASE; // RFC 8707 resource identifier
const REDIRECT_PORT = 8787;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
// Configurable so prod can point at a persistent volume (e.g. /data).
const TOKENS_PATH = process.env.NOTION_TOKENS_PATH
  ? resolve(process.env.NOTION_TOKENS_PATH)
  : resolve(process.cwd(), ".notion-tokens.json");

interface OAuthMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  client_id: string;
  token_endpoint: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function discover(): Promise<OAuthMeta> {
  const res = await fetch(`${MCP_BASE}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`OAuth discovery failed: ${res.status}`);
  return (await res.json()) as OAuthMeta;
}

async function registerClient(meta: OAuthMeta): Promise<string> {
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Pebble Assistant",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none", // public client (PKCE, no secret)
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { client_id: string };
  return data.client_id;
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

export function tokensExist(): boolean {
  return existsSync(TOKENS_PATH);
}

// Prod bootstrap: if no token file exists yet but a base64 seed is provided
// (NOTION_TOKENS_SEED), write it once. Subsequent rotations persist to
// TOKENS_PATH — point that at a persistent volume in prod.
export function seedTokensIfNeeded(): void {
  // NOTION_TOKENS_SEED_FORCE=1 overwrites an existing (e.g. revoked) token file
  // on the volume. Set it for one deploy to re-seed, then remove it.
  const force = process.env.NOTION_TOKENS_SEED_FORCE === "1";
  if (existsSync(TOKENS_PATH) && !force) return;
  const seed = process.env.NOTION_TOKENS_SEED;
  if (!seed) return;
  try {
    writeFileSync(TOKENS_PATH, Buffer.from(seed, "base64").toString("utf8"));
    console.log(`[notion] seeded tokens to ${TOKENS_PATH}${force ? " (forced overwrite)" : ""}`);
  } catch (err) {
    console.error("[notion] failed to seed tokens:", err);
  }
}

// One-time interactive login. Run via `npm run auth:notion` / `just setup-notion`.
export async function runLogin(): Promise<void> {
  const meta = await discover();
  const clientId = await registerClient(meta);

  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("resource", RESOURCE);

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
      res.end("<html><body style='font-family:sans-serif'><h2>Notion connected ✓</h2>You can close this tab and return to the terminal.</body></html>");
      server.close();
      if (err) return rejectCode(new Error(`Authorization error: ${err}`));
      if (returnedState !== state) return rejectCode(new Error("State mismatch"));
      if (!c) return rejectCode(new Error("No code returned"));
      resolveCode(c);
    });
    server.listen(REDIRECT_PORT, () => {
      console.log("\nOpening your browser to authorize Notion…");
      console.log("If it doesn't open, paste this URL:\n" + authUrl.toString() + "\n");
      openBrowser(authUrl.toString());
    });
  });

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
    resource: RESOURCE,
  });
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  saveTokens({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + tok.expires_in * 1000,
    client_id: clientId,
    token_endpoint: meta.token_endpoint,
  });
  console.log(`\n✓ Notion connected. Tokens saved to ${TOKENS_PATH}`);
  console.log("Restart the server (`just dev`) — Notion tools will load.\n");
}

// Returns a valid access token, refreshing if within 2 min of expiry.
export async function getNotionAccessToken(): Promise<string> {
  const t = loadTokens();
  if (Date.now() < t.expires_at - 120_000) return t.access_token;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: t.client_id,
    resource: RESOURCE,
  });
  const res = await fetch(t.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Notion token refresh failed: ${res.status} ${await res.text()}`);
  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const updated: Tokens = {
    ...t,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? t.refresh_token, // Notion rotates these
    expires_at: Date.now() + tok.expires_in * 1000,
  };
  saveTokens(updated);
  return updated.access_token;
}
