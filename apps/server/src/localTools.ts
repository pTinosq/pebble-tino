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

// WMO weather codes -> short descriptions.
const WMO: Record<number, string> = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
};

async function getWeather(args: Record<string, unknown>): Promise<string> {
  const place =
    typeof args.location === "string" && args.location.trim() ? args.location.trim() : "London";

  // Resolve the place name to coordinates.
  const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geoUrl.searchParams.set("name", place);
  geoUrl.searchParams.set("count", "1");
  const geoRes = await fetch(geoUrl);
  if (!geoRes.ok) return `Geocoding error: ${geoRes.status}`;
  const geo = (await geoRes.json()) as {
    results?: Array<{ latitude: number; longitude: number; name: string }>;
  };
  const loc = geo.results?.[0];
  if (!loc) return `Couldn't find a place called "${place}".`;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(loc.latitude));
  url.searchParams.set("longitude", String(loc.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m",
  );
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  const res = await fetch(url);
  if (!res.ok) return `Weather API error: ${res.status}`;
  const d = (await res.json()) as {
    current?: {
      temperature_2m?: number;
      apparent_temperature?: number;
      weather_code?: number;
      relative_humidity_2m?: number;
      wind_speed_10m?: number;
    };
    daily?: {
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
    };
  };
  const c = d.current ?? {};
  const day = d.daily ?? {};
  const desc = WMO[c.weather_code ?? -1] ?? "Unknown";
  const now = c.temperature_2m !== undefined ? `${Math.round(c.temperature_2m)}°C` : "?";
  const feels =
    c.apparent_temperature !== undefined ? ` (feels ${Math.round(c.apparent_temperature)}°)` : "";
  const hi = day.temperature_2m_max?.[0];
  const lo = day.temperature_2m_min?.[0];
  const pop = day.precipitation_probability_max?.[0];
  const range =
    hi !== undefined && lo !== undefined ? ` High ${Math.round(hi)}° / low ${Math.round(lo)}°.` : "";
  const rain = pop !== undefined ? ` ${pop}% rain.` : "";
  const hum =
    c.relative_humidity_2m !== undefined ? ` Humidity ${Math.round(c.relative_humidity_2m)}%.` : "";
  const wind =
    c.wind_speed_10m !== undefined ? ` Wind ${Math.round(c.wind_speed_10m)} km/h.` : "";
  return `${loc.name}: ${now}${feels}, ${desc}.${range}${rain}${hum}${wind}`;
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
  {
    name: "get_weather",
    description:
      "Get current weather and today's forecast for a place (defaults to London). " +
      "Pass `location` for any city name.",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City/place name, e.g. 'London', 'Paris'. Omit for London.",
        },
      },
    },
    run: getWeather,
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
