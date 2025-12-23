import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "crypto";

import { Gig, CreateGigInput } from "./types/Gig";
import { gigs } from "./data/gigsData";
import db from "./db";

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
app.use(cors()); // Optional upgrade later: cors({ origin: true })
app.use(express.json());

app.set("etag", false);
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
});

// --- Routes ---
// Optional upgrade: friendly root route so Replit Autoscale health checks pass (hits "/")
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

app.get("/gigs", (_req: Request, res: Response) => {
  // Optional upgrade: newest-first sorting; YYYY-MM-DD sorts lexicographically
  const sorted = [...gigs].sort((a, b) => b.date.localeCompare(a.date));
  res.json({ count: sorted.length, gigs: sorted });
});

app.post("/gigs", async (req: Request, res: Response) => {
  const gigInput: CreateGigInput = req.body;
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

  if (errors.length > 0) {
    return res
      .status(400)
      .json({ error: "Validation failed", details: errors });
  }

  const newGig: Gig = {
    id: randomUUID(), // Optional upgrade: collision-proof IDs
    artist: gigInput.artist.trim(),
    venue: gigInput.venue.trim(),
    city: gigInput.city.trim(),
    date: gigInput.date.trim(),
    rating: gigInput.rating,
    notes: gigInput.notes ? gigInput.notes.trim() : undefined,
  };

  gigs.push(newGig);

  try {
    await db.set("gigs", gigs);
    console.log(`Saved ${gigs.length} gigs to the database`);
  } catch (error) {
    console.error("Error saving gigs to DB:", error);
    // Optional upgrade: keep returning success so client UX isn't blocked by DB hiccup
  }

  return res.status(201).json(newGig);
});

// Optional upgrade: better JSON error output if any unhandled error occurs
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal Server Error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WeGig API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Gigs endpoint: http://localhost:${PORT}/gigs`);
});
