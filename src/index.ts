import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import "dotenv/config";

import prisma from "./prisma";
import { requireAuth, type AuthedRequest } from "./auth";
import { searchMbArtists } from "./musicbrainz";
import { searchSpotifyArtist, getSpotifyArtistPage } from "./spotify";
import {
  searchSetlistsByArtist,
  matchSetlistToGig,
  SetlistServiceError,
} from "./setlist";
import { getLastFmSimilarArtists } from "./lastfm";
import { Gig, CreateGigInput } from "./types/Gig";
import { dedupeEvents } from "./utils/dedupeEvents";
import { searchSkiddleEventsNormalized } from "./skiddle";
import {
  searchTmEventsUk,
  searchTmEventsNormalized,
  getTmEventByIdUk,
  searchTmVenuesUk,
} from "./ticketmaster";
import { extractRawTextFromImage } from "./ocr";
import { parseTicketText } from "./parseTicketText";

const app = express();
const PORT = Number(process.env.PORT ?? 5050);

const upload = multer({ dest: "tmp/" });

function norm(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

app.use(cors());
app.use(express.json());

app.set("etag", false);
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
});

app.get("/", (_req: Request, res: Response) => {
  res
    .status(200)
    .type("text")
    .send("WeGig API is running. Try /health or /gigs");
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    message: "WeGig API is running",
    timestamp: new Date().toISOString(),
  });
});

app.get("/version", (_req, res) => {
  res.json({ version: "wegig-api-2026-04-22-auth-gigs" });
});

app.get("/gigs", requireAuth, async (req: AuthedRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    console.log("[gigs] fetching gigs", { userId });

    const dbGigs = await prisma.gig.findMany({
      where: { userId },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    });

    const gigs: Gig[] = dbGigs.map((g) => ({
      id: g.id,
      artist: g.artist,
      artistMbid: g.artistMbid ?? undefined,
      venue: g.venue,
      city: g.city,
      date: g.date,
      rating: g.rating ?? undefined,
      notes: g.notes ?? undefined,
      externalSource: g.externalSource ?? undefined,
      externalId: g.externalId ?? undefined,
      ticketUrl: g.ticketUrl ?? undefined,
      venueLatitude: g.venueLatitude ?? undefined,
      venueLongitude: g.venueLongitude ?? undefined,
      venuePlaceName: g.venuePlaceName ?? undefined,
      venuePlaceId: g.venuePlaceId ?? undefined,
    }));

    res.json({ count: gigs.length, gigs });
  } catch (error) {
    console.error("Error fetching gigs from Prisma:", error);
    res.status(500).json({ error: "Failed to fetch gigs" });
  }
});

