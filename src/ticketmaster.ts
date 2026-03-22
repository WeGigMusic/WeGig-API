import { env } from "./env";
import type { NormalizedEvent } from "./types/Event";

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
  startDateTime?: string;
  endDateTime?: string;
  size?: number;
}) {
  const apiKey = env.ticketmasterApiKey;
  const countryCode = env.ticketmasterCountryCode;

  const size = input.size ?? 20;

  const query = buildQuery({
    apikey: apiKey,
    countryCode,
    keyword: input.keyword,
    city: input.city,
    startDateTime: input.startDateTime,
    endDateTime: input.endDateTime,
    size,
    classificationName: "music",
    includeFuzzy: "yes",
    includeSpellcheck: "yes",
    sort: input.keyword?.trim() ? "relevance,desc" : "date,asc",
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

  setCache(cacheKey, json, 30 * 60 * 1000);

  return json;
}

export async function getTmEventByIdUk(eventId: string) {
  const apiKey = env.ticketmasterApiKey;
  const countryCode = env.ticketmasterCountryCode;

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

  setCache(cacheKey, json, 24 * 60 * 60 * 1000);

  return json;
}

export async function searchTmVenuesUk(input: {
  q: string;
  city?: string;
  size?: number;
}) {
  const apiKey = env.ticketmasterApiKey;
  const countryCode = env.ticketmasterCountryCode;

  const q = input.q.trim();
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

  setCache(cacheKey, payload, 60 * 60 * 1000);

  return payload;
}

function mapTmEventToNormalized(event: any): NormalizedEvent {
  const venue = event?._embedded?.venues?.[0];
  const attractions = event?._embedded?.attractions ?? [];

  return {
    source: "ticketmaster",
    sourceEventId: String(event?.id ?? ""),
    title: String(event?.name ?? ""),
    date: event?.dates?.start?.localDate,
    time: event?.dates?.start?.localTime,
    dateTime: event?.dates?.start?.dateTime,
    status: event?.dates?.status?.code,
    ticketUrl: event?.url,
    venueName: venue?.name,
    city: venue?.city?.name,
    countryCode: venue?.country?.countryCode,
    artists: attractions
      .filter((a: any) => a?.name)
      .map((a: any) => ({
        id: a?.id,
        name: a?.name,
      })),
  };
}

export async function searchTmEventsNormalized(input: {
  keyword?: string;
  city?: string;
  startDateTime?: string;
  endDateTime?: string;
  size?: number;
}) {
  const raw = await searchTmEventsUk(input);
  const events = raw?._embedded?.events?.map(mapTmEventToNormalized) ?? [];
  return { events };
}