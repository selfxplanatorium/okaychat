/// <reference types="node" />
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  HelperError,
  browserCommand,
  canonicalLaunchOrigin,
  hostMatches,
  inspectCallback,
  isConfirmed,
  listenLoopback,
  nodeMajor,
  parseLaunch,
  readLaunchFile,
  validatePrepare,
} from "./chatgpt-connect.mjs";

const now = 1_800_000_000_000;
const state = "s".repeat(43);
const capability = "c".repeat(43);
const launch = (patch = {}) => ({
  version: 1,
  publicOrigin: "https://chat.example.com:8443",
  attemptId: "cgl_abcdefghijklmnop",
  helperCapability: capability,
  expiresAt: now + 10 * 60_000,
  ...patch,
});
const encode = (value) => JSON.stringify(value);
const rejects = (fn, kind) => {
  let error;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof HelperError, "expected a HelperError");
  if (kind) assert.equal(error.kind, kind);
};

test("launch files are parsed strictly and preserve the pinned origin", () => {
  const parsed = parseLaunch(encode(launch()), now);
  assert.equal(parsed.publicOrigin, "https://chat.example.com:8443");
  assert.equal(parsed.attemptId, "cgl_abcdefghijklmnop");
  assert.equal(parsed.expiresAt, now + 10 * 60_000);

  assert.equal(canonicalLaunchOrigin("https://chat.example.com/"), "https://chat.example.com");
  assert.equal(canonicalLaunchOrigin("https://chat.example.com:8443"), "https://chat.example.com:8443");
  rejects(() => canonicalLaunchOrigin("http://chat.example.com"), "invalid");
  rejects(() => canonicalLaunchOrigin("https://user:pass@chat.example.com"), "invalid");
  rejects(() => canonicalLaunchOrigin("https://chat.example.com/subpath"), "invalid");
  rejects(() => canonicalLaunchOrigin("https://chat.example.com/?a=1"), "invalid");
  rejects(() => canonicalLaunchOrigin("https://chat.example.com/#frag"), "invalid");
});

test("launch files reject wrong versions, unknown fields, bad ids and expiry", () => {
  rejects(() => parseLaunch(encode(launch({ version: 2 })), now), "invalid");
  rejects(() => parseLaunch(encode({ ...launch(), authorizationEndpoint: "https://evil.example" }), now), "invalid");
  rejects(() => parseLaunch(encode(launch({ attemptId: "bad id" })), now), "invalid");
  rejects(() => parseLaunch(encode(launch({ helperCapability: "short" })), now), "invalid");
  rejects(() => parseLaunch(encode(launch({ expiresAt: now })), now), "expired");
  rejects(() => parseLaunch(encode(launch({ expiresAt: now + 2 * 60 * 60_000 })), now), "invalid");
  rejects(() => parseLaunch("not json", now), "invalid");
  rejects(() => parseLaunch("[]", now), "invalid");
  rejects(() => parseLaunch("null", now), "invalid");
  rejects(() => parseLaunch("x".repeat(20 * 1024), now), "invalid");
});

