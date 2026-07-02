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
    "You are a voice assistant on a Pebble smartwatch. The user speaks a question",
    "and reads a short answer — they CANNOT type or answer follow-up questions.",
    `Today is ${today}.`,
    "You have tools to search and act on the user's Notion, Gmail, and Google Calendar.",
    "RULES:",
    "1. NEVER reply with a clarifying question. If a request needs data, immediately",
    "   call a tool with your best-guess arguments.",
    "2. For a general Notion request (e.g. 'what's on my Notion', 'search my notion',",
    "   'my tasks'), call the Notion search tool with an empty or broad query to list",
    "   recent pages, then summarize what came back.",
    "3. Only state what a tool actually returned — never invent titles, events, or data.",
    "4. Output ONLY the final answer for the user. Do NOT narrate or mention which",
    "   tools or queries you used (no 'Calling tool…', no 'Responding to tool…').",
    "5. Reply in plain text (no markdown). Be concise — under 1000 characters —",
    "   but ALWAYS include every item the user asked for (if they ask for 3 things,",
    "   give all 3, each on its own short line).",
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
