// The suite must run on a clean checkout with no local .env. Tests that need storage create their own
// temporary data directory; this only supplies the encryption key that env.ts requires before any server
// module can load. It is imported by the test script, never by the application.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OKAYCHAT_SECRET ??= "okaychat-test-secret-not-for-production-32chars";
// Test files run in parallel processes. One that imports the database without choosing a directory
// must not migrate the shared ./data at the same time as another, so each process gets its own.
process.env.OKAYCHAT_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "okaychat-test-"));
