import { env } from "./env";
import { normaliseArtistName } from "./utils/normaliseArtistName";
import {
  searchAppleMusicArtistImage,
  searchAppleMusicReleaseImage,
} from "./appleMusic";
import {
  searchMbArtists,
  getArtistReleases,
  type ArtistRelease,
} from "./musicbrainz";

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

export type SpotifyArtistPageRelease = ArtistRelease;

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

function getArtistPageCacheKey(name: string): string {
  return `${normaliseArtistName(name)}:v5`;
}

function getCachedArtist(
  name: string,
): SpotifyArtistResult | undefined {
  const key = getArtistCacheKey(name);
  const cached = artistCache.get(key);

  if (!cached) {
    return undefined;
  }

  if (Date.now() >= cached.expiresAt) {
    artistCache.delete(key);
    return undefined;
  }

  return cached.value;
}

function setCachedArtist(
  name: string,
  value: SpotifyArtistResult,
) {
  artistCache.set(getArtistCacheKey(name), {
    value,
    expiresAt: Date.now() + ARTIST_CACHE_TTL_MS,
  });
}

function getCachedArtistPage(
  name: string,
): SpotifyArtistPageResult | undefined {
  const key = getArtistPageCacheKey(name);
  const cached = artistPageCache.get(key);

  if (!cached) {
    return undefined;
  }

  if (Date.now() >= cached.expiresAt) {
    artistPageCache.delete(key);
    return undefined;
  }

  return cached.value;
}

