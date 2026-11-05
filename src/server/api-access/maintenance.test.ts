import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "okaychat-api-maintenance-"));
process.env.OKAYCHAT_DATA_DIR = dataDir;
process.env.OKAYCHAT_SECRET = "api-maintenance-test-secret-not-for-production";
const { db } = await import("../db.js");
const { pruneApiMaintenance } = await import("./maintenance.js");

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("retention sweeps past the first batch of accounts on later ticks", () => {
  // 501 accounts: one more than a single sweep, so a fixed LIMIT without a cursor would starve the last.
  db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 501)
    INSERT INTO users (id, email, name, password_hash, role, created_at)
    SELECT printf('u%03d', x), printf('u%03d@example.test', x), 'U', 'unused', 'user', 1 FROM n`);
  db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 501)
    INSERT INTO api_rate_windows (user_id, key_id, window_start, used)
    SELECT printf('u%03d', x), 'k', 0, 1 FROM n`);
  const remaining = () => (db.prepare("SELECT COUNT(*) AS n FROM api_rate_windows").get() as { n: number }).n;
  pruneApiMaintenance();
  assert.equal(remaining(), 1, "the first tick prunes the first 500 accounts");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM api_rate_windows WHERE user_id = 'u501'").get() as { n: number }).n, 1);
  pruneApiMaintenance();
  assert.equal(remaining(), 0, "the next tick reaches the account past the first batch");
});