app.post("/gigs", requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.user!.id;

  console.log("[gigs] creating gig", {
    userId,
    artist: req.body?.artist,
    venue: req.body?.venue,
    city: req.body?.city,
    date: req.body?.date,
  });

  const gigInput = req.body as CreateGigInput & {
    externalSource?: unknown;
    externalId?: unknown;
    artistMbid?: unknown;
    ticketUrl?: unknown;
    venueLatitude?: unknown;
    venueLongitude?: unknown;
    venuePlaceName?: unknown;
    venuePlaceId?: unknown;
  };

  const errors: string[] = [];

  if (typeof gigInput.artist !== "string" || gigInput.artist.trim() === "") {
    errors.push("artist must be a non-empty string");
  }

  if (typeof gigInput.venue !== "string" || gigInput.venue.trim() === "") {
    errors.push("venue must be a non-empty string");
  }

  if (typeof gigInput.city !== "string" || gigInput.city.trim() === "") {
    errors.push("city must be a non-empty string");
  }

  if (typeof gigInput.date !== "string" || gigInput.date.trim() === "") {
    errors.push("date must be a non-empty string");
  } else {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(gigInput.date.trim())) {
      errors.push("date must be in YYYY-MM-DD format");
    } else {
      const dateStr = gigInput.date.trim();
      const parsedDate = new Date(dateStr + "T00:00:00Z");
      if (Number.isNaN(parsedDate.getTime())) {
        errors.push("date must be a valid date");
      } else {
        const [y, m, d] = dateStr.split("-").map(Number);
        if (
          y !== parsedDate.getUTCFullYear() ||
          m !== parsedDate.getUTCMonth() + 1 ||
          d !== parsedDate.getUTCDate()
        ) {
          errors.push("date must be a valid calendar date");
        }
      }
    }
  }

  if (gigInput.rating !== undefined && gigInput.rating !== null) {
    if (
      typeof gigInput.rating !== "number" ||
      !Number.isFinite(gigInput.rating) ||
      gigInput.rating < 1 ||
      gigInput.rating > 5
    ) {
      errors.push("rating must be a number between 1 and 5");
    }
  }

  if (
    gigInput.notes !== undefined &&
    gigInput.notes !== null &&
    typeof gigInput.notes !== "string"
  ) {
    errors.push("notes must be a string");
  }

  const artistMbid =
    typeof gigInput.artistMbid === "string" && gigInput.artistMbid.trim() !== ""
      ? gigInput.artistMbid.trim()
      : undefined;

  if (artistMbid) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(artistMbid)) {
      errors.push("artistMbid must be a valid UUID");
    }
  }

  const externalSource =
    typeof gigInput.externalSource === "string" &&
    gigInput.externalSource.trim() !== ""
      ? gigInput.externalSource.trim()
      : undefined;

  const externalId =
    typeof gigInput.externalId === "string" && gigInput.externalId.trim() !== ""
      ? gigInput.externalId.trim()
      : undefined;

  if ((externalSource && !externalId) || (!externalSource && externalId)) {
    errors.push("externalSource and externalId must be provided together");
  }

  const ticketUrl =
    typeof gigInput.ticketUrl === "string" && gigInput.ticketUrl.trim() !== ""
      ? gigInput.ticketUrl.trim()
      : undefined;

  const venueLatitude =
    typeof gigInput.venueLatitude === "number" &&
    Number.isFinite(gigInput.venueLatitude)
      ? gigInput.venueLatitude
      : undefined;

  const venueLongitude =
    typeof gigInput.venueLongitude === "number" &&
    Number.isFinite(gigInput.venueLongitude)
      ? gigInput.venueLongitude
      : undefined;

  const venuePlaceName =
    typeof gigInput.venuePlaceName === "string" &&
    gigInput.venuePlaceName.trim() !== ""
      ? gigInput.venuePlaceName.trim()
      : undefined;

  const venuePlaceId =
    typeof gigInput.venuePlaceId === "string" &&
    gigInput.venuePlaceId.trim() !== ""
      ? gigInput.venuePlaceId.trim()
      : undefined;

  if (
    (venueLatitude !== undefined && venueLongitude === undefined) ||
    (venueLatitude === undefined && venueLongitude !== undefined)
  ) {
    errors.push("venueLatitude and venueLongitude must be provided together");
  }

  if (
    venueLatitude !== undefined &&
    (venueLatitude < -90 || venueLatitude > 90)
  ) {
    errors.push("venueLatitude must be between -90 and 90");
  }

  if (
    venueLongitude !== undefined &&
    (venueLongitude < -180 || venueLongitude > 180)
  ) {
    errors.push("venueLongitude must be between -180 and 180");
  }

  if (errors.length > 0) {
    return res
      .status(400)
      .json({ error: "Validation failed", details: errors });
  }

  try {
    if (externalSource && externalId) {
      const already = await prisma.gig.findFirst({
        where: {
          userId,
          externalSource,
          externalId,
        },
      });

      if (already) {
        return res.status(409).json({
          message: "You’ve already logged this gig.",
          existingGigId: already.id,
        });
      }
    }

    const normalizedArtist = norm(gigInput.artist);
    const normalizedDate = norm(gigInput.date);
    const normalizedVenue = norm(gigInput.venue);
    const normalizedCity = norm(gigInput.city);

    if (venuePlaceId) {
      const existingForArtistDate = await prisma.gig.findMany({
        where: {
          userId,
          artist: gigInput.artist.trim(),
          date: gigInput.date.trim(),
        },
      });

      const alreadyByPlaceId = existingForArtistDate.find((g) => {
        return (
          norm(g.artist) === normalizedArtist &&
          norm(g.date) === normalizedDate &&
          norm(g.venuePlaceId) === norm(venuePlaceId)
        );
      });

      if (alreadyByPlaceId) {
        return res.status(409).json({
          message: "You’ve already logged this gig.",
          existingGigId: alreadyByPlaceId.id,
        });
      }
    }

    const existingForTextCheck = await prisma.gig.findMany({
      where: {
        userId,
        artist: gigInput.artist.trim(),
        date: gigInput.date.trim(),
      },
    });

    const alreadyByText = existingForTextCheck.find((g) => {
      return (
        norm(g.artist) === normalizedArtist &&
        norm(g.venue) === normalizedVenue &&
        norm(g.city) === normalizedCity &&
        norm(g.date) === normalizedDate
      );
    });

    if (alreadyByText) {
      return res.status(409).json({
        message: "You’ve already logged this gig.",
        existingGigId: alreadyByText.id,
      });
    }

    const created = await prisma.gig.create({
      data: {
        id: randomUUID(),
        userId,
        artist: gigInput.artist.trim(),
        venue: gigInput.venue.trim(),
        city: gigInput.city.trim(),
        date: gigInput.date.trim(),
        rating: gigInput.rating ?? null,
        notes:
          typeof gigInput.notes === "string"
            ? gigInput.notes.trim() || null
            : null,
        artistMbid: artistMbid ?? null,
        externalSource: externalSource ?? null,
        externalId: externalId ?? null,
        ticketUrl: ticketUrl ?? null,
        venueLatitude: venueLatitude ?? null,
        venueLongitude: venueLongitude ?? null,
        venuePlaceName: venuePlaceName ?? null,
        venuePlaceId: venuePlaceId ?? null,
      },
    });

    console.log("[gigs] created gig", {
      userId,
      gigId: created.id,
      artist: created.artist,
    });

    const newGig: Gig = {
      id: created.id,
      artist: created.artist,
      venue: created.venue,
      city: created.city,
      date: created.date,
      rating: created.rating ?? undefined,
      notes: created.notes ?? undefined,
      artistMbid: created.artistMbid ?? undefined,
      externalSource: created.externalSource ?? undefined,
      externalId: created.externalId ?? undefined,
      ticketUrl: created.ticketUrl ?? undefined,
      venueLatitude: created.venueLatitude ?? undefined,
      venueLongitude: created.venueLongitude ?? undefined,
      venuePlaceName: created.venuePlaceName ?? undefined,
      venuePlaceId: created.venuePlaceId ?? undefined,
    };

    return res.status(201).json(newGig);
  } catch (error) {
    console.error("Error saving gig to Prisma:", error);
    return res.status(500).json({ error: "Failed to add gig" });
  }
});

