import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { AppError } from "../errors.js";
import { BlockedAddressError, publicFetch } from "../public-fetch.js";
import { parseAgentResponse } from "./parser.js";

// Section 11.8 of the n8n agents spec. Offline suites never reach this file's network path: the test
// runs only with both OKAYCHAT_N8N_LIVE=1 and OKAYCHAT_N8N_LIVE_URL, and there is no embedded default.
// It sends one message to the one known conversational workflow; it never prints the endpoint, body,
// header value, nonce, or remote answer, and it never mutates the workflow.

const MARKER = "OKAYCHAT_LIVE_OK";
const url = process.env.OKAYCHAT_N8N_LIVE_URL;
const enabled = process.env.OKAYCHAT_N8N_LIVE === "1";
const allowOfflineAuth = process.env.OKAYCHAT_N8N_LIVE_ALLOW_OFFLINE === "1";

const skipReason = !url
  ? "set OKAYCHAT_N8N_LIVE_URL to run the live n8n test"
  : !enabled
    ? "set OKAYCHAT_N8N_LIVE=1 to run the live n8n test"
    : false;

/** Maps a pre-response failure to a safe offline category, or null when it must fail the test. */
function offlineCategory(error: unknown, signal: AbortSignal): string | null {
  if (signal.aborted) {
    const name = (signal.reason as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
  }
  if (error instanceof BlockedAddressError) return null;
  const name = (error as { name?: string } | undefined)?.name ?? "";
  const code = (error as { code?: string } | undefined)?.code ?? "";
  const message = (error as { message?: string } | undefined)?.message ?? "";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") return "timeout";
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/.test(code)) return "dns";
  // publicFetch's DNS failure message names the host, so match the prefix and never log the message.
  if (message.startsWith("Could not resolve")) return "dns";
  if (message === "fetch failed") return "network";
  return null;
}

const skip = (t: TestContext, category: string) => t.skip(`live endpoint unreachable (${category})`);

test("the live n8n webhook answers the fixed marker over its streaming protocol", { skip: skipReason }, async (t) => {
  const signal = AbortSignal.timeout(30_000);
  const nonce = randomBytes(8).toString("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/x-ndjson, text/event-stream, application/json, text/plain",
  };
  const headerName = process.env.OKAYCHAT_N8N_LIVE_HEADER_NAME;
  const headerValue = process.env.OKAYCHAT_N8N_LIVE_HEADER_VALUE;
  if (headerName && headerValue) headers[headerName] = headerValue;

  const payload = JSON.stringify({
    message: `Reply with exactly ${MARKER}.`,
    history: JSON.stringify([
      { role: "user", content: `The nonce for this check is ${nonce}.` },
      { role: "assistant", content: "Recorded." },
    ]),
    sessionId: `okc_live_${nonce}`,
  });

  let response: Response;
  try {
    response = await publicFetch(url!, { method: "POST", redirect: "manual", headers, body: payload, signal });
  } catch (error) {
    if (error instanceof BlockedAddressError) assert.fail("the live endpoint is not a public address");
    const category = offlineCategory(error, signal);
    if (category) return skip(t, category);
    assert.fail("the live request failed before a response (unclassified)");
  }

  if (response.status === 502 || response.status === 503 || response.status === 504) {
    await response.body?.cancel();
    return skip(t, "proxy");
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    if (allowOfflineAuth) return skip(t, "auth");
    assert.fail(`the live endpoint returned ${response.status}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    // A 3xx is a protocol/configuration regression, not an offline condition.
    assert.fail(`the live endpoint returned ${response.status}`);
  }

  let mode: string | null = null;
  let text = "";
  try {
    for await (const event of parseAgentResponse(response, { mode: "auto", responsePointer: null, signal })) {
      if (event.type === "mode") mode = event.mode;
      if (event.type === "text") text += event.text;
    }
  } catch (error) {
    if (signal.aborted) return skip(t, "timeout");
    if (error instanceof AppError) assert.fail(`the live answer was rejected (${error.code}${error.agentReason ? `/${error.agentReason}` : ""})`);
    assert.fail("the live answer could not be parsed");
  }

  // The verified workflow is the streaming NDJSON endpoint; another mode is a protocol regression.
  assert.equal(mode, "ndjson", "the live workflow changed its response mode");
  if (text.trim() !== MARKER) assert.fail("the live workflow did not return the fixed marker");
});
