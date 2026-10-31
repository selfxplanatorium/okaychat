import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";

// The worker clients against a fake transport: an outage response must become the existing
// service_unavailable error and mark only the capability that job needed, while validation and
// cancellation stay ordinary failures. No real worker is contacted.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-service-clients-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "service-clients-test-secret-only-not-for-production";
process.env.OKAYCHAT_BROWSER_URL = "http://browser.test";
process.env.OKAYCHAT_BROWSER_TOKEN_FILE = path.join(dataDir, "browser-token");
process.env.OKAYCHAT_SPEECH_URL = "http://speech.test";
process.env.OKAYCHAT_SPEECH_TOKEN_FILE = path.join(dataDir, "speech-token");

const { browserJob, BrowserJobError } = await import("./browser.js");
const { workerTranscribe } = await import("./speech/worker.js");
const { AppError } = await import("./errors.js");
const services = await import("./services.js");

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  services.resetServicesForTests();
});

const isServiceUnavailable = (error: unknown) => error instanceof AppError && error.code === "service_unavailable";
const fetchMock = (t: TestContext, handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  t.mock.method(globalThis, "fetch", handler);

test("a 503 from the browser worker is a service outage and marks only the used capability", async (t) => {
  fetchMock(t, async () => Response.json({ error: "The browser worker is busy; try again." }, { status: 503 }));
  await assert.rejects(browserJob("/v1/render", { kind: "pdf", html: "<p>x</p>" }, 1_000), isServiceUnavailable);
  assert.equal(services.serviceDown("browser"), true);
  assert.equal(services.serviceDown("scrapling"), false, "a render outage does not blame the fetch fallback");
});

test("a 422 is the worker answering, not an outage", async (t) => {
  fetchMock(t, async () => Response.json({ error: "Page 9 does not exist.", model: true }, { status: 422 }));
  await assert.rejects(browserJob("/v1/render", { kind: "pdf-page", file: "", page: 9 }, 1_000), (error: unknown) => {
    assert.ok(error instanceof BrowserJobError);
    assert.equal(error.forModel, true);
    return true;
  });
  assert.equal(services.serviceDown("browser"), false);
  assert.equal(services.serviceSnapshot("browser")?.state, "up", "the worker is reachable, so the failure is the job's");
});

test("a refused connection is transport-level and marks both browser capabilities down", async (t) => {
  fetchMock(t, async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(browserJob("/v1/fetch", { url: "https://example.test" }, 1_000), isServiceUnavailable);
  assert.equal(services.serviceDown("scrapling"), true);
  assert.equal(services.serviceDown("browser"), true, "the whole worker is unreachable, not just this route");
});

test("a cancelled browser job stays a cancellation", async (t) => {
  fetchMock(t, (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  const controller = new AbortController();
  const pending = browserJob("/v1/render", { kind: "pdf", html: "<p>x</p>" }, 5_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /Cancelled/);
  assert.equal(services.serviceDown("browser"), false, "cancellation is never an outage");
});

test("page reading needs Scrapling, not the renderer", async (t) => {
  let respond = async () => Response.json({ title: "Page", content: "Body" });
  fetchMock(t, () => respond());
  services.reportServiceFailure("browser");
  const page = await browserJob<{ title: string }>("/v1/fetch", { url: "https://example.test" }, 1_000);
  assert.equal(page.title, "Page");
  assert.equal(services.serviceDown("browser"), true, "a working fetch does not claim PDF rendering works");
  assert.equal(services.serviceDown("scrapling"), false);

  services.resetServicesForTests();
  respond = async () => Response.json({ error: "The worker is busy." }, { status: 503 });
  await assert.rejects(browserJob("/v1/fetch", { url: "https://example.test" }, 1_000), isServiceUnavailable);
  assert.equal(services.serviceDown("scrapling"), true);
  assert.equal(services.serviceDown("browser"), false, "a fetch outage does not remove view_artifact");
});

test("a speech 503 is a service outage; a validation failure is not", async (t) => {
  let respond = async () => Response.json({ error: "The local engine is busy." }, { status: 503 });
  fetchMock(t, () => respond());
  await assert.rejects(
    workerTranscribe(new Uint8Array([1, 2, 3]), { model: "tiny", vad: false, maxSeconds: 30 }),
    isServiceUnavailable,
  );
  assert.equal(services.serviceDown("speech"), true);

  services.resetServicesForTests();
  respond = async () => Response.json({ error: "The audio is too short." }, { status: 422 });
  await assert.rejects(workerTranscribe(new Uint8Array([1]), { model: "tiny", vad: false, maxSeconds: 30 }));
  assert.equal(services.serviceDown("speech"), false, "rejected audio says nothing about the worker's health");
});
