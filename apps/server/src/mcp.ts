// MCP client manager.
// Connects to one or more remote MCP servers (Notion, Gmail, Google Calendar),
// lists their tools, and exposes them as OpenAI-style function definitions so
// the LLM (via OpenRouter) can call them. Tool names are namespaced per server
// (e.g. "notion__search") and routed back to the right client on invocation.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./config.js";

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
}

interface ToolRoute {
  client: Client;
  originalName: string;
}

export class McpManager {
  private clients: Client[] = [];
  private routes = new Map<string, ToolRoute>();
  private tools: OpenAITool[] = [];

  async connect(servers: McpServerConfig[]): Promise<void> {
    for (const s of servers) {
      try {
        const headers: Record<string, string> = {};
        if (s.token) headers["Authorization"] = `Bearer ${s.token}`;

        const transport = new StreamableHTTPClientTransport(new URL(s.url), {
          requestInit: { headers },
        });
        const client = new Client({ name: "pebble-assistant", version: "1.0.0" });
        await client.connect(transport);
        this.clients.push(client);

        const { tools } = await client.listTools();
        for (const t of tools) {
          const safeName = `${s.key}__${t.name}`
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .slice(0, 64);
          this.routes.set(safeName, { client, originalName: t.name });
          this.tools.push({
            type: "function",
            function: {
              name: safeName,
              description: t.description,
              parameters: t.inputSchema ?? { type: "object", properties: {} },
            },
          });
        }
        console.log(`[mcp] connected "${s.key}" (${tools.length} tools)`);
      } catch (err) {
        console.error(`[mcp] failed to connect "${s.key}":`, err);
      }
    }
  }

  getOpenAITools(): OpenAITool[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const route = this.routes.get(name);
    if (!route) return `Error: unknown tool "${name}"`;
    try {
      const result = await route.client.callTool({
        name: route.originalName,
        arguments: args,
      });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content
        .map((c) => (c.type === "text" ? c.text ?? "" : JSON.stringify(c)))
        .join("\n");
      return text || "(no content)";
    } catch (err) {
      return `Error calling ${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