const dir = mkdtempSync(join(tmpdir(), "okaychat-chatgpt-helper-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the launch file is deleted as soon as it has been read", () => {
  const path = join(dir, "launch.json");
  writeFileSync(path, encode(launch()), { mode: 0o600 });
  let mode = 0;
  const text = readLaunchFile(path, { onRead: (stat) => (mode = stat.mode & 0o777) });
  assert.equal(text, encode(launch()));
  assert.equal(existsSync(path), false);
  assert.equal(mode, 0o600);
  rejects(() => readLaunchFile(path), "invalid");
  rejects(() => readLaunchFile(dir), "invalid");
});

test("the callback listener only accepts the exact host and path", () => {
  assert.equal(hostMatches("127.0.0.1:5555", 5555), true);
  assert.equal(hostMatches("localhost:5555", 5555), false);
  assert.equal(hostMatches("[::1]:5555", 5555), false);
  assert.equal(hostMatches("127.0.0.1:5556", 5555), false);
  assert.equal(hostMatches(undefined, 5555), false);

  assert.equal(inspectCallback("/favicon.ico", { port: 5555, state }).kind, "not_callback");
  assert.equal(inspectCallback("/auth/callback", { port: 5555, state }).kind, "empty");
  assert.equal(inspectCallback("/callback?code=a&state=" + state, { port: 5555, state }).kind, "not_callback");
  assert.equal(inspectCallback("/auth/callback/extra?code=a&state=" + state, { port: 5555, state }).kind, "not_callback");
  assert.equal(inspectCallback("/auth/callback?code=a&state=" + state + "#frag", { port: 5555, state }).kind, "invalid");
  assert.equal(inspectCallback("/auth/callback?code=a&state=" + state + "&code=b", { port: 5555, state }).kind, "invalid");
  assert.equal(inspectCallback("/auth/callback?code=a&error=denied&state=" + state, { port: 5555, state }).kind, "invalid");
  assert.equal(inspectCallback(`/auth/callback?code=${"%E0%A4%A"}&state=${state}`, { port: 5555, state }).kind, "invalid");
  assert.equal(inspectCallback("/auth/callback?code=a", { port: 5555, state }).kind, "state_mismatch");
  assert.equal(inspectCallback("/auth/callback?code=a&state=" + "x".repeat(43), { port: 5555, state }).kind, "state_mismatch");
  assert.equal(inspectCallback("/auth/callback?code=a&state=" + state + "&" + "x=" + "y".repeat(9 * 1024), { port: 5555, state }).kind, "invalid");
});

test("a valid callback keeps its raw query and uses the loopback origin", () => {
  const result = inspectCallback(`/auth/callback?code=abc&state=${state}&scope=openid`, { port: 5555, state });
  assert.equal(result.kind, "callback");
  assert.equal(result.callbackUrl, `http://127.0.0.1:5555/auth/callback?code=abc&state=${state}&scope=openid`);

  const denied = inspectCallback(`/auth/callback?error=access_denied&state=${state}`, { port: 5555, state });
  assert.equal(denied.kind, "callback");
  assert.match(denied.callbackUrl, /^http:\/\/127\.0\.0\.1:5555\/auth\/callback\?/);
});

test("the prepared authorization URL is pinned to the fixed endpoint and loopback callback", () => {
  const authorization = (patch = {}) => {
    const url = new URL("https://auth.openai.com/api/accounts/authorize");
    const params = {
      client_id: "issued-client",
      response_type: "code",
      redirect_uri: "http://127.0.0.1:5555/auth/callback",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      state,
      nonce: "n".repeat(43),
      code_challenge: "p".repeat(43),
      code_challenge_method: "S256",
      ...patch,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { authorizationUrl: url.toString(), expiresAt: now + 5 * 60_000 };
  };

  const parsed = validatePrepare(authorization(), { port: 5555, now });
  assert.equal(parsed.state, state);
  assert.equal(parsed.redirectUri, "http://127.0.0.1:5555/auth/callback");

  const withDuplicate = new URL(authorization().authorizationUrl);
  withDuplicate.searchParams.append("state", "t".repeat(43));
  rejects(() => validatePrepare({ authorizationUrl: withDuplicate.toString(), expiresAt: now + 60_000 }, { port: 5555, now }), "invalid");
  rejects(() => validatePrepare(authorization({ redirect_uri: "http://localhost:5555/auth/callback" }), { port: 5555, now }), "invalid");
  rejects(() => validatePrepare(authorization({ redirect_uri: "http://127.0.0.1:5556/auth/callback" }), { port: 5555, now }), "invalid");
  rejects(() => validatePrepare(authorization({ redirect_uri: "http://127.0.0.1:5555/callback" }), { port: 5555, now }), "invalid");
  rejects(() => validatePrepare(authorization({ code_challenge_method: "plain" }), { port: 5555, now }), "invalid");
  rejects(() => validatePrepare(authorization({ code_challenge: "" }), { port: 5555, now }), "invalid");
  rejects(() => validatePrepare(authorization({ resource: "https://api.openai.com/v2" }), { port: 5555, now }), "invalid");
  rejects(() => validatePrepare(authorization({ scope: "openid profile" }), { port: 5555, now }), "invalid");
  rejects(() => validatePrepare(authorization({ response_type: "token" }), { port: 5555, now }), "invalid");
  rejects(() => validatePrepare({ ...authorization(), authorizationUrl: authorization().authorizationUrl.replace("https://auth.openai.com", "https://evil.example") }, { port: 5555, now }), "invalid");
  rejects(() => validatePrepare({ ...authorization(), authorizationUrl: authorization().authorizationUrl.replace("/api/accounts/authorize", "/api/accounts/other") }, { port: 5555, now }), "invalid");
  rejects(() => validatePrepare({ ...authorization(), expiresAt: now }, { port: 5555, now }), "expired");
  rejects(() => validatePrepare({ ...authorization(), expiresAt: now + 2 * 60 * 60_000 }, { port: 5555, now }), "invalid");
  rejects(() => validatePrepare(null, { port: 5555, now }), "invalid");
});

test("the browser is opened with an argument vector, never a shell string", () => {
  const url = "https://auth.openai.com/api/accounts/authorize?state=1";
  assert.deepEqual(browserCommand(url, "linux"), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserCommand(url, "win32"), { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
  for (const platform of ["linux", "darwin", "win32"]) {
    const command = browserCommand(url, platform);
    assert.equal("shell" in command, false);
    assert.equal(command.args.at(-1), url);
  }
});

test("terminal confirmation and the Node version check", () => {
  assert.equal(isConfirmed("yes"), true);
  assert.equal(isConfirmed(" YES "), true);
  assert.equal(isConfirmed("y"), true);
  assert.equal(isConfirmed("no"), false);
  assert.equal(isConfirmed(""), false);
  assert.equal(nodeMajor("22.13.0"), 22);
  assert.equal(nodeMajor("24.1.0"), 24);
  assert.equal(nodeMajor("not-a-version"), 0);
});

test("the loopback listener binds 127.0.0.1 and picks a free port", async () => {
  const first = await listenLoopback();
  const second = await listenLoopback();
  try {
    assert.equal(first.address, "127.0.0.1");
    assert.equal(second.address, "127.0.0.1");
    assert.ok(first.port >= 1024);
    assert.notEqual(first.port, second.port);
  } finally {
    first.server.close();
    second.server.close();
  }
});
