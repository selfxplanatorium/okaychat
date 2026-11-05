import type { KnowledgeCapabilities } from "../shared/knowledge.js";
import { newId, sha256 } from "./crypto.js";
import { AppError, redactSecrets } from "./errors.js";
import { MAX_OCR_BYTES, OCR_TIMEOUT_MS } from "./extraction/limits.js";
import { readCapped } from "./public-fetch.js";
import { sandboxCall, sandboxConfigured, SandboxHttpError } from "./sandbox-client.js";
import { assertServiceAvailable, serviceStatus } from "./services.js";

// Knowledge OCR through the code sandbox's fixed-input `/ocr` route: the runner gets raw bytes, runs its own
// Tesseract/OCRmyPDF command in a fresh jail, and answers plain text. No model code runs, so this needs the
// sandbox service but not the account's `code` feature. Chat never calls this (docs/implementation/extraction.md).

/** The sandbox is not configured or not reachable. The message is the source's actionable failure text. */
export class OcrUnavailableError extends Error {}
/** The engine ran (or refused the input) and produced no usable text. */
export class OcrFailedError extends Error {}

export type OcrKind = "image" | "pdf";

const MESSAGES: Record<OcrKind, { notConfigured: string; unreachable: string }> = {
  image: {
    notConfigured: "This image needs OCR. OCR requires the code sandbox, which this server has not configured. Add a text version, or ask an admin to enable the sandbox.",
    unreachable: "This image needs OCR. The code sandbox is not reachable right now. Add a text version, or try again when it is back.",
  },
  pdf: {
    notConfigured: "This PDF has no text layer. Reading it needs OCR, which requires the code sandbox. It is not configured on this server. Add a text version, or ask an admin to enable the sandbox.",
    unreachable: "This PDF has no text layer. Reading it needs OCR, but the code sandbox is not reachable right now. Add a text version, or try again when it is back.",
  },
};
export const OCR_FAILED = "OCR could not read this file. Try a clearer image or a text version.";
export const OCR_BUSY = "The code sandbox is busy. Try again in a moment.";
const OCR_TOO_LARGE = "The OCR result was too large.";
/** Runner text cap (4 MiB); the app then keeps at most MAX_OCR_TEXT_CHARS. */
const MAX_OCR_RESPONSE = 4 * 1024 * 1024;

type Transport = typeof sandboxCall;
let configured: () => boolean = sandboxConfigured;
let transport: Transport = sandboxCall;

/** Tests only. */
export function setOcrConfiguredForTests(fn: (() => boolean) | null) {
  configured = fn ?? sandboxConfigured;
}

/** Tests only: replaces the authenticated runner call. */
export function setOcrTransportForTests(fn: Transport | null) {
  transport = fn ?? sandboxCall;
}

/** Per source, so two sources can run in parallel; deleted after every call so its uid is released. */
export const ocrWorkspace = (userId: string, sourceId: string) => sha256(`ocr:${userId}:${sourceId}`).slice(0, 32);

const aborted = () => new DOMException("Aborted", "AbortError");

export async function ocrExtract(req: { userId: string; sourceId: string; kind: OcrKind; data: Uint8Array; signal?: AbortSignal }): Promise<string> {
  const messages = MESSAGES[req.kind];
  if (!configured()) throw new OcrUnavailableError(messages.notConfigured);
  if (req.data.byteLength > MAX_OCR_BYTES) throw new OcrFailedError("This file is larger than 25 MB, which is the OCR limit.");
  if (req.signal?.aborted) throw aborted();
  const ws = ocrWorkspace(req.userId, req.sourceId);
  const job = newId("ocr");
  const quiet = (res: Response) => void res.body?.cancel().catch(() => {});
  try {
    try {
      assertServiceAvailable("sandbox");
      const res = await transport(
        `/workspaces/${ws}/ocr?job=${job}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(req.data) },
        OCR_TIMEOUT_MS + 30_000,
        req.signal,
      );
      const bytes = await readCapped(res, MAX_OCR_RESPONSE, OCR_TOO_LARGE);
      // The caller compares the length with MAX_OCR_TEXT_CHARS; a knowledge source is never indexed partially.
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    } catch (error) {
      if (req.signal?.aborted) {
        await transport(`/workspaces/${ws}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job }) }, 5_000, undefined, false)
          .then(quiet)
          .catch(() => {});
        throw aborted();
      }
      if (error instanceof AppError && error.code === "service_unavailable") throw new OcrUnavailableError(messages.unreachable);
      if (error instanceof SandboxHttpError && error.status === 429) throw new OcrFailedError(OCR_BUSY);
      if (error instanceof Error && error.message === OCR_TOO_LARGE) throw new OcrFailedError(OCR_TOO_LARGE);
      // Runner detail (stderr tails, limits) stays in the log; the source shows the fixed message.
      console.error("[ocr] failed", redactSecrets(String((error as Error)?.message ?? error)).slice(0, 500));
      throw new OcrFailedError(OCR_FAILED);
    }
  } finally {
    await transport(`/workspaces/${ws}`, { method: "DELETE" }, 10_000, undefined, false).then(quiet).catch(() => {});
  }
}

/** What the knowledge page tells the user about OCR. Never probes an unconfigured sandbox; ignores the `code` feature. */
export async function knowledgeCapabilities(): Promise<KnowledgeCapabilities> {
  if (!configured()) return { ocr: { available: false, reason: "not_configured" } };
  const status = await serviceStatus("sandbox");
  const available = status?.state === "up" || status?.state === "degraded";
  return { ocr: available ? { available: true, reason: "ok" } : { available: false, reason: "unavailable" } };
}
