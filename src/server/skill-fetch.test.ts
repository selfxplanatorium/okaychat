import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fetchSkillSource, publicSkillAddress, skillSourceUrl } from "./skill-fetch.js";

test("skill sources reject private, loopback, link-local, tailnet, mapped, and reserved addresses", async () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.0.0.2", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.100.100.100", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) {
    assert.equal(publicSkillAddress(address), false, address);
  }
  assert.equal(publicSkillAddress("93.184.216.34"), true);
  assert.equal(publicSkillAddress("2606:4700:4700::1111"), true);
  for (const url of ["https://127.1/SKILL.md", "http://2130706433/SKILL.md", "https://[::ffff:127.0.0.1]/SKILL.md"]) {
    await assert.rejects(fetchSkillSource(url, null), /public internet/);
  }
  assert.throws(() => skillSourceUrl("https://user:secret@example.com/SKILL.md"), /encrypted token/);
  assert.throws(() => skillSourceUrl("http://example.com:22/SKILL.md"), /port/);
});

test("DNS is validated in the connection lookup, and mixed public/private answers are rejected", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]);
  t.mock.method(https, "request", (_url: unknown, options: any) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => options.lookup("mixed.example", { all: true }, (error: Error | null) => {
      assert.ok(error, "a private answer must never be handed to the socket");
      req.emit("error", error);
    });
    return req;
  });
  await assert.rejects(fetchSkillSource("https://mixed.example/SKILL.md", null), /public internet/);
});

test("redirects are revalidated, cross-origin bearer tokens are stripped, and sockets use vetted DNS answers", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const tokens: unknown[] = [];
  t.mock.method(https, "request", (url: URL, options: any, done: (response: unknown) => void) => {
    tokens.push(options.headers.Authorization);
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => options.lookup(url.hostname, { all: true }, (error: Error | null, addresses: unknown) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
      const response = Readable.from([Buffer.from("body")]);
      Object.assign(response, { statusCode: 302, headers: { location: tokens.length === 1 ? "https://second.example/SKILL.md" : "https://169.254.169.254/SKILL.md" } });
      done(response);
    });
    return req;
  });
  await assert.rejects(fetchSkillSource("https://first.example/SKILL.md", "secret-token"), /public internet/);
  assert.deepEqual(tokens, ["Bearer secret-token", undefined]);
});
