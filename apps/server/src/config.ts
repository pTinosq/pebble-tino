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
  // Notion and Google are OAuth-managed (notionAuth.ts / googleAuth.ts) and
  // added at startup in index.ts. Add any static-token MCP servers here.
  return [];
}
