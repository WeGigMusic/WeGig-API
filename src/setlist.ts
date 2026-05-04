import { env } from "./env";
import { normaliseArtistName } from "./utils/normaliseArtistName";

type SetlistFmArtist = {
  name?: string;
};

type SetlistFmVenueCity = {
  name?: string;
  state?: string;
  stateCode?: string;
  coords?: {
    lat?: number;
    long?: number;
  };
  country?: {
    code?: string;
    name?: string;
  };
};

type SetlistFmVenue = {
  name?: string;
  city?: SetlistFmVenueCity;
};

type SetlistFmSong = {
  name?: string;
};

type SetlistFmSet = {
  name?: string;
  encore?: number;
  song?: SetlistFmSong[] | SetlistFmSong;
};

type SetlistFmSets = {
  set?: SetlistFmSet[] | SetlistFmSet;
};

type SetlistFmSetlist = {
  id?: string;
  versionId?: string;
  eventDate?: string;
  url?: string;
  artist?: SetlistFmArtist;
  venue?: SetlistFmVenue;
  sets?: SetlistFmSets;
};

type SetlistFmSearchResponse = {
  setlist?: SetlistFmSetlist[] | SetlistFmSetlist;
};

export type SetlistItem = {
  id: string;
  eventDate: string;
  venueName: string;
  cityName: string;
  countryCode: string | null;
  url: string | null;
  songCount: number;
  sets: Array<{
    name: string;
    encore: number;
    songs: string[];
  }>;
};

export type GigSetlistMatchResult = {
  matched: boolean;
  confidence: number;
  setlist: SetlistItem | null;
};

export type SetlistServiceErrorCode =
  | "SETLIST_NOT_FOUND"
  | "SETLIST_UNAVAILABLE"
  | "SETLIST_UNAUTHORIZED"
  | "SETLIST_MISCONFIGURED";

export class SetlistServiceError extends Error {
  readonly code: SetlistServiceErrorCode;
  readonly status: number;
  readonly causeText?: string;

  constructor(
    code: SetlistServiceErrorCode,
    status: number,
    message: string,
    causeText?: string,
  ) {
    super(message);
    this.name = "SetlistServiceError";
    this.code = code;
    this.status = status;
    this.causeText = causeText;
  }
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type CachedSetlistEntry = {
  value: SetlistItem[];
  expiresAt: number;
};

const cache = new Map<string, CachedSetlistEntry>();

function getCacheKey(artistName: string, artistMbid?: string): string {
  return artistMbid?.trim()
    ? `mbid:${artistMbid.trim()}`
    : `name:${normaliseArtistName(artistName)}`;
}

function getCached(
  artistName: string,
  artistMbid?: string,
): SetlistItem[] | undefined {
  const key = getCacheKey(artistName, artistMbid);
  const cached = cache.get(key);

  if (!cached) return undefined;

  if (Date.now() >= cached.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  return cached.value;
}

function setCached(
  artistName: string,
  value: SetlistItem[],
  artistMbid?: string,
) {
  const key = getCacheKey(artistName, artistMbid);

  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

async function setlistGet<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  if (!env.setlistFmApiKey) {
    throw new SetlistServiceError(
      "SETLIST_MISCONFIGURED",
      500,
      "Setlist service is not configured.",
    );
  }

  const url = new URL(`https://api.setlist.fm/rest/1.0${path}`);

  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "x-api-key": env.setlistFmApiKey,
    },
  });

  if (res.ok) {
    return (await res.json()) as T;
  }

  const text = await res.text().catch(() => "");

  if (res.status === 404) {
    throw new SetlistServiceError(
      "SETLIST_NOT_FOUND",
      404,
      "No matching setlist found.",
      text,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new SetlistServiceError(
      "SETLIST_UNAUTHORIZED",
      502,
      "Setlist provider authorization failed.",
      text,
    );
  }

  if (res.status === 429 || res.status >= 500) {
    throw new SetlistServiceError(
      "SETLIST_UNAVAILABLE",
      503,
      "Setlist provider is unavailable.",
      text,
    );
  }

  throw new SetlistServiceError(
    "SETLIST_UNAVAILABLE",
    502,
    "Setlist request failed.",
    text,
  );
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function mapSetlistItem(item: SetlistFmSetlist): SetlistItem | null {
  const sets = toArray(item.sets?.set).map((set) => ({
    name: String(set.name ?? "").trim(),
    encore: typeof set.encore === "number" ? set.encore : 0,
    songs: toArray(set.song)
      .map((song) => String(song.name ?? "").trim())
      .filter(Boolean),
  }));

  const songCount = sets.reduce((sum, set) => sum + set.songs.length, 0);

  const id = String(item.id ?? item.versionId ?? "").trim();
  if (!id) return null;

  return {
    id,
    eventDate: String(item.eventDate ?? "").trim() || "Unknown date",
    venueName: String(item.venue?.name ?? "").trim() || "Unknown venue",
    cityName: String(item.venue?.city?.name ?? "").trim() || "Unknown city",
    countryCode: item.venue?.city?.country?.code?.trim() ?? null,
    url: item.url?.trim() ?? null,
    songCount,
    sets,
  };
}

function sortSetlists(items: SetlistItem[]): SetlistItem[] {
  return [...items].sort((a, b) => {
    const aDate = parseSetlistDate(a.eventDate);
    const bDate = parseSetlistDate(b.eventDate);

    if (!aDate && !bDate) return 0;
    if (!aDate) return 1;
    if (!bDate) return -1;

    return bDate.getTime() - aDate.getTime();
  });
}

function norm(value?: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseSetlistDate(value: string): Date | null {
  const match = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;

  const dd = Number(match[1]);
  const mm = Number(match[2]);
  const yyyy = Number(match[3]);

  const date = new Date(Date.UTC(yyyy, mm - 1, dd));

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== yyyy ||
    date.getUTCMonth() + 1 !== mm ||
    date.getUTCDate() !== dd
  ) {
    return null;
  }

  return date;
}

function parseGigDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const yyyy = Number(match[1]);
  const mm = Number(match[2]);
  const dd = Number(match[3]);

  const date = new Date(Date.UTC(yyyy, mm - 1, dd));

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== yyyy ||
    date.getUTCMonth() + 1 !== mm ||
    date.getUTCDate() !== dd
  ) {
    return null;
  }

  return date;
}

