import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { ProbeFn } from "./services.js";

// The sandbox URL and token are read by env.ts when the server modules first load, so they must be set before
// the dynamic imports below. The transport seam replaces the authenticated runner call, so no server runs.
process.env.OKAYCHAT_SANDBOX_URL = "http://127.0.0.1:9";
process.env.OKAYCHAT_SANDBOX_TOKEN = "ocr-test-token-".padEnd(40, "x");

const {
  knowledgeCapabilities,
  ocrExtract,
  ocrWorkspace,
  OcrFailedError,
  OcrUnavailableError,
  OCR_BUSY,
  OCR_FAILED,
  setOcrConfiguredForTests,
  setOcrTransportForTests,
} = await import("./ocr.js");
const { reportServiceFailure, resetServicesForTests, serviceUnavailable, setServiceProbeForTests } = await import("./services.js");
const { SandboxHttpError } = await import("./sandbox-client.js");

type Transport = typeof import("./sandbox-client.js").sandboxCall;
interface Call {
  route: string;
  method: string;
  body?: Uint8Array;
  text?: string;
}

const calls: Call[] = [];

/** Records every runner call and lets the test answer it. */
function recordingTransport(handle: (route: string, init: RequestInit, signal?: AbortSignal) => Promise<Response>): Transport {
  return async (route, init = {}, _timeoutMs, signal) => {
    const body = init.body;
    calls.push({
      route,
      method: init.method ?? "GET",
      ...(body instanceof Uint8Array ? { body: new Uint8Array(body) } : typeof body === "string" ? { text: body } : {}),
    });
    return handle(route, init, signal);
  };
}

const ok = () => new Response("", { status: 200 });
const input = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const IMAGE_NOT_CONFIGURED =
  "This image needs OCR. OCR requires the code sandbox, which this server has not configured. Add a text version, or ask an admin to enable the sandbox.";
const IMAGE_UNREACHABLE =
  "This image needs OCR. The code sandbox is not reachable right now. Add a text version, or try again when it is back.";
const PDF_NOT_CONFIGURED =
  "This PDF has no text layer. Reading it needs OCR, which requires the code sandbox. It is not configured on this server. Add a text version, or ask an admin to enable the sandbox.";
const PDF_UNREACHABLE =
  "This PDF has no text layer. Reading it needs OCR, but the code sandbox is not reachable right now. Add a text version, or try again when it is back.";

beforeEach(() => {
  calls.length = 0;
  setOcrConfiguredForTests(null);
  setOcrTransportForTests(null);
  resetServicesForTests();
});

afterEach(() => {
  setOcrConfiguredForTests(null);
  setOcrTransportForTests(null);
  resetServicesForTests();
});

test("OCR: an unconfigured sandbox explains the image and PDF cases without calling the runner", async () => {
  setOcrConfiguredForTests(() => false);
  setOcrTransportForTests(recordingTransport(async () => ok()));

  await assert.rejects(
    ocrExtract({ userId: "user-1", sourceId: "source-1", kind: "image", data: input() }),
    (error: unknown) => error instanceof OcrUnavailableError && error.message === IMAGE_NOT_CONFIGURED,
  );
  await assert.rejects(
    ocrExtract({ userId: "user-1", sourceId: "source-2", kind: "pdf", data: input() }),
    (error: unknown) => error instanceof OcrUnavailableError && error.message === PDF_NOT_CONFIGURED,
  );
  assert.equal(calls.length, 0);
});

test("OCR: a sandbox the registry reports down is unreachable, with no OCR request", async () => {
  setOcrConfiguredForTests(() => true);
  setOcrTransportForTests(recordingTransport(async () => ok()));
  reportServiceFailure("sandbox");

  await assert.rejects(
    ocrExtract({ userId: "user-1", sourceId: "source-1", kind: "image", data: input() }),
    (error: unknown) => error instanceof OcrUnavailableError && error.message === IMAGE_UNREACHABLE,
  );
  assert.equal(calls.filter((call) => call.route.includes("/ocr?")).length, 0);
});

test("OCR: a transport serviceUnavailable failure is reported as unreachable", async () => {
  setOcrConfiguredForTests(() => true);
  setOcrTransportForTests(
    recordingTransport(async (route) => {
      if (route.includes("/ocr?")) throw serviceUnavailable("sandbox");
      return ok();
    }),
  );

  await assert.rejects(
    ocrExtract({ userId: "user-1", sourceId: "source-1", kind: "pdf", data: input() }),
    (error: unknown) => error instanceof OcrUnavailableError && error.message === PDF_UNREACHABLE,
  );
});