app.patch(
  "/gigs/:id",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const { id } = req.params;

    try {
      const existing = await prisma.gig.findFirst({
        where: {
          id,
          userId,
        },
      });

      if (!existing) {
        return res.status(404).json({ error: "Gig not found" });
      }

      const next: Gig = {
        id: existing.id,
        artist:
          typeof req.body.artist === "string"
            ? req.body.artist.trim()
            : existing.artist,
        venue:
          typeof req.body.venue === "string"
            ? req.body.venue.trim()
            : existing.venue,
        city:
          typeof req.body.city === "string"
            ? req.body.city.trim()
            : existing.city,
        date:
          typeof req.body.date === "string"
            ? req.body.date.trim()
            : existing.date,
        rating:
          req.body.rating !== undefined
            ? req.body.rating
            : existing.rating ?? undefined,
        notes:
          typeof req.body.notes === "string"
            ? req.body.notes.trim()
            : existing.notes ?? undefined,
        externalSource: existing.externalSource ?? undefined,
        externalId: existing.externalId ?? undefined,
        artistMbid: existing.artistMbid ?? undefined,
        ticketUrl:
          typeof req.body.ticketUrl === "string"
            ? req.body.ticketUrl.trim()
            : existing.ticketUrl ?? undefined,
        venueLatitude:
          typeof req.body.venueLatitude === "number"
            ? req.body.venueLatitude
            : existing.venueLatitude ?? undefined,
        venueLongitude:
          typeof req.body.venueLongitude === "number"
            ? req.body.venueLongitude
            : existing.venueLongitude ?? undefined,
        venuePlaceName:
          typeof req.body.venuePlaceName === "string"
            ? req.body.venuePlaceName.trim()
            : existing.venuePlaceName ?? undefined,
        venuePlaceId:
          typeof req.body.venuePlaceId === "string"
            ? req.body.venuePlaceId.trim()
            : existing.venuePlaceId ?? undefined,
      };

      const errors: string[] = [];
      if (!next.artist?.trim()) errors.push("artist must be a non-empty string");
      if (!next.venue?.trim()) errors.push("venue must be a non-empty string");
      if (!next.city?.trim()) errors.push("city must be a non-empty string");
      if (!next.date?.trim()) errors.push("date must be a non-empty string");
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(next.date)) {
        errors.push("date must be in YYYY-MM-DD format");
      }

      if (next.rating !== undefined && next.rating !== null) {
        if (
          typeof next.rating !== "number" ||
          !Number.isFinite(next.rating) ||
          next.rating < 1 ||
          next.rating > 5
        ) {
          errors.push("rating must be a number between 1 and 5");
        }
      }

      if (
        (next.venueLatitude !== undefined &&
          next.venueLongitude === undefined) ||
        (next.venueLatitude === undefined &&
          next.venueLongitude !== undefined)
      ) {
        errors.push("venueLatitude and venueLongitude must be provided together");
      }

      if (
        next.venueLatitude !== undefined &&
        (next.venueLatitude < -90 || next.venueLatitude > 90)
      ) {
        errors.push("venueLatitude must be between -90 and 90");
      }

      if (
        next.venueLongitude !== undefined &&
        (next.venueLongitude < -180 || next.venueLongitude > 180)
      ) {
        errors.push("venueLongitude must be between -180 and 180");
      }

      if (errors.length > 0) {
        return res
          .status(400)
          .json({ error: "Validation failed", details: errors });
      }

      const candidateDuplicates = await prisma.gig.findMany({
        where: {
          userId,
          NOT: { id },
        },
      });

      const duplicate = candidateDuplicates.find((g) => {
        const sameExternal =
          norm(next.externalSource) &&
          norm(next.externalId) &&
          norm(g.externalSource) === norm(next.externalSource) &&
          norm(g.externalId) === norm(next.externalId);

        if (sameExternal) return true;

        const samePlaceId =
          norm(next.artist) &&
          norm(next.date) &&
          norm(next.venuePlaceId) &&
          norm(g.artist) === norm(next.artist) &&
          norm(g.date) === norm(next.date) &&
          norm(g.venuePlaceId) === norm(next.venuePlaceId);

        if (samePlaceId) return true;

        const sameText =
          norm(g.artist) === norm(next.artist) &&
          norm(g.venue) === norm(next.venue) &&
          norm(g.city) === norm(next.city) &&
          norm(g.date) === norm(next.date);

        return sameText;
      });

      if (duplicate) {
        return res.status(409).json({
          message: "This change would create a duplicate gig.",
          existingGigId: duplicate.id,
        });
      }

      const updated = await prisma.gig.update({
        where: { id: existing.id },
        data: {
          artist: next.artist.trim(),
          venue: next.venue.trim(),
          city: next.city.trim(),
          date: next.date.trim(),
          rating: next.rating ?? null,
          notes: next.notes?.trim() || null,
          ticketUrl: next.ticketUrl?.trim() || null,
          venueLatitude: next.venueLatitude ?? null,
          venueLongitude: next.venueLongitude ?? null,
          venuePlaceName: next.venuePlaceName?.trim() || null,
          venuePlaceId: next.venuePlaceId?.trim() || null,
        },
      });

      const responseGig: Gig = {
        id: updated.id,
        artist: updated.artist,
        venue: updated.venue,
        city: updated.city,
        date: updated.date,
        rating: updated.rating ?? undefined,
        notes: updated.notes ?? undefined,
        artistMbid: updated.artistMbid ?? undefined,
        externalSource: updated.externalSource ?? undefined,
        externalId: updated.externalId ?? undefined,
        ticketUrl: updated.ticketUrl ?? undefined,
        venueLatitude: updated.venueLatitude ?? undefined,
        venueLongitude: updated.venueLongitude ?? undefined,
        venuePlaceName: updated.venuePlaceName ?? undefined,
        venuePlaceId: updated.venuePlaceId ?? undefined,
      };

      return res.json(responseGig);
    } catch (error) {
      console.error("Error updating gig in Prisma:", error);
      return res.status(500).json({ error: "Failed to update gig" });
    }
  },
);

