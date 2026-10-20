import { mkdirSync } from "node:fs";
import path from "node:path";

const secret = process.env.OKAYCHAT_SECRET ?? "";
if (secret.length < 32) {
  throw new Error("OKAYCHAT_SECRET must be set to at least 32 characters (openssl rand -base64 32)");
}

const dataDir = path.resolve(process.env.OKAYCHAT_DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true });

export const env = {
  secret,
  dataDir,
  port: Number(process.env.PORT ?? 8787),
  // Docker needs all interfaces. Dev sets 127.0.0.1 so only the Vite proxy reaches the API.
  host: process.env.HOST ?? "0.0.0.0",
  allowSignup: process.env.OKAYCHAT_ALLOW_SIGNUP === "true",
  // Admins may add stdio MCP servers. They run as the server process, so other users never get this.
  production: process.env.NODE_ENV === "production",
  // Code sandbox container (sandbox/). run_code is offered only when both are set.
  sandboxUrl: (process.env.OKAYCHAT_SANDBOX_URL ?? "").replace(/\/+$/, ""),
  sandboxToken: process.env.OKAYCHAT_SANDBOX_TOKEN ?? "",
  version: "0.1.0",
};

export const USER_AGENT = `okaychat/${env.version}`;