test("OCR: the happy path posts the bytes, returns trimmed text, and deletes the workspace once", async () => {
  setOcrConfiguredForTests(() => true);
  const bytes = input();
  let posted: Uint8Array | undefined;
  setOcrTransportForTests(
    recordingTransport(async (route, init) => {
      if (route.includes("/ocr?")) {
        posted = init.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined;
        return new Response("  Quasar OCR text \n");
      }
      return ok();
    }),
  );

  const text = await ocrExtract({ userId: "user-1", sourceId: "source-1", kind: "image", data: bytes });
  assert.equal(text, "Quasar OCR text");

  const workspace = ocrWorkspace("user-1", "source-1");
  const ocr = calls.find((call) => call.route.includes("/ocr?"));
  assert.ok(ocr, "the OCR request was sent");
  const url = new URL(ocr.route, "http://runner");
  assert.equal(url.pathname, `/workspaces/${workspace}/ocr`);
  assert.match(url.searchParams.get("job") ?? "", /^ocr_[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(posted, bytes);

  const deletes = calls.filter((call) => call.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0]!.route, `/workspaces/${workspace}`);
  assert.ok(calls.indexOf(ocr) < calls.indexOf(deletes[0]!), "the workspace is deleted after the OCR request");
});

test("OCR: aborting during the request cancels the job, deletes the workspace, and rejects", async () => {
  setOcrConfiguredForTests(() => true);
  let job = "";
  setOcrTransportForTests(
    recordingTransport(async (route, _init, signal) => {
      if (route.includes("/ocr?")) {
        job = new URL(route, "http://runner").searchParams.get("job") ?? "";
        await new Promise<never>((_resolve, reject) => {
          if (!signal) return reject(new Error("the OCR request needs a signal"));
          if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return ok();
    }),
  );

  const controller = new AbortController();
  const run = ocrExtract({ userId: "user-1", sourceId: "source-1", kind: "image", data: input(), signal: controller.signal });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(run, (error: unknown) => error instanceof Error && error.name === "AbortError");

  const workspace = ocrWorkspace("user-1", "source-1");
  const cancel = calls.find((call) => call.route.endsWith("/cancel"));
  assert.ok(cancel, "the cancel request was sent");
  assert.equal(cancel.method, "POST");
  assert.equal(cancel.route, `/workspaces/${workspace}/cancel`);
  assert.deepEqual(JSON.parse(cancel.text ?? "{}"), { job });
  assert.equal(calls.filter((call) => call.method === "DELETE" && call.route === `/workspaces/${workspace}`).length, 1);
});

test("OCR: 429 answers the busy message", async () => {
  setOcrConfiguredForTests(() => true);
  setOcrTransportForTests(
    recordingTransport(async (route) => {
      if (route.includes("/ocr?")) throw new SandboxHttpError(429, {});
      return ok();
    }),
  );
  await assert.rejects(
    ocrExtract({ userId: "user-1", sourceId: "source-1", kind: "image", data: input() }),
    (error: unknown) => error instanceof OcrFailedError && error.message === OCR_BUSY,
  );
});

test("OCR: a 422 answers the fixed failure message", async () => {
  setOcrConfiguredForTests(() => true);
  setOcrTransportForTests(
    recordingTransport(async (route) => {
      if (route.includes("/ocr?")) throw new SandboxHttpError(422, { error: "unsupported input" });
      return ok();
    }),
  );
  await assert.rejects(
    ocrExtract({ userId: "user-1", sourceId: "source-1", kind: "image", data: input() }),
    (error: unknown) => error instanceof OcrFailedError && error.message === OCR_FAILED,
  );
});

test("OCR: a response over 4 MiB is refused", async () => {
  setOcrConfiguredForTests(() => true);
  setOcrTransportForTests(
    recordingTransport(async (route) => {
      if (route.includes("/ocr?")) return new Response(new Uint8Array(4 * 1024 * 1024 + 1));
      return ok();
    }),
  );
  await assert.rejects(
    ocrExtract({ userId: "user-1", sourceId: "source-1", kind: "image", data: input() }),
    (error: unknown) => error instanceof OcrFailedError && error.message === "The OCR result was too large.",
  );
});

// --- Capabilities --------------------------------------------------------------------------------------

const probeResult = (state: "up" | "degraded" | "down", reasonKey: "ok" | "cpuFallback" | "refuses"): ProbeFn => async () => ({
  results: { sandbox: { state, reasonKey, ...(state === "down" ? { fixKey: "startSandbox" as const } : {}) } },
});

test("Capabilities: an unconfigured sandbox is reported without probing", async () => {
  let probed = 0;
  const probe: ProbeFn = async (signal) => {
    probed++;
    return probeResult("up", "ok")(signal);
  };
  setServiceProbeForTests("sandbox", probe);
  setOcrConfiguredForTests(() => false);

  assert.deepEqual(await knowledgeCapabilities(), { ocr: { available: false, reason: "not_configured" } });
  assert.equal(probed, 0);
});

test("Capabilities: an up sandbox is available", async () => {
  setServiceProbeForTests("sandbox", probeResult("up", "ok"));
  setOcrConfiguredForTests(() => true);
  assert.deepEqual(await knowledgeCapabilities(), { ocr: { available: true, reason: "ok" } });
});

test("Capabilities: a degraded sandbox stays available", async () => {
  setServiceProbeForTests("sandbox", probeResult("degraded", "cpuFallback"));
  setOcrConfiguredForTests(() => true);
  assert.deepEqual(await knowledgeCapabilities(), { ocr: { available: true, reason: "ok" } });
});

test("Capabilities: a down sandbox is unavailable", async () => {
  setServiceProbeForTests("sandbox", probeResult("down", "refuses"));
  setOcrConfiguredForTests(() => true);
  assert.deepEqual(await knowledgeCapabilities(), { ocr: { available: false, reason: "unavailable" } });
});
