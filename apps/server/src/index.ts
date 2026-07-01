// HTTP entry point for the Pebble Assistant backend.
//   GET  /      -> health check
//   POST /ask   -> { question } -> { response } | { error }
//
// The watch's phone-side JS calls POST /ask. This process connects to the
// configured MCP servers on startup and reuses those connections per request.

import "dotenv/config";
import http from "node:http";
import { PORT, ASSISTANT_TOKEN, OPENROUTER_API_KEY, mcpServers } from "./config.js";
import { McpManager } from "./mcp.js";
import { askAssistant } from "./llm.js";
import { NOTION_MCP_URL, getNotionAccessToken, tokensExist, seedTokensIfNeeded } from "./notionAuth.js";

const mcp = new McpManager();
const servers = mcpServers();

// Notion via OAuth tokens from `just setup-notion` (if connected).
seedTokensIfNeeded(); // prod: write seed to the volume on first boot
if (tokensExist()) {
  try {
    const token = await getNotionAccessToken();
    servers.unshift({ key: "notion", url: NOTION_MCP_URL, token });
    console.log("[notion] tokens found — Notion MCP enabled");
  } catch (err) {
    console.error("[notion] token load/refresh failed:", err);
  }
} else {
  console.log("[notion] not connected — run `just setup-notion` to enable");
}

await mcp.connect(servers);

if (!OPENROUTER_API_KEY) {
  console.warn("[warn] OPENROUTER_API_KEY is not set — /ask will fail until it is.");
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    send(res, 200, { ok: true, tools: mcp.getOpenAITools().length });
    return;
  }

  if (req.method === "POST" && req.url === "/ask") {
    if (ASSISTANT_TOKEN && req.headers["x-assistant-token"] !== ASSISTANT_TOKEN) {
      send(res, 401, { error: "unauthorized" });
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { question } = JSON.parse(body || "{}") as { question?: string };
        if (!question) {
          send(res, 400, { error: "missing 'question'" });
          return;
        }
        const answer = await askAssistant(question, mcp);
        send(res, 200, { response: answer });
      } catch (err) {
        console.error("[/ask] error:", err);
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
