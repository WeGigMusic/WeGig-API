import { normaliseArtistName } from "./utils/normaliseArtistName";

type MbArtistAlias = {
  name?: string;
  "sort-name"?: string;
};

type MbArtist = {
  id: string;
  name: string;
  country?: string;
  disambiguation?: string;
  score?: number;
  aliases?: MbArtistAlias[];
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

const MB_BASE =
  "https://musicbrainz.org/ws/2";

const COVER_ART_BASE =
  "https://coverartarchive.org";

const ONE_DAY_MS =
  24 * 60 * 60 * 1000;

const RAG_N_BONE_MAN_MBID =
  "37993cdf-f61a-488f-8cca-07e03b8aaa02";

type CacheEntry<T> = {
  expiresAt: number;
  data: T;
};

const cache =
  new Map<string, CacheEntry<unknown>>();

let lastRequestAt = 0;

function sleep(ms: number) {
  return new Promise<void>((resolve) =>
    setTimeout(resolve, ms),
  );
}

async function throttleOneReqPerSec() {
  const now = Date.now();
  const delta =
    now - lastRequestAt;

  if (delta < 1000) {
    await sleep(1000 - delta);
  }

  lastRequestAt = Date.now();
}

function getUserAgent() {
  return (
    process.env.MB_USER_AGENT ||
    "WeGig/1.0 (contact unknown)"
  );
}

function getCached<T>(
  key: string,
): T | null {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (
    Date.now() >
    entry.expiresAt
  ) {
    cache.delete(key);
    return null;
  }

  return entry.data as T;
}

function setCached<T>(
  key: string,
  data: T,
) {
  cache.set(key, {
    expiresAt:
      Date.now() + ONE_DAY_MS,
    data,
  });
}

function normaliseForMatch(
  value: string,
) {
  return normaliseArtistName(
    value
      .replace(/[’']/g, " ")
      .replace(/&/g, " and ")
      .replace(
        /[^a-zA-Z0-9]+/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function normaliseExactArtistQuery(
  value: string,
) {
  return value
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/&/g, " and ")
    .replace(
      /[^a-z0-9]+/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingThe(
  value: string,
) {
  return value.replace(
    /^the\s+/i,
    "",
  );
}

function namesMatch(
  a: string,
  b: string,
) {
  const left =
    normaliseForMatch(a);

  const right =
    normaliseForMatch(b);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  return (
    stripLeadingThe(left) ===
    stripLeadingThe(right)
  );
}

function scoreArtistMatch(
  query: string,
  artist: MbArtist,
): number {
  const q =
    normaliseForMatch(query);

  const name =
    normaliseForMatch(
      artist.name,
    );

  let score = 0;

  if (
    namesMatch(
      query,
      artist.name,
    )
  ) {
    score += 300;
  } else if (
    name.startsWith(q)
  ) {
    score += 100;
  } else if (
    name.includes(q)
  ) {
    score += 25;
  }

  const aliasMatch =
    (artist.aliases ?? []).some(
      (alias) => {
        const aliasName =
          alias.name ??
          alias["sort-name"] ??
          "";

        return namesMatch(
          query,
          aliasName,
        );
      },
    );

  if (aliasMatch) {
    score += 200;
  }

  if (
    typeof artist.score ===
    "number"
  ) {
    score +=
      artist.score * 5;
  }

  return score;
}

async function fetchMbJson<T>(
  url: string,
): Promise<T> {
  const maxAttempts = 2;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt += 1
  ) {
    await throttleOneReqPerSec();

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        8000,
      );

    try {
      const res =
        await fetch(url, {
          headers: {
            "User-Agent":
              getUserAgent(),
            Accept:
              "application/json",
          },
          signal:
            controller.signal,
        });

      if (res.ok) {
        return (
          await res.json()
        ) as T;
      }

      const text =
        await res
          .text()
          .catch(() => "");

      if (
        (res.status === 503 ||
          res.status === 429) &&
        attempt < maxAttempts
      ) {
        await sleep(1200);
        continue;
      }

      throw new Error(
        `MusicBrainz ${res.status}: ${text}`,
      );
    } catch (error) {
      if (
        attempt >= maxAttempts
      ) {
        throw error;
      }

      await sleep(1200);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    "MusicBrainz request failed",
  );
}

export async function searchMbArtists(
  params: {
    q: string;
    limit?: number;
  },
) {
  const q =
    params.q.trim();

  if (!q) {
    return {
      count: 0,
      artists: [],
    };
  }

  /*
   * Important:
   * MusicBrainz incorrectly ranks the unrelated
   * Scottish artist "The Rag n Bone Man" above
   * Rory Graham when punctuation is omitted.
   *
   * Resolve this known collision before cache
   * lookup or any MusicBrainz network request.
   */
  const exactQuery =
    normaliseExactArtistQuery(
      q,
    );

  if (
    exactQuery ===
    "rag n bone man"
  ) {
    console.log(
      "[musicbrainz] Rag'n'Bone Man override",
      {
        query: q,
        mbid:
          RAG_N_BONE_MAN_MBID,
      },
    );

    return {
      count: 1,
      artists: [
        {
          id:
            RAG_N_BONE_MAN_MBID,
          name:
            "Rag'n'Bone Man",
          country: "GB",
          score: 100,
        },
      ],
    };
  }

  const limit =
    Math.min(
      Math.max(
        params.limit ?? 8,
        1,
      ),
      25,
    );

  const cacheKey =
    `mb:artist:v6:${normaliseForMatch(
      q,
    )}:${limit}`;

  const cached =
    getCached<{
      count: number;
      artists: MbArtist[];
    }>(cacheKey);

  if (cached) {
    return cached;
  }

  const url =
    `${MB_BASE}/artist?query=${encodeURIComponent(
      q,
    )}` +
    `&limit=25&fmt=json`;

  const json =
    await fetchMbJson<MbSearchResponse>(
      url,
    );

  const artists =
    (json.artists ?? [])
      .sort(
        (a, b) =>
          scoreArtistMatch(
            q,
            b,
          ) -
          scoreArtistMatch(
            q,
            a,
          ),
      )
      .slice(0, limit);

  const payload = {
    count:
      artists.length,
    artists,
  };

  if (
    artists.length > 0
  ) {
    setCached(
      cacheKey,
      payload,
    );
  }

  return payload;
}

function parseMbDate(
  date?: string,
): number {
  if (!date) {
    return 0;
  }

  if (
    /^\d{4}$/.test(date)
  ) {
    return Date.parse(
      `${date}-01-01`,
    );
  }

  if (
    /^\d{4}-\d{2}$/.test(
      date,
    )
  ) {
    return Date.parse(
      `${date}-01`,
    );
  }

  if (
    /^\d{4}-\d{2}-\d{2}$/.test(
      date,
    )
  ) {
    return Date.parse(
      date,
    );
  }

  return 0;
}

async function coverArtExists(
  releaseGroupId: string,
): Promise<boolean> {
  try {
    const res =
      await fetch(
        `${COVER_ART_BASE}/release-group/${releaseGroupId}/front-250`,
        {
          method: "HEAD",
          headers: {
            "User-Agent":
              getUserAgent(),
          },
        },
      );

    return res.ok;
  } catch {
    return false;
  }
}

export async function getArtistReleases(
  mbid: string,
): Promise<
  ArtistRelease[]
> {
  const artistMbid =
    mbid.trim();

  const cacheKey =
    `mb:artist-releases:${artistMbid}`;

  const cached =
    getCached<
      ArtistRelease[]
    >(cacheKey);

  if (cached) {
    return cached;
  }

  const url =
    `${MB_BASE}/release-group?artist=${encodeURIComponent(
      artistMbid,
    )}` +
    `&type=album|ep|single&limit=100&fmt=json`;

  const json =
    await fetchMbJson<MbReleaseGroupsResponse>(
      url,
    );

  const sortedItems =
    (
      json[
        "release-groups"
      ] ?? []
    )
      .filter(
        (item) =>
          item[
            "first-release-date"
          ],
      )
      .sort(
        (a, b) =>
          parseMbDate(
            b[
              "first-release-date"
            ],
          ) -
          parseMbDate(
            a[
              "first-release-date"
            ],
          ),
      )
      .slice(0, 25);

  const releases =
    await Promise.all(
      sortedItems.map(
        async (item) => {
          const hasCover =
            await coverArtExists(
              item.id,
            );

          return {
            id: item.id,
            title:
              item.title,
            type:
              item[
                "primary-type"
              ],
            firstReleaseDate:
              item[
                "first-release-date"
              ],
            coverImageUrl:
              hasCover
                ? `${COVER_ART_BASE}/release-group/${item.id}/front-250`
                : null,
            musicBrainzUrl:
              `https://musicbrainz.org/release-group/${item.id}`,
          };
        },
      ),
    );

  setCached(
    cacheKey,
    releases,
  );

  return releases;
}