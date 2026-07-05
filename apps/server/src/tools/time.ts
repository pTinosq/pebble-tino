import { z } from "zod";
import { defineTool } from "./define.js";

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const getTime = defineTool({
  name: "get_time",
  description:
    "Get the current date and time for a place (defaults to the user's local time). " +
    "ALWAYS use this for any 'what time is it' question — never compute times yourself. " +
    "Pass a CITY as `location`; for a country, pass its capital or largest city " +
    "(e.g. China → 'Beijing', USA → 'New York'). Omit for local time.",
  schema: z.object({
    location: z
      .string()
      .optional()
      .describe(
        "A city name, e.g. 'Beijing', 'Tokyo'. For a country, use its capital/largest city. " +
          "Omit for the user's local time.",
      ),
  }),
  async execute({ location }, { geocode }) {
    let timeZone = LOCAL_TZ;
    let label = "local time";

    const place = location?.trim();
    if (place) {
      const loc = await geocode(place);
      if (!loc?.timezone) {
        return `Couldn't find the timezone for "${place}". Try a major city name.`;
      }
      timeZone = loc.timezone;
      label = loc.country ? `${loc.name}, ${loc.country}` : loc.name;
    }

    const formatted = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "shortOffset",
      hour12: true,
      timeZone,
    }).format(new Date());

    return `${label}: ${formatted} (${timeZone})`;
  },
});
