import { env } from "./env";
import { normaliseArtistName } from "./utils/normaliseArtistName";

type SpotifyTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

type SpotifyImage = {
  url?: string;
  width?: number | null;
  height?: number | null;
};

type SpotifyArtist = {
  id: string;
  name: string;
  genres?: string[];
  popularity?: number;
  images?: SpotifyImage[];
  external_urls?: {
    spotify?: string;
  };
  followers?: {
    total?: number;
  };
};

type SpotifyAlbum = {
  id: string;
  name: string;
  album_type?: string;
  release_date?: string;
  images?: SpotifyImage[];
  external_urls?: {
    spotify?: string;
  };
};

type SpotifyAlbumTrack = {
  id: string;
  name: string;
  duration_ms?: number;
  external_urls?: {
    spotify?: string;
  };
};

type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms?: number;
  popularity?: number;
  preview_url?: string | null;
  external_urls?: {
    spotify?: string;
  };
  album?: {
    id?: string;
    name?: string;
    images?: SpotifyImage[];
  };
};

type SpotifySearchResponse = {
  artists?: {
    items?: SpotifyArtist[];
  };
};

type SpotifyArtistAlbumsResponse = {
  items?: SpotifyAlbum[];
};

type SpotifyAlbumTracksResponse = {
  items?: SpotifyAlbumTrack[];
};

type SpotifySeveralTracksResponse = {
  tracks?: SpotifyTrack[];
};

export type SpotifyArtistResult = {
  id: string;
  name: string;
  imageUrl: string | null;
  genres: string[];
  popularity: number | null;
  spotifyUrl: string | null;
  followers: number | null;
} | null;

export type SpotifyArtistPageTrack = {
  id: string;
  name: string;
  albumName: string;
  imageUrl: string | null;
  spotifyUrl: string | null;
  durationMs: number | null;
};

export type SpotifyArtistPageRelease = {
  id: string;
  name: string;
  imageUrl: string | null;
  releaseDate: string | null;
  spotifyUrl: string | null;
  albumType: string | null;
};

export type SpotifyArtistPageResult = {
  artist: SpotifyArtistResult;
  topTracks: SpotifyArtistPageTrack[];
  releases: SpotifyArtistPageRelease[];
};

type CachedArtistEntry = {
  value: SpotifyArtistResult;
  expiresAt: number;
};

type CachedArtistPageEntry = {
  value: SpotifyArtistPageResult;
  expiresAt: number;
};

let cachedToken: string | null = null;
let tokenExpiryMs = 0;

const artistCache = new Map<string, CachedArtistEntry>();
const artistPageCache = new Map<string, CachedArtistPageEntry>();

const ARTIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ARTIST_PAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function getArtistCacheKey(name: string): string {
  return normaliseArtistName(name);
}

function getCachedArtist(name: string): SpotifyArtistResult | undefined {
  const key = getArtistCacheKey(name);
  const cached = artistCache.get(key);

  if (!cached) return undefined;

  if (Date.now() >= cached.expiresAt) {
    artistCache.delete(key);
    return undefined;
  }

  return cached.value;
}

function setCachedArtist(name: string, value: SpotifyArtistResult) {
  const key = getArtistCacheKey(name);

  artistCache.set(key, {
    value,
    expiresAt: Date.now() + ARTIST_CACHE_TTL_MS,
  });
}

function getCachedArtistPage(name: string): SpotifyArtistPageResult | undefined {
  const key = getArtistCacheKey(name);
  const cached = artistPageCache.get(key);

  if (!cached) return undefined;

  if (Date.now() >= cached.expiresAt) {
    artistPageCache.delete(key);
    return undefined;
  }

  return cached.value;
}

