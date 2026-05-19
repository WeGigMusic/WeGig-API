function required(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Missing env var: ${name}`);
  }

  return value.trim();
}

function optional(name: string, fallback = ""): string {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    return fallback;
  }

  return value.trim();
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),

  port: Number(optional("PORT", "5050")),

  // mobile-safe
  mapboxToken: optional("EXPO_PUBLIC_MAPBOX_TOKEN"),

  // database
  databaseUrl: required("DATABASE_URL"),

  // auth
  supabaseUrl: required("SUPABASE_URL"),
  supabaseAnonKey: required("SUPABASE_ANON_KEY"),
  supabaseJwtSecret: optional("SUPABASE_JWT_SECRET"),

  // ticketmaster
  ticketmasterApiKey: required("TICKETMASTER_API_KEY"),
  ticketmasterCountryCode: optional(
    "TICKETMASTER_COUNTRY_CODE",
    "GB",
  ),

  // skiddle
  skiddleApiKey: required("SKIDDLE_API_KEY"),
  skiddleBaseUrl: optional(
    "SKIDDLE_BASE_URL",
    "https://www.skiddle.com/api/v1",
  ),

  // spotify
  spotifyClientId: required("SPOTIFY_CLIENT_ID"),
  spotifyClientSecret: required("SPOTIFY_CLIENT_SECRET"),

  // optional integrations
  setlistFmApiKey: optional("SETLISTFM_API_KEY"),
  lastFmApiKey: optional("LASTFM_API_KEY"),
};

export function requireMapboxToken() {
  if (!env.mapboxToken) {
    throw new Error("Missing EXPO_PUBLIC_MAPBOX_TOKEN");
  }

  return env.mapboxToken;
}