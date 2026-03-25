export function normaliseArtistName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/^the\s+/, "")
    .replace(/^a\s+/, "")
    .replace(/^an\s+/, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}