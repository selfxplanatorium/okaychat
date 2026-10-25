import { createEgressProxy, uidPolicy } from "./egress-proxy.js";

// Container only: the egress proxy as its own process and user, the only one the firewall lets out. Clients are
// told apart by the uid owning their socket (see egress-proxy.ts). docker/browser-entrypoint.sh starts it.

const port = Number(process.env.EGRESS_PORT ?? 3128);
const scrape = Number(process.env.SCRAPE_UID);
const slots = (process.env.SLOT_UIDS ?? "").trim().split(/\s+/).map(Number);
if (!Number.isInteger(scrape) || !slots.length || !slots.every(Number.isInteger)) throw new Error("SCRAPE_UID and SLOT_UIDS must be set");

// Render slots get the CDN policy, Scrapling the public one; the job API and everyone else get nothing.
createEgressProxy(uidPolicy({ [scrape]: "public", ...Object.fromEntries(slots.map((uid) => [uid, "cdn" as const])) })).listen(port, "127.0.0.1", () => {
  console.log(`okaychat egress proxy on 127.0.0.1:${port}`);
});
