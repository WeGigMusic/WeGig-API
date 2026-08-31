import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { env } from "./env";
import { normaliseArtistName } from "./utils/normaliseArtistName";

type AppleMusicArtwork = {
  url?: string;
  width?: number;
  height?: number;
};

type AppleMusicArtist = {
  id: string;
  attributes?: {
    name?: string;
    genreNames?: string[];
    artwork?: AppleMusicArtwork;
  };
};

type AppleMusicSearchResponse = {
  results?: {
    artists?: {
      data?: AppleMusicArtist[];
    };
  };
};

export type AppleMusicArtistImageResult = {
  id: string;
  name: string;
  imageUrl: string | null;
  genres: string[];
};

let cachedDeveloperToken: string | null = null;
let cachedDeveloperTokenExpiryMs = 0;
let cachedPrivateKey: string | null = null;

const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 8_000;

function isConfigured(): boolean {
  return Boolean(env.appleMusicTeamId && env.appleMusicKeyId);
}

function getPrivateKeyPath(): string {
  if (env.appleMusicPrivateKeyPath) {
    return env.appleMusicPrivateKeyPath;
  }

  return `/etc/secrets/AuthKey_${env.appleMusicKeyId}.p8`;
}

async function getPrivateKey(): Promise<string> {
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }

  cachedPrivateKey = await readFile(getPrivateKeyPath(), "utf8");

  return cachedPrivateKey;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

async function getDeveloperToken(): Promise<string> {
  const now = Date.now();

  if (
    cachedDeveloperToken &&
    now < cachedDeveloperTokenExpiryMs
  ) {
    return cachedDeveloperToken;
  }

  if (!isConfigured()) {
    throw new Error("Apple Music is not configured");
  }

  const privateKey = await getPrivateKey();

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_LIFETIME_SECONDS;

  const header = {
    alg: "ES256",
    kid: env.appleMusicKeyId,
    typ: "JWT",
  };

  const payload = {
    iss: env.appleMusicTeamId,
    iat: issuedAt,
    exp: expiresAt,
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));

  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const privateKeyObject = createPrivateKey(privateKey);

  const signature = sign(
    "sha256",
    Buffer.from(unsignedToken),
    {
      key: privateKeyObject,
      dsaEncoding: "ieee-p1363",
    },
  );

  const token = `${unsignedToken}.${base64Url(signature)}`;

  cachedDeveloperToken = token;
  cachedDeveloperTokenExpiryMs =
    expiresAt * 1000 - 60_000;

  return token;
}

async function appleMusicGet<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const token = await getDeveloperToken();

  const url = new URL(
    `https://api.music.apple.com/v1${path}`,
  );

  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, String(value));
    }
  });

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");

      throw new Error(
        `Apple Music GET failed: ${response.status} ${path} ${text}`,
      );
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function artworkUrl(
  artwork: AppleMusicArtwork | undefined,
): string | null {
  const url = artwork?.url?.trim();

  if (!url) {
    return null;
  }

  return url
    .replace("{w}", "1200")
    .replace("{h}", "1200");
}

function tokenize(value: string): string[] {
  return normaliseArtistName(value)
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreArtist(
  query: string,
  artist: AppleMusicArtist,
): number {
  const artistName = artist.attributes?.name ?? "";

  const queryNormalized = normaliseArtistName(query);
  const artistNormalized =
    normaliseArtistName(artistName);

  if (!queryNormalized || !artistNormalized) {
    return 0;
  }

  if (queryNormalized === artistNormalized) {
    return 1000;
  }

  const queryTokens = tokenize(query);
  const artistTokens = tokenize(artistName);

  const sharedTokens = queryTokens.filter((token) =>
    artistTokens.includes(token),
  );

  let score = sharedTokens.length * 100;

  if (artistNormalized.startsWith(queryNormalized)) {
    score += 100;
  }

  if (
    queryTokens.length > 1 &&
    queryTokens.every((token) =>
      artistTokens.includes(token),
    )
  ) {
    score += 250;
  }

  return score;
}

export async function searchAppleMusicArtistImage(
  name: string,
): Promise<AppleMusicArtistImageResult | null> {
  const query = name.trim();

  if (!query || !isConfigured()) {
    return null;
  }

  try {
    const response =
      await appleMusicGet<AppleMusicSearchResponse>(
        `/catalog/${env.appleMusicStorefront}/search`,
        {
          term: query,
          types: "artists",
          limit: 10,
        },
      );

    const artists =
      response.results?.artists?.data ?? [];

    if (artists.length === 0) {
      return null;
    }

    const ranked = artists
      .map((artist) => ({
        artist,
        score: scoreArtist(query, artist),
      }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];

    if (!best || best.score < 200) {
      console.warn(
        "[apple-music] rejected weak artist match",
        {
          query,
          candidate:
            best?.artist.attributes?.name ?? null,
          score: best?.score ?? null,
        },
      );

      return null;
    }

    const attributes = best.artist.attributes;

    if (!attributes?.name) {
      return null;
    }

    return {
      id: best.artist.id,
      name: attributes.name,
      imageUrl: artworkUrl(attributes.artwork),
      genres: attributes.genreNames ?? [],
    };
  } catch (error) {
    console.error(
      "[apple-music] artist lookup failed",
      {
        query,
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
    );

    return null;
  }
}