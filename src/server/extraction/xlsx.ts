import { HTTPException } from "hono/http-exception";
import { readXlsx } from "../documents/lazy.js";
import { ExtractionError } from "./errors.js";
import type { PartResult } from "./index.js";

/** exceljs checks the archive bounds itself (documents/xlsx.ts). */
export async function extractXlsx(data: Uint8Array): Promise<PartResult> {
  try {
    return { text: await readXlsx(data) };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new ExtractionError("damaged", "Could not open this spreadsheet. It may be damaged.");
  }
}