function diffDays(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function scoreCandidate(input: {
  gigDate: Date | null;
  gigCity?: string;
  gigVenue?: string;
  setlist: SetlistItem;
}): number {
  let score = 0;

  const setlistDate = parseSetlistDate(input.setlist.eventDate);

  if (input.gigDate && setlistDate) {
    const days = diffDays(input.gigDate, setlistDate);

    if (days === 0) score += 70;
    else if (days === 1) score += 35;
    else if (days <= 3) score += 12;
  }

  const gigCity = norm(input.gigCity);
  const setlistCity = norm(input.setlist.cityName);

  if (gigCity && setlistCity && gigCity === setlistCity) {
    score += 18;
  }

  const venueA = norm(input.gigVenue);
  const venueB = norm(input.setlist.venueName);

  if (venueA && venueB) {
    if (venueA === venueB) score += 22;
    else if (venueA.includes(venueB) || venueB.includes(venueA)) score += 10;
  }

  if (input.setlist.songCount > 0) {
    score += 5;
  }

  return score;
}

export async function searchSetlistsByArtist(
  artistName: string,
  artistMbid?: string,
): Promise<SetlistItem[]> {
  const query = artistName.trim();
  if (!query) return [];

  if (!env.setlistFmApiKey) {
    return [];
  }

  const cached = getCached(query, artistMbid);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const json = await setlistGet<SetlistFmSearchResponse>("/search/setlists", {
  artistMbid: artistMbid?.trim() || undefined,
  artistName: artistMbid?.trim() ? undefined : query,
  p: 1,
});

    const rawItems = toArray(json.setlist);
    const mapped = rawItems
      .map(mapSetlistItem)
      .filter((item): item is SetlistItem => Boolean(item));

    const sorted = sortSetlists(mapped).slice(0, 8);

    setCached(query, sorted, artistMbid);
    return sorted;
  } catch (error: unknown) {
    if (
      error instanceof SetlistServiceError &&
      error.code === "SETLIST_NOT_FOUND"
    ) {
     setCached(query, [], artistMbid);
      return [];
    }

    throw error;
  }
}

export async function matchSetlistToGig(input: {
  artist: string;
  date: string;
  city?: string;
  venue?: string;
}): Promise<GigSetlistMatchResult> {
  const artist = input.artist.trim();
  const date = input.date.trim();

  if (!artist || !date) {
    return {
      matched: false,
      confidence: 0,
      setlist: null,
    };
  }

  const setlists = await searchSetlistsByArtist(artist);

  if (setlists.length === 0) {
    return {
      matched: false,
      confidence: 0,
      setlist: null,
    };
  }

  const gigDate = parseGigDate(date);

  const ranked = setlists
    .map((setlist) => ({
      setlist,
      score: scoreCandidate({
        gigDate,
        gigCity: input.city,
        gigVenue: input.venue,
        setlist,
      }),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  if (!best || best.score < 60) {
    return {
      matched: false,
      confidence: 0,
      setlist: null,
    };
  }

  return {
    matched: true,
    confidence: Math.min(best.score / 100, 0.98),
    setlist: best.setlist,
  };
}