import { env } from "./env";
import type { NormalizedEvent } from "./types/Event";

const BASE = env.skiddleBaseUrl;

export async function searchSkiddleEventsNormalized(input: {
  keyword?: string;
  latitude?: number;
  longitude?: number;
}) {
  const params = new URLSearchParams({
    api_key: env.skiddleApiKey,
    keyword: input.keyword ?? "",
    latitude: String(input.latitude ?? 51.5074),
    longitude: String(input.longitude ?? -0.1278),
    radius: "15",
    eventcode: "LIVE",
    description: "1",
  });

  const url = `${BASE}/events/search/?${params.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Skiddle error ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json();
  const events = (json?.results ?? []).map(mapSkiddleEvent);

  return { events };
}

function mapSkiddleEvent(e: any): NormalizedEvent {
  return {
    source: "skiddle",
    sourceEventId: String(e?.id ?? ""),
    title: e?.eventname ?? "",
    date: e?.date,
    dateTime: e?.startdate,
    ticketUrl: e?.link,
    venueName: e?.venue?.name,
    city: e?.venue?.town,
    countryCode: "GB",
    artists: [],
  };
}