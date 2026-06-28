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

type MbReleaseGroup = {
  id: string;
  title: string;
  "first-release-date"?: string;
  "primary-type"?: string;
};

type MbReleaseGroupsResponse = {
  "release-groups"?: MbReleaseGroup[];
};

export type ArtistRelease = {
  id: string;
  title: string;
  type?: string;
  firstReleaseDate?: string;
  coverImageUrl?: string | null;
  musicBrainzUrl: string;
};

const MB_BASE = "https://musicbrainz.org/ws/2";
const COVER_ART_BASE = "https://coverartarchive.org";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type CacheEntry<T> = { expiresAt: number; data: T };
const cache = new Map<string, CacheEntry<unknown>>();

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

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.data as T;
}

function setCached<T>(key: string, data: T) {
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

async function coverArtExists(releaseGroupId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${COVER_ART_BASE}/release-group/${releaseGroupId}/front-250`,
      {
        method: "HEAD",
        headers: {
          "User-Agent": getUserAgent(),
        },
      },
    );

    return res.ok;
  } catch {
    return false;
  }
}

export async function searchMbArtists(params: { q: string; limit?: number }) {
  const q = params.q.trim();
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 25);

  const cacheKey = `mb:artist:${normaliseArtistName(q)}:${limit}`;
  const cached = getCached<{ count: number; artists: MbArtist[] }>(cacheKey);
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

export async function getArtistReleases(mbid: string): Promise<ArtistRelease[]> {
  const artistMbid = mbid.trim();

  const cacheKey = `mb:artist-releases:${artistMbid}`;
  const cached = getCached<ArtistRelease[]>(cacheKey);
  if (cached) return cached;

  await throttleOneReqPerSec();

  const url =
    `${MB_BASE}/release-group?artist=${encodeURIComponent(artistMbid)}` +
    `&type=album|ep|single&limit=25&fmt=json`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": getUserAgent(),
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MusicBrainz releases ${res.status}: ${text}`);
  }

  const json = (await res.json()) as MbReleaseGroupsResponse;

  const releases = await Promise.all(
    (json["release-groups"] ?? []).map(async (item) => {
      const hasCover = await coverArtExists(item.id);

      return {
        id: item.id,
        title: item.title,
        type: item["primary-type"],
        firstReleaseDate: item["first-release-date"],
        coverImageUrl: hasCover
          ? `${COVER_ART_BASE}/release-group/${item.id}/front-250`
          : null,
        musicBrainzUrl: `https://musicbrainz.org/release-group/${item.id}`,
      };
    }),
  );

  setCached(cacheKey, releases);
  return releases;
}