function setCachedArtistPage(
  name: string,
  value: SpotifyArtistPageResult,
) {
  if (
    value.topTracks.length === 0 &&
    value.releases.length === 0
  ) {
    return;
  }

  artistPageCache.set(getArtistPageCacheKey(name), {
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

  const res = await fetch(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");

    throw new Error(
      `Spotify token failed: ${res.status} ${text}`,
    );
  }

  const json = (await res.json()) as SpotifyTokenResponse;

  cachedToken = json.access_token;

  tokenExpiryMs =
    now + json.expires_in * 1000 - 60_000;

  return cachedToken;
}

async function spotifyGet<T>(
  path: string,
  query?: Record<
    string,
    string | number | undefined
  >,
): Promise<T> {
  const token = await getSpotifyAccessToken();

  const url = new URL(
    `https://api.spotify.com/v1${path}`,
  );

  Object.entries(query ?? {}).forEach(
    ([key, value]) => {
      if (
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        url.searchParams.set(key, String(value));
      }
    },
  );

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");

    throw new Error(
      `Spotify GET failed: ${res.status} ${path} ${text}`,
    );
  }

  return (await res.json()) as T;
}

function tokenizeArtistName(
  value: string,
): string[] {
  return normaliseArtistName(value)
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreArtistMatch(
  query: string,
  artist: SpotifyArtist,
): number {
  const q = normaliseArtistName(query);
  const name = normaliseArtistName(artist.name);

  if (!q || !name) {
    return 0;
  }

  const qTokens = tokenizeArtistName(query);
  const nameTokens = tokenizeArtistName(
    artist.name,
  );

  let score = 0;

  if (name === q) {
    score += 2000;
  }

  const sharedTokenCount = qTokens.filter(
    (token) => nameTokens.includes(token),
  ).length;

  score += sharedTokenCount * 80;

  if (name.startsWith(q)) {
    score += 120;
  }

  if (
    qTokens.length > 1 &&
    qTokens.every((token) =>
      nameTokens.includes(token),
    )
  ) {
    score += 220;
  }

  score += Math.min(
    (artist.popularity ?? 0) / 10,
    8,
  );

  return score;
}

function isStrongArtistMatch(
  query: string,
  artist: SpotifyArtist,
): boolean {
  const q = normaliseArtistName(query);
  const name = normaliseArtistName(artist.name);

  if (!q || !name) {
    return false;
  }

  if (q === name) {
    return true;
  }

  const qTokens = tokenizeArtistName(query);
  const nameTokens = tokenizeArtistName(
    artist.name,
  );

  if (
    qTokens.length >= 2 &&
    qTokens.every((token) =>
      nameTokens.includes(token),
    )
  ) {
    return true;
  }

  return scoreArtistMatch(query, artist) >= 240;
}

function getBestSpotifyImage(
  images?: SpotifyImage[],
): string | null {
  if (!images || images.length === 0) {
    return null;
  }

  const sorted = [...images].sort((a, b) => {
    const aSize =
      (a.width ?? 0) * (a.height ?? 0);

    const bSize =
      (b.width ?? 0) * (b.height ?? 0);

    return bSize - aSize;
  });

  return sorted[0]?.url ?? null;
}

function mapSpotifyArtistResult(
  artist: SpotifyArtist,
): NonNullable<SpotifyArtistResult> {
  return {
    id: artist.id,
    name: artist.name,
    imageUrl: getBestSpotifyImage(
      artist.images,
    ),
    genres: artist.genres ?? [],
    popularity:
      typeof artist.popularity === "number"
        ? artist.popularity
        : null,
    spotifyUrl:
      artist.external_urls?.spotify ?? null,
    followers:
      typeof artist.followers?.total === "number"
        ? artist.followers.total
        : null,
  };
}

function dedupeAlbums(
  albums: SpotifyAlbum[],
): SpotifyAlbum[] {
  const seen = new Set<string>();

  return albums.filter((album) => {
    const key =
      `${normaliseArtistName(album.name)}::` +
      `${album.album_type ?? ""}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

function dedupeTrackCandidates<
  T extends SpotifyAlbumTrack & {
    album: SpotifyAlbum;
    albumTrackNumber?: number;
  },
>(tracks: T[]): T[] {
  const seen = new Set<string>();

  return tracks.filter((track) => {
    const key =
      `${normaliseArtistName(track.name)}::` +
      `${track.duration_ms ?? 0}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

async function getSpotifyArtistAlbums(
  artistId: string,
): Promise<SpotifyAlbum[]> {
  const json =
    await spotifyGet<SpotifyArtistAlbumsResponse>(
      `/artists/${artistId}/albums`,
      {
        include_groups: "album,single",
        limit: 20,
      },
    );

  return dedupeAlbums(json.items ?? []);
}

async function getSpotifyAlbumTracks(
  albumId: string,
): Promise<SpotifyAlbumTrack[]> {
  const json =
    await spotifyGet<SpotifyAlbumTracksResponse>(
      `/albums/${albumId}/tracks`,
      {
        limit: 50,
      },
    );

  return json.items ?? [];
}

async function getBestMatchingSpotifyArtist(
  name: string,
): Promise<SpotifyArtist | null> {
  const query = name.trim();

  if (!query) {
    return null;
  }

  const json =
    await spotifyGet<SpotifySearchResponse>(
      "/search",
      {
        q: query,
        type: "artist",
        limit: 10,
      },
    );

  const artists =
    json.artists?.items ?? [];

  if (artists.length === 0) {
    return null;
  }

  const ranked = [...artists]
    .map((artist) => ({
      artist,
      score: scoreArtistMatch(
        query,
        artist,
      ),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return (
        (b.artist.popularity ?? 0) -
        (a.artist.popularity ?? 0)
      );
    });

  const best = ranked[0];

  if (!best) {
    return null;
  }

  if (
    !isStrongArtistMatch(
      query,
      best.artist,
    )
  ) {
    console.warn(
      "[spotify] rejected weak artist match",
      {
        query,
        chosenName: best.artist.name,
        chosenId: best.artist.id,
        score: best.score,
      },
    );

    return null;
  }

  return best.artist;
}

export async function searchSpotifyArtist(
  name: string,
): Promise<SpotifyArtistResult> {
  const query = name.trim();

  if (!query) {
    return null;
  }

  const cached = getCachedArtist(query);

  if (cached !== undefined) {
    return cached;
  }

  const best =
    await getBestMatchingSpotifyArtist(
      query,
    );

  if (!best) {
    setCachedArtist(query, null);

    return null;
  }

  const result =
    mapSpotifyArtistResult(best);

  if (!result.imageUrl) {
    const appleArtist =
      await searchAppleMusicArtistImage(
        best.name,
      );

    if (appleArtist?.imageUrl) {
      result.imageUrl =
        appleArtist.imageUrl;

      console.log(
        "[spotify] using Apple Music artwork fallback",
        {
          query,
          spotifyArtist: best.name,
          appleMusicArtist:
            appleArtist.name,
        },
      );
    }
  }

  setCachedArtist(query, result);

  return result;
}

async function getDerivedTopTracksFromAlbums(
  albums: SpotifyAlbum[],
): Promise<SpotifyArtistPageTrack[]> {
  const candidateAlbums =
    albums.slice(0, 6);

  const albumTrackGroups =
    await Promise.all(
      candidateAlbums.map(
        async (album) => {
          const tracks =
            await getSpotifyAlbumTracks(
              album.id,
            );

          return tracks.map(
            (track, index) => ({
              ...track,
              album,
              albumTrackNumber:
                index + 1,
            }),
          );
        },
      ),
    );

  const dedupedCandidates =
    dedupeTrackCandidates(
      albumTrackGroups.flat(),
    );

  return dedupedCandidates
    .sort((a, b) => {
      const aIsAlbum =
        a.album.album_type === "album"
          ? 1
          : 0;

      const bIsAlbum =
        b.album.album_type === "album"
          ? 1
          : 0;

      if (bIsAlbum !== aIsAlbum) {
        return bIsAlbum - aIsAlbum;
      }

      const aDate =
        a.album.release_date ?? "";

      const bDate =
        b.album.release_date ?? "";

      if (bDate !== aDate) {
        return bDate.localeCompare(aDate);
      }

      return (
        (a.albumTrackNumber ?? 999) -
        (b.albumTrackNumber ?? 999)
      );
    })
    .slice(0, 5)
    .map((track) => ({
      id: track.id,
      name: track.name,
      albumName: track.album.name,
      imageUrl: getBestSpotifyImage(
        track.album.images,
      ),
      spotifyUrl:
        track.external_urls?.spotify ??
        track.album.external_urls
          ?.spotify ??
        null,
      durationMs:
        typeof track.duration_ms ===
        "number"
          ? track.duration_ms
          : null,
    }));
}

async function getMusicBrainzReleasesForArtist(
  spotifyArtistName: string,
  fallbackName: string,
): Promise<
  SpotifyArtistPageRelease[]
> {
  try {
    const mbResult =
      await searchMbArtists({
        q:
          spotifyArtistName ||
          fallbackName,
        limit: 1,
      });

    const bestMatch =
      mbResult.artists[0];

    if (!bestMatch?.id) {
      return [];
    }

    return await getArtistReleases(
      bestMatch.id,
    );
  } catch (error) {
    console.error(
      "[spotify] failed to fetch MusicBrainz releases",
      {
        artist:
          spotifyArtistName ||
          fallbackName,
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
    );

    return [];
  }
}

async function enrichReleaseArtwork(
  releases: SpotifyArtistPageRelease[],
  albums: SpotifyAlbum[],
  artistName: string,
): Promise<SpotifyArtistPageRelease[]> {
  return Promise.all(
    releases.map(async (release) => {
      const releaseName =
        normaliseArtistName(
          release.title,
        );

      const spotifyAlbum =
        albums.find(
          (album) =>
            normaliseArtistName(
              album.name,
            ) === releaseName,
        );

      const spotifyImage =
        getBestSpotifyImage(
          spotifyAlbum?.images,
        );

      if (spotifyImage) {
        return {
          ...release,
          coverImageUrl: spotifyImage,
        };
      }

      const appleImage =
        await searchAppleMusicReleaseImage(
          artistName,
          release.title,
        );

      return {
        ...release,
        coverImageUrl:
          appleImage ??
          release.coverImageUrl ??
          null,
      };
    }),
  );
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

  const cached =
    getCachedArtistPage(query);

  if (cached !== undefined) {
    return cached;
  }

  const best =
    await getBestMatchingSpotifyArtist(
      query,
    );

  if (!best) {
    const emptyResult: SpotifyArtistPageResult =
      {
        artist: null,
        topTracks: [],
        releases: [],
      };

    setCachedArtist(query, null);

    return emptyResult;
  }

  const artist =
    mapSpotifyArtistResult(best);

  if (!artist.imageUrl) {
    const appleArtist =
      await searchAppleMusicArtistImage(
        best.name,
      );

    if (appleArtist?.imageUrl) {
      artist.imageUrl =
        appleArtist.imageUrl;

      console.log(
        "[spotify] using Apple Music artwork fallback",
        {
          query,
          spotifyArtist: best.name,
          appleMusicArtist:
            appleArtist.name,
        },
      );
    }
  }

  let albums: SpotifyAlbum[] = [];
  let topTracks: SpotifyArtistPageTrack[] =
    [];
  let releases: SpotifyArtistPageRelease[] =
    [];

  try {
    albums =
      await getSpotifyArtistAlbums(
        best.id,
      );
  } catch (error) {
    console.error(
      "[spotify] failed to fetch albums",
      {
        query,
        artistId: best.id,
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
    );
  }

  try {
    if (albums.length > 0) {
      topTracks =
        await getDerivedTopTracksFromAlbums(
          albums,
        );
    }
  } catch (error) {
    console.error(
      "[spotify] failed to derive top tracks from albums",
      {
        query,
        artistId: best.id,
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
    );
  }

  releases =
    await getMusicBrainzReleasesForArtist(
      best.name,
      query,
    );

  releases =
    await enrichReleaseArtwork(
      releases,
      albums,
      best.name,
    );

  const result: SpotifyArtistPageResult =
    {
      artist,
      topTracks,
      releases,
    };

  setCachedArtist(query, artist);
  setCachedArtistPage(query, result);

  return result;
}