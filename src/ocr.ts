import { createWorker, PSM, type Worker } from "tesseract.js";

let cachedWorker: Worker | null = null;

async function getWorker(): Promise<Worker> {
  if (cachedWorker) {
    return cachedWorker;
  }

  const worker = await createWorker("eng");

  await worker.setParameters({
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });

  cachedWorker = worker;
  return cachedWorker;
}

function cleanExtractedText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[|]+/g, " ")
    .replace(/[‐-–—]+/g, "-")
    .trim();
}

function buildPassOneText(text: string): string {
  return cleanExtractedText(text);
}

function buildPassTwoText(text: string): string {
  return cleanExtractedText(
    text
      .replace(/[@]/g, "a")
      .replace(/[€]/g, "E")
      .replace(/[§]/g, "S"),
  );
}

function mergeTexts(primary: string, secondary: string): string {
  if (!primary) return secondary;
  if (!secondary) return primary;
  if (secondary === primary) return primary;

  const primaryLines = primary.split("\n").map((line) => line.trim());
  const secondaryLines = secondary.split("\n").map((line) => line.trim());

  const merged = [...primaryLines];

  for (const line of secondaryLines) {
    if (!line) continue;
    if (!merged.some((existing) => existing.toLowerCase() === line.toLowerCase())) {
      merged.push(line);
    }
  }

  return merged.join("\n").trim();
}

export async function extractRawTextFromImage(
  filePath: string,
): Promise<string> {
  const worker = await getWorker();

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });

  const passOne = await worker.recognize(filePath);
  const primaryText = buildPassOneText(passOne.data.text ?? "");

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });

  const passTwo = await worker.recognize(filePath);
  const secondaryText = buildPassTwoText(passTwo.data.text ?? "");

  const merged = mergeTexts(primaryText, secondaryText);

  if (!merged) {
    throw new Error("No text detected in image");
  }

  return merged;
}