app.delete(
  "/gigs/:id",
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const userId = req.user!.id;
    const { id } = req.params;

    try {
      const existing = await prisma.gig.findFirst({
        where: {
          id,
          userId,
        },
      });

      if (!existing) {
        return res.status(404).json({ error: "Gig not found" });
      }

      await prisma.gig.delete({
        where: { id: existing.id },
      });

      const deletedGig: Gig = {
        id: existing.id,
        artist: existing.artist,
        venue: existing.venue,
        city: existing.city,
        date: existing.date,
        rating: existing.rating ?? undefined,
        notes: existing.notes ?? undefined,
        artistMbid: existing.artistMbid ?? undefined,
        externalSource: existing.externalSource ?? undefined,
        externalId: existing.externalId ?? undefined,
        ticketUrl: existing.ticketUrl ?? undefined,
        venueLatitude: existing.venueLatitude ?? undefined,
        venueLongitude: existing.venueLongitude ?? undefined,
        venuePlaceName: existing.venuePlaceName ?? undefined,
        venuePlaceId: existing.venuePlaceId ?? undefined,
      };

      return res.status(200).json({ deletedId: id, gig: deletedGig });
    } catch (error) {
      console.error("Error deleting gig in Prisma:", error);
      return res.status(500).json({ error: "Failed to delete gig" });
    }
  },
);

