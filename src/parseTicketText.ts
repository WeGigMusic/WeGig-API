type ParsedTicketText = {
  artist?: string;
  venue?: string;
  city?: string;
  date?: string;
  confidence: number;
};

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

const KNOWN_CITIES = [
  "LONDON",
  "MANCHESTER",
  "LIVERPOOL",
  "GLASGOW",
  "BIRMINGHAM",
  "LEEDS",
  "BRISTOL",
  "SHEFFIELD",
  "NOTTINGHAM",
  "NEWCASTLE",
  "CARDIFF",
  "BELFAST",
  "DUBLIN",
  "EDINBURGH",
];

const PROVIDER_WORDS = [
  "TICKETMASTER",
  "SKIDDLE",
  "EVENTIM",
  "AXS",
  "SEETICKETS",
  "SEE TICKETS",
  "TICKETWEB",
  "LIVE NATION",
];

const VENUE_HINTS = [
  "ARENA",
  "ACADEMY",
  "THEATRE",
  "THEATER",
  "HALL",
  "STADIUM",
  "CENTRE",
  "CENTER",
  "CLUB",
  "INSTITUTE",
  "BARROWLAND",
  "APOLLO",
  "O2",
  "OVO",
  "HYDRO",
  "ROUNDHOUSE",
  "BRIXTON",
  "ROOM",
  "PAVILION",
  "CHAPEL",
];

