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

app.get("/version", (_req, res) => {
  res.json({ version: "mb-route-test-2025-12-29-1" });
});

app.get("/version", (_req, res) => {
  res.json({ version: "wegig-api-2025-12-28-edit" });
});

app.get("/gigs", (_req: Request, res: Response) => {
  const sorted = [...gigs].sort((a, b) => b.date.localeCompare(a.date));
  res.json({ count: sorted.length, gigs: sorted });
});

app.post("/gigs", async (req: Request, res: Response) => {
  // Allow extra optional fields for external association without breaking existing callers
  const gigInput = req.body as CreateGigInput & {
    externalSource?: unknown;
    externalId?: unknown;
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
        const [inputYear, inputMonth, inputDay] = dateStr
          .split("-")
          .map(Number);
        const actualYear = parsedDate.getUTCFullYear();
        const actualMonth = parsedDate.getUTCMonth() + 1;
        const actualDay = parsedDate.getUTCDate();

        if (
          inputYear !== actualYear ||
          inputMonth !== actualMonth ||
          inputDay !== actualDay
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

  // ✅ NEW: external association validation (optional)
  const externalSource =
    typeof gigInput.externalSource === "string" &&
    gigInput.externalSource.trim() !== ""
      ? gigInput.externalSource.trim()
      : undefined;

  const externalId =
    typeof gigInput.externalId === "string" && gigInput.externalId.trim() !== ""
      ? gigInput.externalId.trim()
      : undefined;

  // If one is provided, require the other (prevents half-baked associations)
  if ((externalSource && !externalId) || (!externalSource && externalId)) {
    errors.push("externalSource and externalId must be provided together");
  }

  if (errors.length > 0) {
    return res
      .status(400)
      .json({ error: "Validation failed", details: errors });
  }

  // ✅ NEW: dedupe for external imports (Ticketmaster association)
  if (externalSource && externalId) {
    const already = gigs.find((g: any) => {
      return (
        g?.externalSource === externalSource && g?.externalId === externalId
      );
    });

    if (already) {
      return res.status(409).json({
        message: "You’ve already logged this gig.",
        existingGigId: (already as any).id,
      });
    }
  }

  const newGig: Gig & { externalSource?: string; externalId?: string } = {
    id: randomUUID(),
    artist: gigInput.artist.trim(),
    venue: gigInput.venue.trim(),
    city: gigInput.city.trim(),
    date: gigInput.date.trim(),
    rating: gigInput.rating,
    notes: gigInput.notes ? gigInput.notes.trim() : undefined,

    // ✅ NEW: save association fields
    externalSource,
    externalId,
  };

  gigs.push(newGig);

  try {
    await db.set("gigs", gigs);
    console.log(`Saved ${gigs.length} gigs to the database`);
  } catch (error) {
    console.error("Error saving gigs to DB:", error);
  }

  return res.status(201).json(newGig);
});

/**
 * NEW: Edit gig (partial update)
 * PATCH /gigs/:id
 */
app.patch("/gigs/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  const index = gigs.findIndex((g) => g.id === id);
  if (index === -1) {
    return res.status(404).json({ error: "Gig not found" });
  }

  const existing = gigs[index] as any;

  const next: Gig & { externalSource?: string; externalId?: string } = {
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

    // Keep association fields as-is (we don’t allow editing these via PATCH right now)
    externalSource: existing.externalSource,
    externalId: existing.externalId,
  };

  const errors: string[] = [];

  if (!next.artist?.trim()) errors.push("artist must be a non-empty string");
  if (!next.venue?.trim()) errors.push("venue must be a non-empty string");
  if (!next.city?.trim()) errors.push("city must be a non-empty string");

  if (!next.date?.trim()) {
    errors.push("date must be a non-empty string");
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(next.date)) {
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

  if (errors.length > 0) {
    return res
      .status(400)
      .json({ error: "Validation failed", details: errors });
  }

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
  if (index === -1) {
    return res.status(404).json({ error: "Gig not found" });
  }

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
    return res.status(502).json({
      message: "Failed to fetch from MusicBrainz",
      detail: err?.message ?? String(err),
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
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Gigs endpoint: http://localhost:${PORT}/gigs`);
});