function setCachedArtistPage(name: string, value: SpotifyArtistPageResult) {
  const key = getArtistCacheKey(name);

  artistPageCache.set(key, {
    value,
    expiresAt: Date.now() + ARTIST_PAGE_CACHE_TTL_MS,
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

async function spotifyGet<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const token = await getSpotifyAccessToken();

  const url = new URL(`https://api.spotify.com/v1${path}`);

  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify GET failed: ${res.status} ${path} ${text}`);
  }

  return (await res.json()) as T;
}

function tokenizeArtistName(value: string): string[] {
  return normaliseArtistName(value)
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreArtistMatch(query: string, artist: SpotifyArtist): number {
  const q = normaliseArtistName(query);
  const name = normaliseArtistName(artist.name);

  if (!q || !name) return 0;

  const qTokens = tokenizeArtistName(query);
  const nameTokens = tokenizeArtistName(artist.name);

  const qJoined = qTokens.join(" ");
  const nameJoined = nameTokens.join(" ");

  let score = 0;

  if (nameJoined === qJoined) {
    score += 1000;
  }

  if (name === q) {
    score += 1000;
  }

  if (
    qTokens.length === nameTokens.length &&
    qTokens.every((token, index) => token === nameTokens[index])
  ) {
    score += 500;
  }

  const sharedTokenCount = qTokens.filter((token) =>
    nameTokens.includes(token),
  ).length;

  if (sharedTokenCount > 0) {
    score += sharedTokenCount * 80;
  }

  if (name.startsWith(q)) {
    score += 120;
  }

  if (nameJoined.startsWith(qJoined)) {
    score += 120;
  }

  if (qTokens.length > 1) {
    const allQueryTokensPresent = qTokens.every((token) =>
      nameTokens.includes(token),
    );

    if (allQueryTokensPresent) {
      score += 220;
    }
  }

  if (name.includes(q) && name !== q) {
    score += 20;
  }

  if (q.includes(name) && name !== q) {
    score += 10;
  }

  // popularity is only a weak tiebreaker now
  score += Math.min((artist.popularity ?? 0) / 10, 8);

  return score;
}

function isStrongArtistMatch(query: string, artist: SpotifyArtist): boolean {
  const q = normaliseArtistName(query);
  const name = normaliseArtistName(artist.name);

  if (!q || !name) return false;
  if (q === name) return true;

  const qTokens = tokenizeArtistName(query);
  const nameTokens = tokenizeArtistName(artist.name);

  const allQueryTokensPresent =
    qTokens.length > 0 && qTokens.every((token) => nameTokens.includes(token));

  if (allQueryTokensPresent && qTokens.length >= 2) {
    return true;
  }

  const score = scoreArtistMatch(query, artist);
  return score >= 240;
}

function mapSpotifyArtistResult(
  artist: SpotifyArtist,
): NonNullable<SpotifyArtistResult> {
  return {
    id: artist.id,
    name: artist.name,
    imageUrl: artist.images?.[0]?.url ?? null,
    genres: artist.genres ?? [],
    popularity:
      typeof artist.popularity === "number" ? artist.popularity : null,
    spotifyUrl: artist.external_urls?.spotify ?? null,
    followers:
      typeof artist.followers?.total === "number"
        ? artist.followers.total
        : null,
  };
}

function dedupeAlbums(albums: SpotifyAlbum[]): SpotifyAlbum[] {
  const seen = new Set<string>();

  return albums.filter((album) => {
    const key = `${normaliseArtistName(album.name)}::${album.album_type ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeTrackCandidates<
  T extends SpotifyAlbumTrack & { album: SpotifyAlbum; albumTrackNumber?: number },
>(tracks: T[]): T[] {
  const seen = new Set<string>();

  return tracks.filter((track) => {
    const key = `${normaliseArtistName(track.name)}::${track.duration_ms ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getSpotifyArtistAlbums(artistId: string): Promise<SpotifyAlbum[]> {
  const json = await spotifyGet<SpotifyArtistAlbumsResponse>(
    `/artists/${artistId}/albums`,
    {
      include_groups: "album,single",
      limit: 10,
      market: "GB",
    },
  );

  return dedupeAlbums(json.items ?? []);
}

async function getSpotifyAlbumTracks(albumId: string): Promise<SpotifyAlbumTrack[]> {
  const json = await spotifyGet<SpotifyAlbumTracksResponse>(
    `/albums/${albumId}/tracks`,
    {
      limit: 50,
      market: "GB",
    },
  );

  return json.items ?? [];
}

async function getSpotifyTracks(ids: string[]): Promise<SpotifyTrack[]> {
  if (ids.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) {
    chunks.push(ids.slice(i, i + 50));
  }

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const json = await spotifyGet<SpotifySeveralTracksResponse>("/tracks", {
        ids: chunk.join(","),
        market: "GB",
      });

      return json.tracks ?? [];
    }),
  );

  return results.flat().filter((track): track is SpotifyTrack => Boolean(track));
}

async function getBestMatchingSpotifyArtist(
  name: string,
): Promise<SpotifyArtist | null> {
  const query = name.trim();
  if (!query) return null;

  const json = await spotifyGet<SpotifySearchResponse>("/search", {
    q: query,
    type: "artist",
    limit: 8,
  });

  const artists = json.artists?.items ?? [];
  if (artists.length === 0) return null;

  const ranked = [...artists]
    .map((artist) => ({
      artist,
      score: scoreArtistMatch(query, artist),
    }))
    .sort((a, b) => b.score - a.score);

  console.log("[spotify] artist candidates", {
    query,
    candidates: ranked.map(({ artist, score }) => ({
      name: artist.name,
      id: artist.id,
      popularity: artist.popularity ?? null,
      score,
    })),
  });

  const best = ranked[0];
  if (!best) return null;

  if (!isStrongArtistMatch(query, best.artist)) {
    console.warn("[spotify] rejected weak artist match", {
      query,
      chosenName: best.artist.name,
      chosenId: best.artist.id,
      score: best.score,
    });
    return null;
  }

  return best.artist;
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

  const best = await getBestMatchingSpotifyArtist(query);

  if (!best) {
    setCachedArtist(query, null);
    return null;
  }

  const result = mapSpotifyArtistResult(best);
  setCachedArtist(query, result);
  return result;
}

async function getDerivedTopTracksFromAlbums(
  albums: SpotifyAlbum[],
): Promise<SpotifyArtistPageTrack[]> {
  const candidateAlbums = albums.slice(0, 8);

  const albumTrackGroups = await Promise.all(
    candidateAlbums.map(async (album) => {
      const tracks = await getSpotifyAlbumTracks(album.id);
      return tracks.map((track, index) => ({
        ...track,
        album,
        albumTrackNumber: index + 1,
      }));
    }),
  );

  const dedupedCandidates = dedupeTrackCandidates(albumTrackGroups.flat());

  return dedupedCandidates
    .sort((a, b) => {
      const aIsAlbum = a.album.album_type === "album" ? 1 : 0;
      const bIsAlbum = b.album.album_type === "album" ? 1 : 0;

      if (bIsAlbum !== aIsAlbum) return bIsAlbum - aIsAlbum;

      const aDate = a.album.release_date ?? "";
      const bDate = b.album.release_date ?? "";
      if (bDate !== aDate) return bDate.localeCompare(aDate);

      return (a.albumTrackNumber ?? 999) - (b.albumTrackNumber ?? 999);
    })
    .slice(0, 5)
    .map((track) => ({
      id: track.id,
      name: track.name,
      albumName: track.album.name ?? "",
      imageUrl: track.album.images?.[0]?.url ?? null,
      spotifyUrl:
        track.external_urls?.spotify ??
        track.album.external_urls?.spotify ??
        null,
      durationMs:
        typeof track.duration_ms === "number" ? track.duration_ms : null,
    }));
}

async function getDerivedTopTracks(
  artistId: string,
): Promise<SpotifyArtistPageTrack[]> {
  const albums = await getSpotifyArtistAlbums(artistId);
  return getDerivedTopTracksFromAlbums(albums);
}

function mapReleases(albums: SpotifyAlbum[]): SpotifyArtistPageRelease[] {
  return albums.slice(0, 6).map((album) => ({
    id: album.id,
    name: album.name,
    imageUrl: album.images?.[0]?.url ?? null,
    releaseDate: album.release_date ?? null,
    spotifyUrl: album.external_urls?.spotify ?? null,
    albumType: album.album_type ?? null,
  }));
}

export async function getSpotifyArtistPage(
  name: string,
): Promise<SpotifyArtistPageResult> {
  const query = name.trim();

  if (!query) {
    return {
      artist: null,
      topTracks: [],
      releases: [],
    };
  }

  const cached = getCachedArtistPage(query);
  if (cached !== undefined) {
    return cached;
  }

  const best = await getBestMatchingSpotifyArtist(query);

  if (!best) {
    const emptyResult: SpotifyArtistPageResult = {
      artist: null,
      topTracks: [],
      releases: [],
    };

    setCachedArtist(query, null);
    setCachedArtistPage(query, emptyResult);
    return emptyResult;
  }

  const artist = mapSpotifyArtistResult(best);

  let albums: SpotifyAlbum[] = [];
  let topTracks: SpotifyArtistPageTrack[] = [];
  let releases: SpotifyArtistPageRelease[] = [];

  try {
    albums = await getSpotifyArtistAlbums(best.id);
    releases = mapReleases(albums);
  } catch (error) {
    console.error("[spotify] failed to fetch albums", {
      query,
      artistId: best.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    if (albums.length > 0) {
      topTracks = await getDerivedTopTracksFromAlbums(albums);
    }
  } catch (error) {
    console.error("[spotify] failed to build top tracks", {
      query,
      artistId: best.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const result: SpotifyArtistPageResult = {
    artist,
    topTracks,
    releases,
  };

  setCachedArtist(query, artist);
  setCachedArtistPage(query, result);

  return result;
}