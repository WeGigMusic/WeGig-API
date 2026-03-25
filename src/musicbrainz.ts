import { normaliseArtistName } from "./utils/normaliseArtistName";

type MbArtist = {
  id: string;
  name: string;
  country?: string;
  disambiguation?: string;
  score?: number;
};

type MbSearchResponse = {
  artists?: MbArtist[];
};

const MB_BASE = "https://musicbrainz.org/ws/2";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type CacheEntry<T> = { expiresAt: number; data: T };
const cache = new Map<string, CacheEntry<{ count: number; artists: MbArtist[] }>>();

let lastRequestAt = 0;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function throttleOneReqPerSec() {
  const now = Date.now();
  const delta = now - lastRequestAt;
  if (delta < 1000) await sleep(1000 - delta);
  lastRequestAt = Date.now();
}

function getUserAgent() {
  return process.env.MB_USER_AGENT || "WeGig/1.0 (contact unknown)";
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

function scoreArtistMatch(query: string, artist: MbArtist): number {
  const q = normaliseArtistName(query);
  const name = normaliseArtistName(artist.name);

  let score = 0;

  if (name === q) score += 100;
  if (name.startsWith(q)) score += 30;
  if (name.includes(q)) score += 10;
  if (artist.score) score += artist.score / 10;

  return score;
}

export async function searchMbArtists(params: { q: string; limit?: number }) {
  const q = params.q.trim();
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 25);

  const cacheKey = `mb:artist:${normaliseArtistName(q)}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  await throttleOneReqPerSec();

  const url =
    `${MB_BASE}/artist?query=${encodeURIComponent(`artist:${q}`)}` +
    `&limit=${limit}&fmt=json`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": getUserAgent(),
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MusicBrainz ${res.status}: ${text}`);
  }

  const json = (await res.json()) as MbSearchResponse;

  const artists = (json.artists ?? []).sort(
    (a, b) => scoreArtistMatch(q, b) - scoreArtistMatch(q, a),
  );

  const payload = { count: artists.length, artists };
  setCached(cacheKey, payload);
  return payload;
}