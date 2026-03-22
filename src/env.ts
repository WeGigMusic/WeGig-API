function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }

  return value;
}

export const env = {
  // ✅ MOBILE SAFE TOKEN
  mapboxToken: process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? "",

  // ✅ SERVER SECRETS
  ticketmasterApiKey: required("TICKETMASTER_API_KEY"),
  ticketmasterCountryCode: process.env.TICKETMASTER_COUNTRY_CODE || "GB",

  skiddleApiKey: required("SKIDDLE_API_KEY"),
  skiddleBaseUrl:
    process.env.SKIDDLE_BASE_URL || "https://www.skiddle.com/api/v1",
};

export function requireMapboxToken() {
  if (!env.mapboxToken) {
    throw new Error("Missing EXPO_PUBLIC_MAPBOX_TOKEN");
  }

  return env.mapboxToken;
}