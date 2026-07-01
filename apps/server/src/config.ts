// Central config, read from environment variables.
// Loaded via `dotenv/config` (imported first in index.ts) for local dev;
// on Railway these come from the service's env vars.

export interface McpServerConfig {
  key: string; // short id used to namespace tools, e.g. "notion"
  url: string;
  token?: string; // OAuth access token (see oauth.ts for refresh)
}

export const MODEL = process.env.MODEL ?? "google/gemini-2.5-flash";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const ASSISTANT_TOKEN = process.env.ASSISTANT_TOKEN ?? "";
export const PORT = Number(process.env.PORT ?? 8080);

// Returns only the MCP servers that have a URL configured.
export function mcpServers(): McpServerConfig[] {
  const defs: Array<{ key: string; url?: string; token?: string }> = [
    { key: "notion", url: process.env.NOTION_MCP_URL, token: process.env.NOTION_MCP_TOKEN },
    { key: "gmail", url: process.env.GMAIL_MCP_URL, token: process.env.GMAIL_MCP_TOKEN },
    { key: "gcal", url: process.env.GCAL_MCP_URL, token: process.env.GCAL_MCP_TOKEN },
  ];
  const out: McpServerConfig[] = [];
  for (const d of defs) {
    if (d.url) out.push({ key: d.key, url: d.url, token: d.token });
  }
  return out;
}