app.post(
  "/ocr/ticket",
  upload.single("ticket"),
  async (req: Request, res: Response) => {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No ticket image uploaded" });
    }

    try {
      const rawText = await extractRawTextFromImage(file.path);
      const parsed = parseTicketText(rawText);

      return res.json({
        rawText,
        confidence: parsed.confidence,
        prefill: {
          artist: parsed.artist,
          venue: parsed.venue,
          city: parsed.city,
          date: parsed.date,
          notes: undefined,
        },
      });
    } catch (error: any) {
      console.error("OCR route failed:", error);
      return res.status(500).json({
        message: error?.message ?? "OCR failed",
      });
    } finally {
      await unlink(file.path).catch(() => {});
    }
  },
);

app.get("/tm/events/search", async (req: Request, res: Response) => {
  try {
    const { q, keyword, city, startDateTime, endDateTime, size } = req.query;

    const kw =
      typeof q === "string"
        ? q
        : typeof keyword === "string"
          ? keyword
          : undefined;

    const data = await searchTmEventsUk({
      keyword: kw,
      city: typeof city === "string" ? city : undefined,
      startDateTime:
        typeof startDateTime === "string" ? startDateTime : undefined,
      endDateTime: typeof endDateTime === "string" ? endDateTime : undefined,
      size: typeof size === "string" ? Number(size) : undefined,
    });

    return res.json(data);
  } catch (e: any) {
    return res
      .status(502)
      .json({ message: e?.message ?? "Ticketmaster search failed" });
  }
});

app.get("/discover/events", async (req: Request, res: Response) => {
  try {
    const { q, keyword, city, startDateTime, endDateTime, size } = req.query;

    const kw =
      typeof q === "string"
        ? q
        : typeof keyword === "string"
          ? keyword
          : undefined;

    const tm = await searchTmEventsNormalized({
      keyword: kw,
      city: typeof city === "string" ? city : undefined,
      startDateTime:
        typeof startDateTime === "string" ? startDateTime : undefined,
      endDateTime: typeof endDateTime === "string" ? endDateTime : undefined,
      size: typeof size === "string" ? Number(size) : undefined,
    });

    const skiddle = await searchSkiddleEventsNormalized({
      keyword: kw,
    });

    const merged = [...tm.events, ...skiddle.events];
    const events = dedupeEvents(merged);

    return res.json({ events });
  } catch (e: any) {
    return res.status(502).json({
      message: e?.message ?? "Discover search failed",
    });
  }
});

app.get("/tm/events/:id", async (req: Request, res: Response) => {
  try {
    const data = await getTmEventByIdUk(req.params.id);
    return res.json(data);
  } catch (e: any) {
    return res
      .status(502)
      .json({ message: e?.message ?? "Ticketmaster event lookup failed" });
  }
});

app.get("/tm/venues/search", async (req: Request, res: Response) => {
  try {
    const { q, keyword, city, size } = req.query;

    const query =
      typeof q === "string" ? q : typeof keyword === "string" ? keyword : "";

    const data = await searchTmVenuesUk({
      q: query,
      city: typeof city === "string" ? city : undefined,
      size: typeof size === "string" ? Number(size) : undefined,
    });

    return res.json(data);
  } catch (e: any) {
    return res
      .status(502)
      .json({ message: e?.message ?? "Ticketmaster venue search failed" });
  }
});

app.get("/mb/artists/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;

    if (!q) {
      return res
        .status(400)
        .json({ message: "Missing required query param: q" });
    }

    const result = await searchMbArtists({ q, limit });
    return res.json(result);
  } catch (err: any) {
    console.error("MusicBrainz search error:", err);
    console.error("MusicBrainz search error cause:", err?.cause);

    return res.status(502).json({
      message: "Failed to fetch from MusicBrainz",
      detail: err?.message ?? String(err),
      cause: err?.cause ? String(err.cause) : undefined,
      name: err?.name,
      code: err?.cause?.code ?? err?.code,
    });
  }
});

