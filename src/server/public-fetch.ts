import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { pipeline, Readable } from "node:stream";
import zlib from "node:zlib";

/** Only addresses on the public internet: no loopback, private, link-local, CGNAT, multicast, or documentation ranges. */
export function publicAddress(address: string): boolean {
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

export class BlockedAddressError extends Error {
  constructor(message = "Only public internet addresses are allowed.") {
    super(message);
    this.name = "BlockedAddressError";
  }
}

const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

/**
 * Resolves the host and rejects it unless every address is public. For callers that cannot pin the
 * connection (Scrapling, save-time validation); a rebinding host can still change its answer later.
 */
export async function assertPublicHost(url: URL, message?: string): Promise<void> {
  const host = bareHost(url);
  if (isIP(host)) {
    if (!publicAddress(host)) throw new BlockedAddressError(message);
    return;
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length) throw new Error(`Could not resolve ${host}.`);
  if (addresses.some(({ address }) => !publicAddress(address))) throw new BlockedAddressError(message);
}

/**
 * One HTTP request whose DNS answer is checked at connection time. Validating a hostname before a
 * normal fetch leaves a rebinding hole; this pins the connection to the address that was checked.
 */
export function pinnedRequest(
  target: URL,
  opts: { method?: string; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal; blocked?: string },
): Promise<http.IncomingMessage> {
  if (target.protocol !== "https:" && target.protocol !== "http:") return Promise.reject(new Error("Only http and https URLs are allowed."));
  const host = bareHost(target);
  // Node skips lookup for literal addresses, so validate those here as well.
  if (isIP(host) && !publicAddress(host)) return Promise.reject(new BlockedAddressError(opts.blocked));
  return new Promise((resolve, reject) => {
    const request = (target.protocol === "https:" ? https : http).request(target, {
      method: opts.method ?? "GET",
      agent: false,
      signal: opts.signal,
      headers: opts.headers,
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
          if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
            callback(new BlockedAddressError(opts.blocked), "", 4);
          } else if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        }, () => callback(new Error(`Could not resolve ${hostname}.`), "", 4));
      },
    }, resolve);
    request.on("error", reject);
    request.end(opts.body);
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function decoded(response: http.IncomingMessage): Readable {
  const decoder = (() => {
    switch (response.headers["content-encoding"]?.trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return zlib.createGunzip();
      case "deflate":
        return zlib.createInflate();
      case "br":
        return zlib.createBrotliDecompress();
      default:
        return null;
    }
  })();
  if (!decoder) return response;
  // pipeline, not pipe: a dropped connection errors the body, and cancelling the body closes the socket.
  pipeline(response, decoder, () => {});
  return decoder;
}

/** Headers that may follow a redirect to another origin; anything else may carry a credential. */
const CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "content-type", "content-length", "user-agent"]);

/**
 * Drop-in `fetch` for URLs a user or model chose. Every hop, redirects included, must resolve to a
 * public address, and credentials are dropped when a redirect leaves the origin.
 */
export const publicFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  let body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  let method = request.method;
  let target = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  for (let hop = 0; hop <= 5; hop++) {
    const response = await pinnedRequest(target, { method, headers, body, signal: request.signal });
    const status = response.statusCode ?? 502;
    const location = response.headers.location;
    if (REDIRECTS.has(status) && location && request.redirect !== "manual") {
      response.destroy();
      if (request.redirect === "error") throw new TypeError(`Redirect to ${location} was not allowed.`);
      if (hop === 5) break;
      const next = new URL(location, target);
      if (next.origin !== target.origin) {
        // Provider keys also travel as x-api-key, x-goog-api-key, or custom headers, not only Authorization.
        for (const name of Object.keys(headers)) if (!CROSS_ORIGIN_HEADERS.has(name)) delete headers[name];
      }
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
        delete headers["content-length"];
      }
      target = next;
      continue;
    }
    const responseHeaders = new Headers();
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      const name = response.rawHeaders[i]!.toLowerCase();
      // The body below is already decompressed.
      if (name === "content-encoding" || (name === "content-length" && response.headers["content-encoding"])) continue;
      responseHeaders.append(name, response.rawHeaders[i + 1]!);
    }
    const empty = method === "HEAD" || status === 204 || status === 304;
    if (empty) response.resume();
    const result = new Response(empty ? null : (Readable.toWeb(decoded(response)) as ReadableStream<Uint8Array>), {
      status,
      statusText: response.statusMessage,
      headers: responseHeaders,
    });
    Object.defineProperty(result, "url", { value: target.href });
    Object.defineProperty(result, "redirected", { value: hop > 0 });
    return result;
  }
  throw new TypeError("Too many redirects.");
};

/** Reads at most `max` bytes of a response body, or throws. Content-Length is advisory and may be missing. */
export async function readCapped(response: Response, max: number, message: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(message);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
