import dns from "node:dns/promises";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { FRAME_NETWORK_HOSTS } from "../shared/artifact-frame.js";
import { BlockedAddressError, publicAddress } from "../server/public-fetch.js";

// Every connection the browser worker's Chromium and Scrapling make goes through this proxy, so every hop they
// take, redirects and page subresources included, gets the same public-address check as publicFetch. The
// address that was checked is the one connected to, so DNS rebinding cannot slip past.
//
// In the container the proxy is the only process allowed out (docker/browser-firewall.sh), and it tells its
// clients apart by the uid that owns the connecting socket, read from /proc/net/tcp. The kernel sets that uid,
// so a compromised browser cannot claim another identity:
// - the Scrapling user may reach any public address (web_fetch fallback);
// - the renderer user may reach only the artifact CDNs (FRAME_NETWORK_HOSTS), for HTML and React previews;
// - anyone else is refused.
// Outside the container (dev) every client gets the public policy, as before the worker existed.

export type EgressPolicy = "public" | "cdn";

export class PolicyError extends Error {}

/** Maps a loopback client to its policy, or null to refuse it. */
export type Identify = (socket: net.Socket) => Promise<EgressPolicy | null>;

async function vetted(host: string): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (!publicAddress(bare)) throw new BlockedAddressError();
    return { address: bare, family: net.isIP(bare) };
  }
  const addresses = await dns.lookup(bare, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new BlockedAddressError();
  return addresses[0]!;
}

function allowed(policy: EgressPolicy, host: string, port: number) {
  if (policy === "public") return true;
  return FRAME_NETWORK_HOSTS.includes(host.toLowerCase()) && (port === 443 || port === 80);
}

const IDLE_MS = 120_000;

function forward(identify: Identify, req: http.IncomingMessage, res: http.ServerResponse) {
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    return res.writeHead(400).end();
  }
  if (target.protocol !== "http:") return res.writeHead(400).end();
  const port = Number(target.port || 80);
  identify(req.socket)
    .then((policy) => {
      if (!policy || !allowed(policy, target.hostname, port)) throw new PolicyError();
      return vetted(target.hostname);
    })
    .then(({ address, family }) => {
      const headers = { ...req.headers };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      const upstream = http.request(
        { host: address, family, port, method: req.method, path: `${target.pathname}${target.search}`, headers, timeout: IDLE_MS },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.rawHeaders);
          response.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    }, (error) => res.writeHead(403).end(error instanceof PolicyError ? "This destination is not allowed for this client." : "Only public internet addresses are allowed."));
}

function tunnel(identify: Identify, req: http.IncomingMessage, client: net.Socket, head: Buffer) {
  let target: URL;
  try {
    target = new URL(`http://${req.url}`);
  } catch {
    return client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
  client.on("error", () => client.destroy());
  client.setTimeout(IDLE_MS, () => client.destroy());
  const port = Number(target.port || 443);
  identify(client)
    .then((policy) => {
      if (!policy || !allowed(policy, target.hostname, port)) throw new PolicyError();
      return vetted(target.hostname);
    })
    .then(({ address }) => {
      const upstream = net.connect(port, address, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.setTimeout(IDLE_MS, () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    }, () => client.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
}

export function createEgressProxy(identify: Identify): http.Server {
  const server = http.createServer((req, res) => forward(identify, req, res));
  server.on("connect", (req, socket, head) => tunnel(identify, req, socket as net.Socket, head));
  return server;
}

/** `0100007F:1F90` in /proc/net/tcp is 127.0.0.1:8080. */
const procAddress = (address: string, port: number) =>
  `${address.split(".").map((part) => Number(part).toString(16).padStart(2, "0").toUpperCase()).reverse().join("")}:${port.toString(16).padStart(4, "0").toUpperCase()}`;

/** The uid owning the other end of a loopback TCP connection, from the kernel's socket table. */
export async function peerUid(socket: net.Socket): Promise<number | null> {
  if (!socket.remoteAddress || !socket.remotePort || !socket.localAddress || !socket.localPort) return null;
  const peer = procAddress(socket.remoteAddress.replace(/^::ffff:/, ""), socket.remotePort);
  const local = procAddress(socket.localAddress.replace(/^::ffff:/, ""), socket.localPort);
  const table = await readFile("/proc/net/tcp", "utf8").catch(() => "");
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
    if (fields[1] === peer && fields[2] === local) return Number(fields[7]);
  }
  return null;
}

/** Policy by socket owner, for the container where Scrapling and the renderer run as their own users. */
export function uidPolicy(uids: Record<number, EgressPolicy>): Identify {
  return async (socket) => {
    const uid = await peerUid(socket);
    return uid === null ? null : (uids[uid] ?? null);
  };
}

let started: Promise<string> | null = null;

/** Dev only: a loopback proxy in this process, started on first use, giving every client the public policy. */
export function localEgressProxy(): Promise<string> {
  started ??= new Promise<string>((resolve, reject) => {
    const server = createEgressProxy(async () => "public");
    server.on("error", (error) => {
      started = null;
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    server.unref();
  });
  return started;
}
