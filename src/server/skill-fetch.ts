import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

// Pin DNS at connection time: validating a hostname before a normal fetch leaves a rebinding hole.
export function publicSkillAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only global unicast IPv6; exclude mapped IPv4, local, multicast, and special 2001::/23 ranges.
  if (isIP(address) !== 6 || !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  const [first, second = "0"] = address.split(":");
  return !(first?.toLowerCase() === "2001" && (parseInt(second || "0", 16) < 0x200 || parseInt(second, 16) === 0xdb8)) &&
    first?.toLowerCase() !== "2002" && !address.toLowerCase().startsWith("3fff:");
}

export function skillSourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Skill source URLs must be HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Use the encrypted token field instead of URL credentials.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Skill sources must use port 80 or 443.");
  return url;
}

export async function fetchSkillSource(value: string, token: string | null, signal?: AbortSignal): Promise<Response> {
  let target = skillSourceUrl(value);
  const deadline = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let authorization = target.protocol === "https:" ? token : null;
  for (let hop = 0; hop <= 5; hop++) {
    combined.throwIfAborted();
    const host = target.hostname.replace(/^\[|\]$/g, "");
    // Node skips lookup for literal addresses, so validate those here as well.
    if (isIP(host) && !publicSkillAddress(host)) throw new Error("Skill sources must use public internet addresses.");
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (target.protocol === "https:" ? https : http).request(target, {
        agent: false,
        signal: combined,
        headers: {
          "User-Agent": "okaychat",
          ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
          ...(host === "api.github.com" ? { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } : {}),
        },
        lookup: (hostname, options, callback) => {
          dns.lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
            if (!addresses.length || addresses.some(({ address }) => !publicSkillAddress(address))) {
              callback(new Error("Skill sources must use public internet addresses."), "", 4);
            } else {
              if (options.all) callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            }
          }, () => callback(new Error("Could not resolve skill source host."), "", 4));
        },
      }, resolve);
      request.on("error", () => reject(new Error(combined.aborted ? "Skill source request aborted or timed out." : "Could not fetch skill source from a public internet address.")));
      request.end();
    });
    const status = response.statusCode ?? 502;
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.destroy();
      if (!response.headers.location || hop === 5) throw new Error("Too many skill source redirects or missing redirect target.");
      const next = skillSourceUrl(new URL(response.headers.location, target).href);
      if (target.protocol === "https:" && next.protocol !== "https:") throw new Error("Skill source redirects cannot downgrade HTTPS.");
      if (next.origin !== target.origin) authorization = null;
      target = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`Skill source fetch failed (${status}).`);
    }
    const headers = new Headers();
    if (response.headers["content-length"]) headers.set("content-length", response.headers["content-length"]);
    return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers });
  }
  throw new Error("Too many skill source redirects.");
}
