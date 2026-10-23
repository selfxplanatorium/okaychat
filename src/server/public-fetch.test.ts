import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http, { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-public-fetch-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "public-fetch-test-secret-only-not-for-production";
writeFileSync(path.join(dataDir, "models-dev.json"), JSON.stringify({ data: {}, fetchedAt: Date.now() }));
const { db } = await import("./db.js");
const { getConnection, saveConnection } = await import("./catalog/providers.js");
const { BlockedAddressError, publicFetch } = await import("./public-fetch.js");
const { webFetch } = await import("./tools/web.js");

const internal = createServer((_req, res) => res.end("internal secret"));
await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
const internalUrl = `http://127.0.0.1:${(internal.address() as AddressInfo).port}/`;
after(() => {
  internal.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("web_fetch cannot read loopback, private, or metadata addresses", async () => {
  for (const url of [internalUrl, "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.1/"]) {
    await assert.rejects(webFetch(url), /public internet/, url);
  }
});

test("publicFetch revalidates every redirect hop", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(http, "request", (_url: URL, options: any, done: (response: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => options.lookup("public.example", { all: true }, (error: Error | null) => {
      assert.equal(error, null);
      const response = Readable.from([]);
      Object.assign(response, { statusCode: 302, headers: { location: internalUrl }, rawHeaders: [] });
      done(response);
    });
    return req;
  });
  await assert.rejects(publicFetch("http://public.example/"), BlockedAddressError);
});

test("only admins' own base URLs skip the address check", () => {
  const insert = db.prepare("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'unused', ?, 1)");
  insert.run("admin", "admin@example.test", "Admin", "admin");
  insert.run("bob", "bob@example.test", "Bob", "user");
  for (const user of ["admin", "bob"]) saveConnection(user, "custom-local", { baseURL: internalUrl });
  saveConnection("bob", "openai", { apiKey: "sk-test" });
  assert.equal(getConnection("admin", "custom-local")?.guarded, undefined);
  assert.equal(getConnection("bob", "custom-local")?.guarded, true);
  // No base URL means the catalog's public endpoint, which needs no per-request check.
  assert.equal(getConnection("bob", "openai")?.guarded, undefined);
});
