import type { NormalizedEvent } from "../types/Event";

export function dedupeEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  const map = new Map<string, NormalizedEvent>();

  for (const e of events) {
    const key = buildKey(e);

    if (!map.has(key)) {
      map.set(key, e);
      continue;
    }

    const existing = map.get(key)!;

    // Prefer Ticketmaster over others for now
    if (e.source === "ticketmaster" && existing.source !== "ticketmaster") {
      map.set(key, e);
    }
  }

  return Array.from(map.values());
}

function buildKey(e: NormalizedEvent) {
  return [
    (e.title || "").toLowerCase().trim(),
    (e.venueName || "").toLowerCase().trim(),
    (e.date || e.dateTime || "").slice(0, 10),
  ].join("|");
}