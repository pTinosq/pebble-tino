// Local tools — implemented directly in the backend (no MCP server needed).
// Use these to wrap simple REST APIs we control and expose them to the LLM as
// OpenAI-style function tools alongside the MCP tools.

export interface LocalTool {
  name: string;
  description: string;
  parameters: unknown; // JSON schema
  run: (args: Record<string, unknown>) => Promise<string>;
}

const TFL_BASE = "https://api.tfl.gov.uk";
const TFL_APP_KEY = process.env.TFL_APP_KEY; // optional — raises rate limits

async function tflTubeStatus(args: Record<string, unknown>): Promise<string> {
  const line = typeof args.line === "string" ? args.line.trim().toLowerCase() : "";
  const u = new URL(
    line ? `${TFL_BASE}/Line/${encodeURIComponent(line)}/Status` : `${TFL_BASE}/Line/Mode/tube/Status`,
  );
  if (TFL_APP_KEY) u.searchParams.set("app_key", TFL_APP_KEY);

  const res = await fetch(u);
  if (!res.ok) return `TFL API error: ${res.status}`;
  const data = (await res.json()) as Array<{
    name: string;
    lineStatuses?: Array<{ statusSeverityDescription?: string; reason?: string }>;
  }>;
  if (!Array.isArray(data) || data.length === 0) return "No tube line status found.";

  return data
    .map((l) => {
      const st = l.lineStatuses?.[0];
      const desc = st?.statusSeverityDescription ?? "Unknown";
      const reason = st?.reason ? ` — ${st.reason}` : "";
      return `${l.name}: ${desc}${reason}`;
    })
    .join("\n");
}

export const localTools: LocalTool[] = [
  {
    name: "tfl_tube_status",
    description:
      "Get current London Underground (tube) line status. Optionally pass a specific line id " +
      "(e.g. victoria, central, northern, jubilee, bakerloo, circle, district, hammersmith-city, " +
      "metropolitan, piccadilly, waterloo-city). Omit `line` for all lines.",
    parameters: {
      type: "object",
      properties: {
        line: {
          type: "string",
          description: "Tube line id (lowercase, dash-separated). Omit for all lines.",
        },
      },
    },
    run: tflTubeStatus,
  },
];

export function localToolsAsOpenAI() {
  return localTools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Returns the tool output, or null if `name` isn't a local tool (caller then
// falls through to MCP).
export async function callLocalTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const t = localTools.find((x) => x.name === name);
  if (!t) return null;
  try {
    return await t.run(args);
  } catch (err) {
    return `Error in ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
