import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";

// Tests only: the browser worker's HTTP API in the test process, on a random loopback port, so app code under
// test talks to it exactly as it talks to the container. Not used by the app or the image.

export interface TestWorker {
  /** False when Playwright's Chromium is not installed; rendering tests skip then. */
  available: boolean;
  close(): Promise<void>;
}

export async function startTestWorker(): Promise<TestWorker> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "okaychat-browser-test-"));
  const tokenFile = path.join(dir, "token");
  writeFileSync(tokenFile, randomBytes(32).toString("base64url"));
  process.env.BROWSER_TOKEN_FILE = tokenFile;
  process.env.OKAYCHAT_BROWSER_TOKEN_FILE = tokenFile;
  const { createWorker } = await import("./server.js");
  const { closeRenderer, executablePath } = await import("./render.js");
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: createWorker().fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  process.env.OKAYCHAT_BROWSER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const executable = executablePath();
  return {
    available: !!executable && existsSync(executable),
    close: async () => {
      await closeRenderer();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
