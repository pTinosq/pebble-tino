import { z } from "zod";
import { defineTool } from "./define.js";

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

interface Forecast {
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
}

export const getWeather = defineTool({
  name: "get_weather",
  description:
    "Get current weather and today's forecast for a place (defaults to London). " +
    "Pass `location` for any city name.",
  schema: z.object({
    location: z
      .string()
      .optional()
      .describe("City/place name, e.g. 'London', 'Paris'. Omit for London."),
  }),
  async execute({ location }, { geocode, fetchJson }) {
    const place = location?.trim() || "London";
    const loc = await geocode(place);
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

    const d = await fetchJson<Forecast>(url);
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
  },
});
