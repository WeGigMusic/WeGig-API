type CacheEntry<T> = { value: T; expiresAt: number };

const cache = new Map<string, CacheEntry<any>>();

function getCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function setCache<T>(key: string, value: T, ttlMs: number) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function buildQuery(params: Record<string, string | number | undefined>) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    usp.set(k, String(v));
  }
  return usp.toString();
}

const TM_BASE = "https://app.ticketmaster.com/discovery/v2";

function requireApiKey() {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) throw new Error("Missing TICKETMASTER_API_KEY secret");
  return key;
}

export type TmEventSummary = {
  id: string;
  name: string;
  url?: string;
  dates?: {
    start?: { localDate?: string; localTime?: string; dateTime?: string };
    status?: { code?: string };
  };
  _embedded?: {
    venues?: Array<{
      name?: string;
      city?: { name?: string };
      country?: { countryCode?: string };
      address?: { line1?: string };
    }>;
    attractions?: Array<{ name?: string; id?: string }>;
  };
};

export async function searchTmEventsUk(input: {
  keyword?: string;
  city?: string;
  startDateTime?: string; // ISO e.g. 2025-01-01T00:00:00Z
  endDateTime?: string; // ISO
  size?: number; // default 20
}) {
  const apiKey = requireApiKey();
  const countryCode = process.env.TICKETMASTER_COUNTRY_CODE || "GB";

  const size = input.size ?? 20;

  const query = buildQuery({
    apikey: apiKey,
    countryCode,
    keyword: input.keyword,
    city: input.city,
    startDateTime: input.startDateTime,
    endDateTime: input.endDateTime,
    size,
    sort: "date,asc",
  });

  const cacheKey = `tm:search:${query}`;
  const cached = getCache<any>(cacheKey);
  if (cached) return cached;

  const url = `${TM_BASE}/events.json?${query}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ticketmaster error ${res.status}: ${text || res.statusText}`,
    );
  }

  const json = await res.json();

  // Cache for 30 minutes (tune later)
  setCache(cacheKey, json, 30 * 60 * 1000);

  return json;
}

export async function getTmEventByIdUk(eventId: string) {
  const apiKey = requireApiKey();
  const countryCode = process.env.TICKETMASTER_COUNTRY_CODE || "GB";

  const query = buildQuery({ apikey: apiKey, countryCode });
  const cacheKey = `tm:event:${eventId}:${query}`;
  const cached = getCache<any>(cacheKey);
  if (cached) return cached;

  const url = `${TM_BASE}/events/${encodeURIComponent(eventId)}.json?${query}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ticketmaster error ${res.status}: ${text || res.statusText}`,
    );
  }

  const json = await res.json();

  // Cache event details for 24 hours
  setCache(cacheKey, json, 24 * 60 * 60 * 1000);

  return json;
}

export async function searchTmVenuesUk(input: {
  q: string;
  city?: string;
  size?: number;
}) {
  const apiKey = requireApiKey();
  const countryCode = process.env.TICKETMASTER_COUNTRY_CODE || "GB";

  const q = (input.q ?? "").trim();
  if (!q) return { venues: [] };

  const size = input.size ?? 8;

  const query = buildQuery({
    apikey: apiKey,
    countryCode,
    keyword: q,
    city: input.city,
    size,
  });

  const cacheKey = `tm:venues:${query}`;
  const cached = getCache<any>(cacheKey);
  if (cached) return cached;

  const url = `${TM_BASE}/venues.json?${query}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ticketmaster error ${res.status}: ${text || res.statusText}`,
    );
  }

  const json = await res.json();

  const venues =
    (json?._embedded?.venues ?? []).map((v: any) => ({
      id: v?.id,
      name: v?.name,
      city: v?.city?.name ?? null,
      countryCode: v?.country?.countryCode ?? null,
    })) ?? [];

  const payload = { venues };

  // Cache venues longer (tune later)
  setCache(cacheKey, payload, 60 * 60 * 1000);

  return payload;
}
