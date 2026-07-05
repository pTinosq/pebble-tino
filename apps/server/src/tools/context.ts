// Shared helpers handed to every tool via its ToolContext, so no tool
// re-implements fetching or place lookup. Add a capability here when more than
// one tool needs it; keep single-tool logic in the tool file.

export interface GeoResult {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  population?: number;
}

/** Capabilities every tool's execute() receives as its second argument. */
export interface ToolContext {
  /** Resolve a place name to its best-match location, or null if unknown. */
  geocode(place: string): Promise<GeoResult | null>;
  /** GET a URL and parse JSON; throws on a non-2xx response. */
  fetchJson<T>(url: string | URL): Promise<T>;
}

export async function fetchJson<T>(url: string | URL): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url.toString()).host}`);
  return (await res.json()) as T;
}

// Rank a geocoding hit: strongly prefer ones that carry a timezone (a bare
// country like "China" has none since it spans several), then by population so
// we pick a real city over a tiny same-named village.
function score(r: GeoResult): number {
  return (r.timezone ? 1e12 : 0) + (r.population ?? 0);
}

export async function geocode(place: string): Promise<GeoResult | null> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", place);
  url.searchParams.set("count", "10");
  const data = await fetchJson<{ results?: GeoResult[] }>(url);
  const results = data.results ?? [];
  if (results.length === 0) return null;
  return results.reduce((best, r) => (score(r) > score(best) ? r : best));
}
