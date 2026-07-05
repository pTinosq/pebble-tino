// OpenRouter chat + tool-calling loop.
// Sends the question to a Gemini model with the MCP tools exposed as functions,
// executes any tool calls the model makes, and loops until it produces a final
// text answer for the watch.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { MODEL, OPENROUTER_API_KEY } from "./config.js";
import type { McpManager } from "./mcp.js";
import { localToolsAsOpenAI, callLocalTool } from "./tools/index.js";

const MAX_STEPS = 6;

// System prompt lives in prompts/system.md (edit it there, not here).
// Resolved relative to this module so it works under both tsx (src/) and the
// compiled build (dist/); {{today}} is filled in at request time.
const PROMPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "system.md");
const PROMPT_TEMPLATE = readFileSync(PROMPT_PATH, "utf8");

function systemPrompt(): string {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Human-readable local time with timezone name + UTC offset, so the model can
  // reason about "what time is it in X" instead of guessing.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; // e.g. "America/New_York"
  const nowStr = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
    hour12: false,
    timeZone: tz,
  }).format(now); // e.g. "Sunday, July 5, 2026, 14:30 GMT-4"

  return PROMPT_TEMPLATE.replace(/\{\{\s*today\s*\}\}/g, today)
    .replace(/\{\{\s*now\s*\}\}/g, `${nowStr} (${tz})`)
    .trim();
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// Prior conversation turns sent by the client (final Q/A pairs only).
export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
}

export async function askAssistant(
  question: string,
  mcp: McpManager,
  history: TurnMessage[] = [],
): Promise<string> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");

  const tools = [...mcp.getOpenAITools(), ...localToolsAsOpenAI()];
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt() },
    ...history,
    { role: "user", content: question },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "X-Title": "Pebble Assistant",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? "auto" : undefined,
        // Privacy: strict Zero-Data-Retention — only route to endpoints that
        // don't retain data, and never to providers that store/train on inputs.
        // (Your Notion/Slack content flows through here.)
        provider: { zdr: true, data_collection: "deny" },
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { choices: { message: ChatMessage }[] };
    const msg = data.choices[0].message;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // leave args empty on malformed JSON
        }
        console.log(`[tool] ${tc.function.name}(${tc.function.arguments})`);
        // Local tools first; fall through to MCP if not a local tool.
        const local = await callLocalTool(tc.function.name, args);
        const result = local !== null ? local : await mcp.callTool(tc.function.name, args);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      continue; // let the model see the tool results
    }

    // Strip any tool-call narration the model leaks into the final text.
    const clean = (msg.content ?? "")
      .split("\n")
      .filter((line) => !/^\s*(calling tool|responding to tool)\b/i.test(line))
      .join("\n")
      .trim();
    return clean || "(no answer)";
  }

  return "That took too many steps — try rephrasing your question.";
}
