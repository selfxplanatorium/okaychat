import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-fonts-test-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "fonts-test-secret-only-not-for-production";
const { familyFromFilename, sniffFont } = await import("./fonts.js");

after(() => rmSync(dataDir, { recursive: true, force: true }));

const bytesOf = (tag: string) => new Uint8Array([...tag].map((c) => c.charCodeAt(0)));

test("sniffFont recognises each supported container by signature", () => {
  assert.equal(sniffFont(bytesOf("wOF2xxxx")), "font/woff2");
  assert.equal(sniffFont(bytesOf("wOFFxxxx")), "font/woff");
  assert.equal(sniffFont(bytesOf("OTTOxxxx")), "font/otf");
  assert.equal(sniffFont(bytesOf("truexxxx")), "font/ttf");
  assert.equal(sniffFont(new Uint8Array([0, 1, 0, 0, 0, 0])), "font/ttf");
});

test("sniffFont rejects anything else, including short input", () => {
  assert.equal(sniffFont(bytesOf("%PDF")), null);
  assert.equal(sniffFont(new Uint8Array([])), null);
  assert.equal(sniffFont(bytesOf("wOF")), null);
});

test("familyFromFilename drops the extension and CSS-breaking characters", () => {
  assert.equal(familyFromFilename("Inter_Display.woff2"), "Inter Display");
  assert.equal(familyFromFilename("My Font.TTF"), "My Font");
  assert.equal(familyFromFilename('evil"name;}.otf'), "evilname");
  assert.equal(familyFromFilename(".otf"), "");
});