app.get("/spotify/artist", async (req: Request, res: Response) => {
  try {
    const name = String(req.query.name ?? "").trim();

    if (!name) {
      return res.status(400).json({ message: "Missing artist name" });
    }

    const artist = await searchSpotifyArtist(name);
    return res.json({ artist });
  } catch (e: any) {
    return res.status(502).json({
      message: e?.message ?? "Spotify artist lookup failed",
    });
  }
});

app.get("/spotify/artist-page", async (req: Request, res: Response) => {
  try {
    const name = String(req.query.name ?? "").trim();

    console.log("[route] /spotify/artist-page hit", { name });

    if (!name) {
      return res.status(400).json({ message: "Missing artist name" });
    }

    const result = await getSpotifyArtistPage(name);

    console.log("[route] /spotify/artist-page success", {
      name,
      hasArtist: Boolean(result.artist),
      topTracks: result.topTracks.length,
      releases: result.releases.length,
    });

    return res.json(result);
  } catch (e: any) {
    console.error("[route] /spotify/artist-page failed", {
      name: String(req.query.name ?? "").trim(),
      message: e?.message ?? String(e),
    });

    return res.status(502).json({
      message: e?.message ?? "Spotify artist page lookup failed",
    });
  }
});

app.get("/setlist/artist", async (req: Request, res: Response) => {
  try {
    const artist = String(req.query.artist ?? "").trim();

    if (!artist) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Missing artist",
      });
    }

    const setlists = await searchSetlistsByArtist(artist);

    return res.status(200).json({
      success: true,
      setlists,
    });
  } catch (error: unknown) {
    if (error instanceof SetlistServiceError) {
      console.error("Setlist artist lookup failed", {
        code: error.code,
        status: error.status,
        message: error.message,
        causeText: error.causeText,
        query: {
          artist: String(req.query.artist ?? "").trim(),
        },
      });

      return res.status(503).json({
        success: false,
        code: "SETLIST_UNAVAILABLE",
        message: "Unable to load setlists right now.",
      });
    }

    console.error("Unexpected setlist artist lookup error:", error);

    return res.status(500).json({
      success: false,
      code: "INTERNAL_ERROR",
      message: "Something went wrong.",
    });
  }
});

app.get("/setlist/gig-match", async (req: Request, res: Response) => {
  try {
    const artist = String(req.query.artist ?? "").trim();
    const date = String(req.query.date ?? "").trim();
    const city =
      typeof req.query.city === "string" ? req.query.city.trim() : undefined;
    const venue =
      typeof req.query.venue === "string" ? req.query.venue.trim() : undefined;

    if (!artist || !date) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Missing required params: artist and date",
      });
    }

    const result = await matchSetlistToGig({
      artist,
      date,
      city,
      venue,
    });

    if (!result.matched) {
      return res.status(200).json({
        success: true,
        status: "no_match",
        setlist: null,
        confidence: 0,
      });
    }

    return res.status(200).json({
      success: true,
      status: "matched",
      setlist: result.setlist,
      confidence: result.confidence,
    });
  } catch (error: unknown) {
    if (error instanceof SetlistServiceError) {
      console.error("Gig setlist match failed", {
        code: error.code,
        status: error.status,
        message: error.message,
        causeText: error.causeText,
        query: {
          artist: String(req.query.artist ?? "").trim(),
          date: String(req.query.date ?? "").trim(),
          city:
            typeof req.query.city === "string"
              ? req.query.city.trim()
              : undefined,
          venue:
            typeof req.query.venue === "string"
              ? req.query.venue.trim()
              : undefined,
        },
      });

      return res.status(503).json({
        success: false,
        code: "SETLIST_UNAVAILABLE",
        message: "Unable to load setlist right now.",
      });
    }

    console.error("Unexpected gig setlist match error:", error);

    return res.status(500).json({
      success: false,
      code: "INTERNAL_ERROR",
      message: "Something went wrong.",
    });
  }
});

app.get("/lastfm/similar-artists", async (req: Request, res: Response) => {
  try {
    const artist = String(req.query.artist ?? "").trim();

    if (!artist) {
      return res.status(400).json({ message: "Missing artist" });
    }

    const artists = await getLastFmSimilarArtists(artist);
    return res.json({ artists });
  } catch (e: any) {
    return res.status(502).json({
      message: e?.message ?? "Last.fm similar artists lookup failed",
    });
  }
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal Server Error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WeGig API server running on port ${PORT}`);
});