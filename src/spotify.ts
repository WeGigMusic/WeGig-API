import { env } from "./env";
import { normaliseArtistName } from "./utils/normaliseArtistName";

type SpotifyTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

type SpotifyArtistImage = {
  url?: string;
  width?: number | null;
  height?: number | null;
};

type SpotifyArtist = {
  id: string;
  name: string;
  genres?: string[];
  popularity?: number;
  images?: SpotifyArtistImage[];
  external_urls?: {
    spotify?: string;
  };
};

type SpotifySearchResponse = {
  artists?: {
    items?: SpotifyArtist[];
  };
};

type SpotifyArtistResult = {
  id: string;
  name: string;
  imageUrl: string | null;
  genres: string[];
  popularity: number | null;
  spotifyUrl: string | null;
} | null;

type CachedArtistEntry = {
  value: SpotifyArtistResult;
  expiresAt: number;
};

let cachedToken: string | null = null;
let tokenExpiryMs = 0;

const artistCache = new Map<string, CachedArtistEntry>();
const ARTIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCachedArtist(name: string): SpotifyArtistResult | undefined {
  const key = normaliseArtistName(name);
  const cached = artistCache.get(key);

  if (!cached) return undefined;

  if (Date.now() >= cached.expiresAt) {
    artistCache.delete(key);
    return undefined;
  }

  return cached.value;
}

function setCachedArtist(name: string, value: SpotifyArtistResult) {
  const key = normaliseArtistName(name);

  artistCache.set(key, {
    value,
    expiresAt: Date.now() + ARTIST_CACHE_TTL_MS,
  });
}

async function getSpotifyAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < tokenExpiryMs) {
    return cachedToken;
  }

  const auth = Buffer.from(
    `${env.spotifyClientId}:${env.spotifyClientSecret}`,
  ).toString("base64");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify token failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as SpotifyTokenResponse;

  cachedToken = json.access_token;
  tokenExpiryMs = now + json.expires_in * 1000 - 60_000;

  return cachedToken;
}

function scoreArtistMatch(query: string, artist: SpotifyArtist): number {
  const q = normaliseArtistName(query);
  const name = normaliseArtistName(artist.name);

  let score = 0;

  if (name === q) score += 100;
  if (name.startsWith(q)) score += 30;
  if (name.includes(q)) score += 10;
  score += (artist.popularity ?? 0) / 20;

  return score;
}

export async function searchSpotifyArtist(
  name: string,
): Promise<SpotifyArtistResult> {
  const query = name.trim();
  if (!query) return null;

  const cached = getCachedArtist(query);
  if (cached !== undefined) {
    return cached;
  }

  const token = await getSpotifyAccessToken();

  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(
      query,
    )}&type=artist&limit=5`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify artist search failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as SpotifySearchResponse;
  const artists = json.artists?.items ?? [];

  if (artists.length === 0) {
    setCachedArtist(query, null);
    return null;
  }

  const best = [...artists].sort(
    (a, b) => scoreArtistMatch(query, b) - scoreArtistMatch(query, a),
  )[0];

  const result: SpotifyArtistResult = {
    id: best.id,
    name: best.name,
    imageUrl: best.images?.[0]?.url ?? null,
    genres: best.genres ?? [],
    popularity:
      typeof best.popularity === "number" ? best.popularity : null,
    spotifyUrl: best.external_urls?.spotify ?? null,
  };

  setCachedArtist(query, result);
  return result;
}