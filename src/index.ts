import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "crypto";

import { searchMbArtists } from "./musicbrainz";
import { Gig, CreateGigInput } from "./types/Gig";
import { gigs } from "./data/gigsData";
import db from "./db";
import { searchTmEventsUk, getTmEventByIdUk } from "./ticketmaster";

const app = express();
const PORT = Number(process.env.PORT ?? 5000);

// --- Startup: load persisted gigs (non-blocking) ---
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
void loadGigsFromDB();

// --- Middleware ---
app.use(cors());
app.use(express.json());

app.set("etag", false);
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
});

// --- Routes ---

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

// Keep ONE version route
app.get("/version", (_req, res) => {
  res.json({ version: "wegig-api-2025-12-29-artistmbid" });
});

app.get("/gigs", (_req: Request, res: Response) => {
  const sorted = [...gigs].sort((a, b) => b.date.localeCompare(a.date));
  res.json({ count: sorted.length, gigs: sorted });
});

app.post("/gigs", async (req: Request, res: Response) => {
  // Extend input to allow optional fields without breaking existing callers
  const gigInput = req.body as CreateGigInput & {
    externalSource?: unknown;
    externalId?: unknown;
    artistMbid?: unknown; // ✅ NEW
  };

  const errors: string[] = [];

  // Required fields
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
      // validate real calendar date
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

  // Optional fields
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

  // ✅ NEW: artistMbid validation (optional)
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

  // Existing: external association validation (optional)
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

  if (errors.length > 0) {
    return res
      .status(400)
      .json({ error: "Validation failed", details: errors });
  }

  // Existing: dedupe for external imports
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

  // ✅ IMPORTANT: make sure Gig type allows artistMbid (we’ll update Gig.ts next)
  const newGig: Gig & {
    externalSource?: string;
    externalId?: string;
    artistMbid?: string;
  } = {
    id: randomUUID(),
    artist: gigInput.artist.trim(),
    venue: gigInput.venue.trim(),
    city: gigInput.city.trim(),
    date: gigInput.date.trim(),
    rating: gigInput.rating,
    notes:
      typeof gigInput.notes === "string" ? gigInput.notes.trim() : undefined,

    // ✅ NEW: persist mbid
    artistMbid,

    // Existing: persist association fields
    externalSource,
    externalId,
  };

  gigs.push(newGig);

  try {
    await db.set("gigs", gigs);
  } catch (error) {
    console.error("Error saving gigs to DB:", error);
  }

  return res.status(201).json(newGig);
});

/**
 * Edit gig (partial update)
 * PATCH /gigs/:id
 */
app.patch("/gigs/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const index = gigs.findIndex((g) => g.id === id);
  if (index === -1) return res.status(404).json({ error: "Gig not found" });

  const existing = gigs[index] as any;

  const next: Gig & {
    externalSource?: string;
    externalId?: string;
    artistMbid?: string;
  } = {
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

    // keep association/mbid as-is for now
    externalSource: existing.externalSource,
    externalId: existing.externalId,
    artistMbid: existing.artistMbid,
  };

  const errors: string[] = [];
  if (!next.artist?.trim()) errors.push("artist must be a non-empty string");
  if (!next.venue?.trim()) errors.push("venue must be a non-empty string");
  if (!next.city?.trim()) errors.push("city must be a non-empty string");
  if (!next.date?.trim()) errors.push("date must be a non-empty string");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(next.date))
    errors.push("date must be in YYYY-MM-DD format");

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

  if (errors.length > 0)
    return res
      .status(400)
      .json({ error: "Validation failed", details: errors });

  gigs[index] = next;

  try {
    await db.set("gigs", gigs);
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
    await db.set("gigs", gigs);
  } catch (error) {
    console.error("Error saving gigs after delete:", error);
  }

  return res.status(200).json({ deletedId: id, gig: deleted });
});

// Ticketmaster
app.get("/tm/events/search", async (req: Request, res: Response) => {
  try {
    const { keyword, city, startDateTime, endDateTime, size } = req.query;

    const data = await searchTmEventsUk({
      keyword: typeof keyword === "string" ? keyword : undefined,
      city: typeof city === "string" ? city : undefined,
      startDateTime:
        typeof startDateTime === "string" ? startDateTime : undefined,
      endDateTime: typeof endDateTime === "string" ? endDateTime : undefined,
      size: typeof size === "string" ? Number(size) : undefined,
    });

    return res.json(data);
  } catch (e: any) {
    return res
      .status(500)
      .json({ message: e?.message ?? "Ticketmaster search failed" });
  }
});

app.get("/tm/events/:id", async (req: Request, res: Response) => {
  try {
    const data = await getTmEventByIdUk(req.params.id);
    return res.json(data);
  } catch (e: any) {
    return res
      .status(500)
      .json({ message: e?.message ?? "Ticketmaster event lookup failed" });
  }
});

// MusicBrainz
app.get("/mb/artists/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;

    if (!q)
      return res
        .status(400)
        .json({ message: "Missing required query param: q" });

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

// Error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal Server Error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WeGig API server running on port ${PORT}`);
});