const JUNK_PATTERNS = [
  /\bADMIT\b/i,
  /\bGENERAL ADMISSION\b/i,
  /\bDOORS?\b/i,
  /\bOPEN\b/i,
  /\bSECTION\b/i,
  /\bROW\b/i,
  /\bSEAT\b/i,
  /\bBLOCK\b/i,
  /\bPRICE\b/i,
  /\bFEE\b/i,
  /\bORDER\b/i,
  /\bREFERENCE\b/i,
  /\bREF\b/i,
  /\bTICKET\b/i,
  /\bBOOKING\b/i,
  /\bENTRY\b/i,
  /\bBARCODE\b/i,
  /\bTERMS?\b/i,
  /\bCONDITIONS?\b/i,
  /\bGATE\b/i,
  /\bTIME\b/i,
  /\bDOOR\b/i,
  /\bVALID\b/i,
  /\bCUSTOMER\b/i,
  /\bACCOUNT\b/i,
  /\bDELIVERY\b/i,
  /\bACCESS\b/i,
  /\bCHECK IN\b/i,
  /\bQR\b/i,
  /\bSCAN\b/i,
  /\bWEB\b/i,
  /\bHTTPS?:\/\/\S+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

export function parseTicketText(rawText: string): ParsedTicketText {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .filter((line) => !isProviderLine(line));

  const date = findDate(lines);
  const city = findCity(lines);
  const venue = findVenue(lines, city);
  const artist = findArtist(lines, { venue, city, date });

  let confidence = 0;
  if (artist) confidence += 0.4;
  if (venue) confidence += 0.25;
  if (city) confidence += 0.15;
  if (date) confidence += 0.2;

  return {
    artist,
    venue,
    city,
    date,
    confidence: Math.min(confidence, 0.95),
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLine(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/[|]+/g, " ")
      .replace(/[•]+/g, " ")
      .replace(/[‐-–—]+/g, "-")
      .replace(/\b0(?=[A-Z])/g, "O"),
  );
}

function smartTitle(value: string): string {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) return cleaned;

  if (cleaned === cleaned.toUpperCase()) {
    return cleaned
      .toLowerCase()
      .split(" ")
      .map((part) => {
        if (part === "o2") return "O2";
        if (part === "ovo") return "OVO";
        if (part === "uk") return "UK";
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }

  return cleaned;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isProviderLine(line: string): boolean {
  const upper = line.toUpperCase();
  return PROVIDER_WORDS.some((word) => upper.includes(word));
}

function containsJunk(line: string): boolean {
  return JUNK_PATTERNS.some((pattern) => pattern.test(line));
}

function looksLikeCode(line: string): boolean {
  const compact = line.replace(/\s/g, "");
  if (compact.length < 6) return false;
  return /^[A-Z0-9-]+$/.test(compact) && /\d/.test(compact);
}

function stripProviderWords(line: string): string {
  let next = line;
  for (const word of PROVIDER_WORDS) {
    next = next.replace(new RegExp(word, "ig"), " ");
  }
  return normalizeWhitespace(next);
}

function removeCityFromLine(line: string, city?: string): string {
  if (!city) return line;
  return normalizeWhitespace(line.replace(new RegExp(city, "i"), " "));
}

function findDate(lines: string[]): string | undefined {
  for (const line of lines) {
    const iso = line.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
    if (iso) {
      const yyyy = iso[1];
      const mm = iso[2].padStart(2, "0");
      const dd = iso[3].padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    }

    const uk = line.match(/\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/);
    if (uk) {
      const dd = uk[1].padStart(2, "0");
      const mm = uk[2].padStart(2, "0");
      const yyyy = uk[3];
      return `${yyyy}-${mm}-${dd}`;
    }

    const month = line.toUpperCase().match(
      /\b(\d{1,2})\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\s+(20\d{2})\b/,
    );

    if (month) {
      const dd = month[1].padStart(2, "0");
      const token = month[2] === "SEPT" ? "SEP" : month[2];
      const mm = String(MONTHS.indexOf(token) + 1).padStart(2, "0");
      const yyyy = month[3];
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  return undefined;
}

function findCity(lines: string[]): string | undefined {
  for (const line of lines) {
    const upper = line.toUpperCase();
    const match = KNOWN_CITIES.find((city) => upper.includes(city));
    if (match) {
      return titleCase(match);
    }
  }

  return undefined;
}

function findVenue(lines: string[], city?: string): string | undefined {
  const candidates = lines
    .filter((line) => !containsJunk(line))
    .filter((line) => !looksLikeCode(line))
    .map(stripProviderWords)
    .filter(Boolean)
    .filter((line) => line.length >= 4);

  for (const line of candidates) {
    const upper = line.toUpperCase();

    if (!VENUE_HINTS.some((hint) => upper.includes(hint))) {
      continue;
    }

    let cleaned = removeCityFromLine(line, city);
    cleaned = cleaned.replace(/\b(UNITED KINGDOM|UK)\b/gi, " ");
    cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
    cleaned = cleaned.replace(/[•|,-]\s*$/, "").trim();

    if (cleaned.length >= 3) {
      return smartTitle(cleaned);
    }
  }

  return undefined;
}

function findArtist(
  lines: string[],
  context: {
    venue?: string;
    city?: string;
    date?: string;
  },
): string | undefined {
  const venueUpper = context.venue?.toUpperCase();
  const cityUpper = context.city?.toUpperCase();
  const dateUpper = context.date?.toUpperCase();

  const candidates = lines
    .map((line) => normalizeLine(stripProviderWords(line)))
    .filter(Boolean)
    .filter((line) => line.length >= 3)
    .filter((line) => !containsJunk(line))
    .filter((line) => !looksLikeCode(line))
    .filter((line) => !/\b\d{3,}\b/.test(line))
    .filter((line) => {
      const upper = line.toUpperCase();
      if (venueUpper && upper === venueUpper) return false;
      if (cityUpper && upper === cityUpper) return false;
      if (dateUpper && upper === dateUpper) return false;
      return true;
    });

  const ranked = candidates
    .map((line, index) => ({
      line,
      score: scoreArtistLine(line, index),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 2) {
    return undefined;
  }

  return smartTitle(best.line);
}

function scoreArtistLine(line: string, index: number): number {
  let score = 0;
  const trimmed = line.trim();
  const upper = trimmed.toUpperCase();

  if (index <= 2) score += 2;
  if (trimmed.length >= 4 && trimmed.length <= 40) score += 2;
  if (/^[A-Z0-9 &.'!/-]+$/.test(trimmed)) score += 2;
  if (!/\d/.test(trimmed)) score += 1;
  if (!VENUE_HINTS.some((hint) => upper.includes(hint))) score += 1;
  if (!KNOWN_CITIES.some((city) => upper.includes(city))) score += 1;
  if (upper.includes("LIVE")) score -= 1;
  if (upper.includes("PRESENTS")) score -= 2;

  return score;
}