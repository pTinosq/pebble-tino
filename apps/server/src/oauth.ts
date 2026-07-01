// OAuth token refresh for remote MCP servers.
//
// Remote MCP access tokens are short-lived (Notion ~1 hour). For production you
// store the long-lived *refresh* token (in env / a secret store) and exchange
// it for a fresh access token before connecting. This helper implements the
// standard OAuth 2.0 refresh_token grant, reusable for Notion and Google.
//
// Wiring this into mcp.ts is the next milestone — see README "OAuth setup".

export interface OAuthRefreshConfig {
  tokenEndpoint: string; // e.g. https://api.notion.com/v1/oauth/token
  clientId: string;
  clientSecret?: string; // omit for public PKCE clients
  refreshToken: string;
}

export async function refreshAccessToken(cfg: OAuthRefreshConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
  });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);

  const res = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}
