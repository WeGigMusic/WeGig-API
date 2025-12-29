// src/musicbrainz.ts
type MbArtist = {
  id: string; // MBID
  name: string;
  country?: string;
  disambiguation?: string;
  score?: number;
};

type MbSearchResponse = {
  artists?: Array<{
    id: string;
    name: string;
    country?: string;
    disambiguation?: string;
    score?: number;
  }>;
};

const MB_BASE = "https://musicbrainz.org/ws/2";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type CacheEntry<T> = { expiresAt: number; data: T };
const cache = new Map<
  string,
  CacheEntry<{ count: number; artists: MbArtist[] }>
>();

let lastRequestAt = 0;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// MusicBrainz asks for max ~1 req/sec per client
async function throttleOneReqPerSec() {
  const now = Date.now();
  const delta = now - lastRequestAt;
  if (delta < 1000) await sleep(1000 - delta);
  lastRequestAt = Date.now();
}

function getUserAgent() {
  const ua = process.env.MB_USER_AGENT;
  return ua && ua.trim()
    ? ua.trim()
    : "WeGig/0.0.0 (missing MB_USER_AGENT; contact unknown)";
}

function getCached(key: string) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key: string, data: { count: number; artists: MbArtist[] }) {
  cache.set(key, { expiresAt: Date.now() + ONE_DAY_MS, data });
}

export async function searchMbArtists(params: { q: string; limit?: number }) {
  const q = params.q.trim();
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 25);

  const cacheKey = `mb:artist:${q.toLowerCase()}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  await throttleOneReqPerSec();

  const query = `artist:${q}`;
  const url =
    `${MB_BASE}/artist` +
    `?query=${encodeURIComponent(query)}` +
    `&limit=${encodeURIComponent(String(limit))}` +
    `&fmt=json`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": getUserAgent(),
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MusicBrainz ${res.status}: ${text || res.statusText}`);
  }

  const data = (await res.json()) as MbSearchResponse;

  const artists: MbArtist[] = (data.artists ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    country: a.country,
    disambiguation: a.disambiguation,
    score: a.score,
  }));

  const payload = { count: artists.length, artists };
  setCached(cacheKey, payload);
  return payload;
}
