import { env } from "./env";
import { normaliseArtistName } from "./utils/normaliseArtistName";

type LastFmSimilarArtistRaw = {
  name?: string;
  url?: string;
};

type LastFmArtistMatches = {
  artist?: LastFmSimilarArtistRaw[] | LastFmSimilarArtistRaw;
};

type LastFmSimilarArtistsResponse = {
  similarartists?: LastFmArtistMatches;
};

export type LastFmSimilarArtist = {
  name: string;
  url: string | null;
};

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

type CachedSimilarArtistsEntry = {
  value: LastFmSimilarArtist[];
  expiresAt: number;
};

const cache = new Map<string, CachedSimilarArtistsEntry>();

function getCacheKey(artistName: string): string {
  return normaliseArtistName(artistName);
}

function getCached(artistName: string): LastFmSimilarArtist[] | undefined {
  const key = getCacheKey(artistName);
  const cached = cache.get(key);

  if (!cached) return undefined;

  if (Date.now() >= cached.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  return cached.value;
}

function setCached(artistName: string, value: LastFmSimilarArtist[]) {
  const key = getCacheKey(artistName);

  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function lastFmGet<T>(
  params: Record<string, string | number | undefined>,
): Promise<T> {
  if (!env.lastFmApiKey) {
    throw new Error("LASTFM_API_KEY is not configured");
  }

  const url = new URL("https://ws.audioscrobbler.com/2.0/");

  url.searchParams.set("api_key", env.lastFmApiKey);
  url.searchParams.set("format", "json");

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const res = await fetch(url.toString());

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Last.fm GET failed: ${res.status} ${text}`);
  }

  return (await res.json()) as T;
}

export async function getLastFmSimilarArtists(
  artistName: string,
): Promise<LastFmSimilarArtist[]> {
  const query = artistName.trim();
  if (!query) return [];

  const cached = getCached(query);
  if (cached !== undefined) {
    return cached;
  }

  const json = await lastFmGet<LastFmSimilarArtistsResponse>({
    method: "artist.getsimilar",
    artist: query,
    limit: 8,
    autocorrect: 1,
  });

  const artists = toArray(json.similarartists?.artist)
    .map((artist) => ({
      name: String(artist.name ?? "").trim(),
      url: artist.url?.trim() ?? null,
    }))
    .filter((artist) => artist.name.length > 0);

  setCached(query, artists);
  return artists;
}