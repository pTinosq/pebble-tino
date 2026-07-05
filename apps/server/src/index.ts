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
import { askAssistant, type TurnMessage } from "./llm.js";
import { NOTION_MCP_URL, getNotionAccessToken, tokensExist, seedTokensIfNeeded } from "./notionAuth.js";
import { slackTokensExist, getSlackAccessToken, slackServers, seedSlackIfNeeded } from "./slackAuth.js";
import { localToolsAsOpenAI } from "./tools/index.js";

const mcp = new McpManager();
const servers = mcpServers();

// Local dev sets DISABLE_MCP_AUTH=1 so it does NOT load/refresh the OAuth tokens.
// Prod owns those tokens; a second consumer refreshing them triggers provider
// reuse-detection and revokes prod (this bit us repeatedly with Notion).
const skipMcpAuth = process.env.DISABLE_MCP_AUTH === "1";

if (skipMcpAuth) {
  console.log("[dev] DISABLE_MCP_AUTH=1 — skipping Notion/Slack so prod keeps its tokens");
} else {
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

  // Slack via OAuth tokens from `just setup-slack` (if connected).
  seedSlackIfNeeded();
  if (slackTokensExist()) {
    try {
      const token = await getSlackAccessToken();
      for (const s of slackServers(token)) servers.push(s);
      console.log("[slack] tokens found — Slack MCP enabled");
    } catch (err) {
      console.error("[slack] token load/refresh failed:", err);
    }
  } else {
    console.log("[slack] not connected — run `just setup-slack` to enable");
  }
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
    send(res, 200, { ok: true, tools: mcp.getOpenAITools().length + localToolsAsOpenAI().length });
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
        const parsed = JSON.parse(body || "{}") as {
          question?: string;
          history?: Array<{ role?: string; content?: string }>;
        };
        if (!parsed.question) {
          send(res, 400, { error: "missing 'question'" });
          return;
        }
        // Sanitize + cap the client-supplied history (last 12 turns).
        const history = (Array.isArray(parsed.history) ? parsed.history : [])
          .filter(
            (m): m is TurnMessage =>
              (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
          )
          .slice(-12);
        const answer = await askAssistant(parsed.question, mcp, history);
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
