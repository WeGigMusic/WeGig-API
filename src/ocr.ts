import fs from "node:fs/promises";

/**
 * TEMP: fake OCR so your feature works end-to-end
 * Replace later with real OCR
 */
export async function extractRawTextFromImage(
  filePath: string,
): Promise<string> {
  // TODO: replace with real OCR (ML Kit or API)

  return `
    OASIS
    O2 ARENA LONDON
    12-08-2022
    GENERAL ADMISSION
  `;
}