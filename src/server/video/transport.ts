import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { VIDEO_LIMITS, videoService, type VideoServiceId } from '../../shared/video.js';
import { pinnedRequest, readCapped } from '../public-fetch.js';
import { VideoError } from './errors.js';

export type VideoFetch = typeof fetch;
export async function videoJson(service: VideoServiceId, path: string, key: string, method: 'GET'|'POST', body: unknown, signal: AbortSignal | undefined, transport: VideoFetch = fetch, cancel = false, expectedStatus = 200): Promise<unknown> {
  // Paths are server-owned; provider ids are independently validated before interpolation.
  if (!/^\/(videos\/(generations|[A-Za-z0-9_-]{1,200})|models\/google\/veo-3\.1-fast\/predictions|predictions\/[A-Za-z0-9_-]{1,200}(\/cancel)?)$/.test(path)) throw new VideoError('provider_protocol');
  const submit = method === 'POST' && !cancel;
  const boundedSignal = AbortSignal.any([AbortSignal.timeout(cancel ? 10_000 : submit ? 30_000 : 15_000),...(signal ? [signal] : [])]);
  let response: Response;
  try {
    response = await transport(videoService(service).baseURL + path, {method,redirect:'error',signal:boundedSignal,headers:{Authorization:`Bearer ${key}`,...(body !== undefined ? {'Content-Type':'application/json'} : {})},...(body !== undefined ? {body:JSON.stringify(body)} : {})});
  } catch {
    throw new VideoError('provider_unavailable',503,submit ? 'unknown':'none');
  }
  if (!response.ok) {
    // A gateway error or timeout after a POST does not prove the provider refused (and did not bill) it.
    await response.body?.cancel();
    const status = response.status;
    const retry = response.headers.get('retry-after');
    const retryAfterMs = retry && /^\d+$/.test(retry) ? Math.min(30_000,Number(retry)*1000) : null;
    throw new VideoError(status === 401 || status === 403 ? 'provider_auth' : status === 429 ? 'provider_rate_limit' : status === 404 ? 'provider_output_expired' : status >= 500 ? 'provider_unavailable':'provider_rejected',status,submit ? (status >= 500 || status === 408 ? 'unknown':'rejected'):'none',retryAfterMs);
  }
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    throw new VideoError('provider_protocol',502,submit ? 'unknown':'none');
  }
  try {
    const bytes = await readCapped(response,VIDEO_LIMITS.jsonBytes,'bounded video JSON');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  } catch {
    await response.body?.cancel().catch(() => {});
    throw new VideoError('provider_protocol',502,submit ? 'unknown':'none');
  }
}

const approved = new WeakMap<object, URL>();
declare const descriptorBrand: unique symbol;
export interface VideoDownloadDescriptor { readonly [descriptorBrand]: true }
export function downloadDescriptor(service: VideoServiceId, value: unknown): VideoDownloadDescriptor {
  if (typeof value !== 'string' || value.length > 8192) throw new VideoError('output_host_rejected');
  let url: URL;
  try { url = new URL(value); } catch { throw new VideoError('output_host_rejected'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
    !(service === 'xai' ? host === 'vidgen.x.ai' : host === 'replicate.delivery' || host.endsWith('.replicate.delivery'))) throw new VideoError('output_host_rejected');
  const descriptor = Object.freeze({}) as VideoDownloadDescriptor;
  approved.set(descriptor,url);
  return descriptor;
}
/** No redirects, bearer headers, arbitrary destination, or full-file buffering. Caller owns the private staging directory. */
export async function downloadVideo(descriptor: VideoDownloadDescriptor, file: string, signal?: AbortSignal, request: typeof pinnedRequest = pinnedRequest): Promise<{size:number;sha256:string}> {
  const url = approved.get(descriptor);
  if (!url) throw new VideoError('output_host_rejected');
  const boundedSignal = AbortSignal.any([AbortSignal.timeout(60_000),...(signal ? [signal] : [])]);
  let stream: Readable | undefined;
  let created = false;
  try {
    const response = await request(url,{signal:boundedSignal});
    stream = response;
    if (response.statusCode !== 200) throw new VideoError(response.statusCode === 404 || response.statusCode === 410 ? 'provider_output_expired':'download_failed');
    const length = response.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > VIDEO_LIMITS.outputBytes)) throw new VideoError('output_too_large',413);
    const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (contentType && !['video/mp4','application/octet-stream'].includes(contentType)) throw new VideoError('output_invalid',422);
    const encoding = response.headers['content-encoding']?.trim().toLowerCase();
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : null;
    if (encoding && encoding !== 'identity' && !decoder) throw new VideoError('download_failed');
    if (decoder) { pipeline(response,decoder,() => {}); stream = decoder; }
    const fd = await open(file,'wx',0o600);
    created = true;
    let size = 0;
    const hash = createHash('sha256');
    try {
      for await (const value of stream) {
        if (boundedSignal.aborted) throw new VideoError('download_failed');
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        size += chunk.length;
        if (size > VIDEO_LIMITS.outputBytes) throw new VideoError('output_too_large',413);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += (await fd.write(chunk,offset)).bytesWritten;
      }
      if (!size) throw new VideoError('output_invalid',422);
      await fd.sync();
      return {size,sha256:hash.digest('hex')};
    } finally { await fd.close(); }
  } catch (error) {
    if (created) await rm(file,{force:true});
    throw error instanceof VideoError ? error : new VideoError('download_failed');
  } finally { stream?.destroy(); }
}
export function providerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new VideoError('provider_protocol');
  return value;
}
export function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VideoError('provider_protocol');
  return value as Record<string,unknown>;
}
