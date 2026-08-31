import prisma from "./prisma";
import { searchAppleMusicArtistImage } from "./appleMusic";
import { searchSpotifyArtist } from "./spotify";

function normalizeArtistName(value: string) {
  return value
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getArtistImage(
  artistName: string,
) {
  const name = artistName.trim();
  const normalizedName = normalizeArtistName(name);

  if (!normalizedName) {
    return {
      artistName: name,
      imageUrl: null,
      source: null,
    };
  }

  const cached = await prisma.artist.findUnique({
    where: {
      normalizedName,
    },
  });

  if (cached?.imageUrl) {
    return {
      artistName: cached.name,
      imageUrl: cached.imageUrl,
      source: cached.imageSource,
    };
  }

  let imageUrl: string | null = null;
  let imageSource: string | null = null;
  let spotifyId: string | null = null;

  try {
    imageUrl =
      await searchAppleMusicArtistImage(name);

    if (imageUrl) {
      imageSource = "apple";
    }
  } catch (error) {
    console.warn("[artist-image] Apple lookup failed", {
      artistName: name,
      message:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }

  if (!imageUrl) {
    try {
      const spotifyArtist =
        await searchSpotifyArtist(name);

      if (spotifyArtist?.imageUrl) {
        imageUrl = spotifyArtist.imageUrl;
        imageSource = "spotify";
        spotifyId = spotifyArtist.id;
      }
    } catch (error) {
      console.warn("[artist-image] Spotify lookup failed", {
        artistName: name,
        message:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  if (imageUrl) {
    await prisma.artist.upsert({
      where: {
        normalizedName,
      },
      create: {
        name,
        normalizedName,
        imageUrl,
        imageSource,
        spotifyId,
        imageUpdatedAt: new Date(),
      },
      update: {
        name,
        imageUrl,
        imageSource,
        spotifyId:
          spotifyId ?? undefined,
        imageUpdatedAt: new Date(),
      },
    });
  }

  return {
    artistName: name,
    imageUrl,
    source: imageSource,
  };
}