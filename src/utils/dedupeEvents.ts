import type { NormalizedEvent } from "../types/Event";

export function dedupeEvents(
  events: NormalizedEvent[],
): NormalizedEvent[] {
  const map = new Map<string, NormalizedEvent>();

  for (const event of events) {
    const key = buildKey(event);

    const existing = map.get(key);

    if (!existing) {
      map.set(key, event);
      continue;
    }

    const preferred = choosePreferredEvent(existing, event);

    map.set(key, preferred);
  }

  return Array.from(map.values());
}

function choosePreferredEvent(
  a: NormalizedEvent,
  b: NormalizedEvent,
): NormalizedEvent {
  const priority = {
    ticketmaster: 4,
    skiddle: 3,
    setlistfm: 2,
    eventbrite: 1,
  } as const;

  return priority[b.source] > priority[a.source] ? b : a;
}

function buildKey(event: NormalizedEvent): string {
  const artist =
    event.artists?.[0]?.name ||
    event.title ||
    "";

  const venue = event.venueName || "";
  const city = event.city || "";
  const date = (event.date || event.dateTime || "").slice(0, 10);

  return [
    normalize(artist),
    normalize(venue),
    normalize(city),
    normalize(date),
  ].join("|");
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}