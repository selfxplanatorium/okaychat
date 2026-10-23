import dns from "node:dns/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { BlockedAddressError, publicAddress } from "./public-fetch.js";

// Tools that make their own connections (Scrapling's HTTP client and browser) go through this proxy, so
// every hop they take, redirects and page subresources included, gets the same public-address check as
// publicFetch. The address that was checked is the one connected to, so DNS rebinding cannot slip past.

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

function forward(req: http.IncomingMessage, res: http.ServerResponse) {
  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    return res.writeHead(400).end();
  }
  if (target.protocol !== "http:") return res.writeHead(400).end();
  vetted(target.hostname).then(({ address, family }) => {
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      { host: address, family, port: Number(target.port || 80), method: req.method, path: `${target.pathname}${target.search}`, headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.rawHeaders);
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  }, () => res.writeHead(403).end("Only public internet addresses are allowed."));
}

function tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer) {
  let target: URL;
  try {
    target = new URL(`http://${req.url}`);
  } catch {
    return client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
  client.on("error", () => client.destroy());
  vetted(target.hostname).then(({ address }) => {
    const upstream = net.connect(Number(target.port || 443), address, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  }, () => client.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
}

let started: Promise<string> | null = null;

/** URL of the loopback proxy, started on first use. It only reaches public addresses, so other local processes gain nothing from it. */
export function egressProxyUrl(): Promise<string> {
  started ??= new Promise<string>((resolve, reject) => {
    const server = http.createServer(forward);
    server.on("connect", tunnel);
    server.on("error", (error) => {
      started = null;
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    server.unref();
  });
  return started;
}
