// OpenRouter chat + tool-calling loop.
// Sends the question to a Gemini model with the MCP tools exposed as functions,
// executes any tool calls the model makes, and loops until it produces a final
// text answer for the watch.

import { MODEL, OPENROUTER_API_KEY } from "./config.js";
import type { McpManager } from "./mcp.js";

const MAX_STEPS = 6;

function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "You are a helpful voice assistant answering on a tiny smartwatch screen.",
    `Today is ${today}.`,
    "Use the available tools to read and act on the user's Notion, Gmail, and",
    "Google Calendar when the question calls for it. Prefer a tool over guessing.",
    "When asked to search or check something, call the relevant tool with a",
    "reasonable query yourself — do not ask the user for clarification first.",
    "Never invent results; only state what a tool actually returned.",
    "Reply in plain text only (no markdown, no code fences).",
    "Be direct and keep answers under 350 characters.",
  ].join(" ");
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

export async function askAssistant(question: string, mcp: McpManager): Promise<string> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");

  const tools = mcp.getOpenAITools();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt() },
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
        const result = await mcp.callTool(tc.function.name, args);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      continue; // let the model see the tool results
    }

    return (msg.content ?? "").trim() || "(no answer)";
  }

  return "That took too many steps — try rephrasing your question.";
}
