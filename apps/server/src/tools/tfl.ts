import { z } from "zod";
import { defineTool } from "./define.js";

const TFL_BASE = "https://api.tfl.gov.uk";
const TFL_APP_KEY = process.env.TFL_APP_KEY; // optional — raises rate limits

interface TflLine {
  name: string;
  lineStatuses?: Array<{ statusSeverityDescription?: string; reason?: string }>;
}

export const tflTubeStatus = defineTool({
  name: "tfl_tube_status",
  description:
    "Get current London Underground (tube) line status. Optionally pass a specific line id " +
    "(e.g. victoria, central, northern, jubilee, bakerloo, circle, district, hammersmith-city, " +
    "metropolitan, piccadilly, waterloo-city). Omit `line` for all lines.",
  schema: z.object({
    line: z
      .string()
      .optional()
      .describe("Tube line id (lowercase, dash-separated). Omit for all lines."),
  }),
  async execute({ line }, { fetchJson }) {
    const id = line?.trim().toLowerCase() ?? "";
    const u = new URL(
      id ? `${TFL_BASE}/Line/${encodeURIComponent(id)}/Status` : `${TFL_BASE}/Line/Mode/tube/Status`,
    );
    if (TFL_APP_KEY) u.searchParams.set("app_key", TFL_APP_KEY);

    const data = await fetchJson<TflLine[]>(u);
    if (!Array.isArray(data) || data.length === 0) return "No tube line status found.";

    return data
      .map((l) => {
        const st = l.lineStatuses?.[0];
        const desc = st?.statusSeverityDescription ?? "Unknown";
        const reason = st?.reason ? ` — ${st.reason}` : "";
        return `${l.name}: ${desc}${reason}`;
      })
      .join("\n");
  },
});
