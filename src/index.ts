import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import { randomUUID } from "crypto";
import { unlink } from "fs/promises";
import "dotenv/config";

import { searchMbArtists } from "./musicbrainz";
import { searchSpotifyArtist, getSpotifyArtistPage } from "./spotify";
import {
  searchSetlistsByArtist,
  matchSetlistToGig,
  SetlistServiceError,
} from "./setlist";
import { getLastFmSimilarArtists } from "./lastfm";
import { Gig, CreateGigInput } from "./types/Gig";
import { gigs } from "./data/gigsData";
import db from "./db";
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

const isReplitDbAvailable = Boolean(process.env.REPLIT_DB_URL);
const upload = multer({ dest: "tmp/" });

async function loadGigsFromDB() {
  try {
    const stored = await db.get("gigs");

    if (Array.isArray(stored) && stored.length > 0) {
      gigs.length = 0;
      gigs.push(...(stored as Gig[]));
      console.log(`Loaded ${gigs.length} gigs from the database`);
    } else {
      await db.set("gigs", gigs);
      console.log("No gigs found in DB – seeded with sample data");
    }
  } catch (error) {
    console.error("Error loading gigs from DB:", error);
  }
}

if (isReplitDbAvailable) {
  void loadGigsFromDB();
} else {
  console.log("Local dev: REPLIT_DB_URL not set, using in-memory gigs only");
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
  res.json({ version: "wegig-api-2026-04-03-setlist-gig-match" });
});

app.get("/gigs", (_req: Request, res: Response) => {
  const sorted = [...gigs].sort((a, b) => b.date.localeCompare(a.date));
  res.json({ count: sorted.length, gigs: sorted });
});

app.post("/gigs", async (req: Request, res: Response) => {
  const gigInput = req.body as CreateGigInput & {
    externalSource?: unknown;
    externalId?: unknown;
    artistMbid?: unknown;
    ticketUrl?: unknown;
    venueLatitude?: unknown;
    venueLongitude?: unknown;
    venuePlaceName?: unknown;
    venueMapboxId?: unknown;
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

  const venueMapboxId =
    typeof gigInput.venueMapboxId === "string" &&
    gigInput.venueMapboxId.trim() !== ""
      ? gigInput.venueMapboxId.trim()
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

  if (externalSource && externalId) {
    const already = gigs.find(
      (g: any) =>
        g?.externalSource === externalSource && g?.externalId === externalId,
    );
    if (already) {
      return res.status(409).json({
        message: "You’ve already logged this gig.",
        existingGigId: (already as any).id,
      });
    }
  }

  const newGig: Gig = {
    id: randomUUID(),
    artist: gigInput.artist.trim(),
    venue: gigInput.venue.trim(),
    city: gigInput.city.trim(),
    date: gigInput.date.trim(),
    rating: gigInput.rating,
    notes:
      typeof gigInput.notes === "string" ? gigInput.notes.trim() : undefined,
    artistMbid,
    externalSource,
    externalId,
    ticketUrl,
    venueLatitude,
    venueLongitude,
    venuePlaceName,
    venueMapboxId,
  };

  gigs.push(newGig);

  try {
    if (isReplitDbAvailable) {
      await db.set("gigs", gigs);
    }
  } catch (error) {
    console.error("Error saving gigs to DB:", error);
  }

  return res.status(201).json(newGig);
});

app.patch("/gigs/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const index = gigs.findIndex((g) => g.id === id);
  if (index === -1) return res.status(404).json({ error: "Gig not found" });

  const existing = gigs[index] as Gig;

  const next: Gig = {
    ...existing,
    artist:
      typeof req.body.artist === "string"
        ? req.body.artist.trim()
        : existing.artist,
    venue:
      typeof req.body.venue === "string"
        ? req.body.venue.trim()
        : existing.venue,
    city:
      typeof req.body.city === "string" ? req.body.city.trim() : existing.city,
    date:
      typeof req.body.date === "string" ? req.body.date.trim() : existing.date,
    rating: req.body.rating !== undefined ? req.body.rating : existing.rating,
    notes:
      typeof req.body.notes === "string"
        ? req.body.notes.trim()
        : existing.notes,
    externalSource: existing.externalSource,
    externalId: existing.externalId,
    artistMbid: existing.artistMbid,
    ticketUrl:
      typeof req.body.ticketUrl === "string"
        ? req.body.ticketUrl.trim()
        : existing.ticketUrl,
    venueLatitude:
      typeof req.body.venueLatitude === "number"
        ? req.body.venueLatitude
        : existing.venueLatitude,
    venueLongitude:
      typeof req.body.venueLongitude === "number"
        ? req.body.venueLongitude
        : existing.venueLongitude,
    venuePlaceName:
      typeof req.body.venuePlaceName === "string"
        ? req.body.venuePlaceName.trim()
        : existing.venuePlaceName,
    venueMapboxId:
      typeof req.body.venueMapboxId === "string"
        ? req.body.venueMapboxId.trim()
        : existing.venueMapboxId,
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
    (next.venueLatitude !== undefined && next.venueLongitude === undefined) ||
    (next.venueLatitude === undefined && next.venueLongitude !== undefined)
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

  gigs[index] = next;

  try {
    if (isReplitDbAvailable) {
      await db.set("gigs", gigs);
    }
  } catch (error) {
    console.error("Error saving gigs after patch:", error);
  }

  return res.json(next);
});

app.delete("/gigs/:id", async (req, res) => {
  const { id } = req.params;

  const index = gigs.findIndex((g) => g.id === id);
  if (index === -1) return res.status(404).json({ error: "Gig not found" });

  const [deleted] = gigs.splice(index, 1);

  try {
    if (isReplitDbAvailable) {
      await db.set("gigs", gigs);
    }
  } catch (error) {
    console.error("Error saving gigs after delete:", error);
  }

  return res.status(200).json({ deletedId: id, gig: deleted });
});

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