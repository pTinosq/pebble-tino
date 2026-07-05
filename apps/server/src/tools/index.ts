// Local tools — implemented in the backend (no MCP server needed) and exposed
// to the LLM as OpenAI-style function tools alongside the MCP tools.
//
// To add a tool: create a file that exports a defineTool({...}) and register it
// in the `localTools` array below. See define.ts for the contract.

import type { LocalTool, ToolContext } from "./define.js";
import { geocode, fetchJson } from "./context.js";
import { tflTubeStatus } from "./tfl.js";
import { getTime } from "./time.js";
import { getWeather } from "./weather.js";

/** Every backend tool, in the order the model sees them. */
export const localTools: LocalTool[] = [tflTubeStatus, getTime, getWeather];

// Shared capabilities handed to each tool's execute().
const ctx: ToolContext = { geocode, fetchJson };

export function localToolsAsOpenAI() {
  return localTools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Runs the named local tool, or returns null if `name` isn't one (the caller
// then falls through to MCP). Any thrown error becomes a readable tool result.
export async function callLocalTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const tool = localTools.find((t) => t.name === name);
  if (!tool) return null;
  try {
    return await tool.run(args, ctx);
  } catch (err) {
    return `Error in ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
