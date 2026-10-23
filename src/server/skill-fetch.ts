import { Readable } from "node:stream";
import { BlockedAddressError, pinnedRequest, publicAddress } from "./public-fetch.js";

export const publicSkillAddress = publicAddress;

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
    const response = await pinnedRequest(target, {
      signal: combined,
      blocked: "Skill sources must use public internet addresses.",
      headers: {
        "User-Agent": "okaychat",
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
        ...(host === "api.github.com" ? { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } : {}),
      },
    }).catch((error: unknown) => {
      if (error instanceof BlockedAddressError) throw error;
      throw new Error(combined.aborted ? "Skill source request aborted or timed out." : "Could not fetch skill source from a public internet address.");
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
