type Parsed = {
  artist?: string;
  venue?: string;
  city?: string;
  date?: string;
  confidence: number;
};

export function parseTicketText(rawText: string): Parsed {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const artist = lines[0];
  const venueLine = lines.find((l) =>
    l.toUpperCase().includes("ARENA"),
  );

  const city = venueLine?.includes("LONDON") ? "London" : undefined;

  const dateMatch = rawText.match(/\d{2}-\d{2}-\d{4}/);
  const date = dateMatch
    ? dateMatch[0].split("-").reverse().join("-")
    : undefined;

  return {
    artist,
    venue: venueLine,
    city,
    date,
    confidence: 0.7,
  };
}