import type { N8nAgentConfig } from '../../shared/n8n-agents.js';
import { AppError } from '../errors.js';
import { BlockedAddressError, publicFetch } from '../public-fetch.js';
import { headerNameAllowed, headerValueAllowed, validateConfig } from './schemas.js';

export interface AgentRequestOptions {
  signal?: AbortSignal;
  beforePost?: () => void;
  fetch?: typeof fetch;
}

/** One POST only. The response owns its deadline until EOF or cancellation. */
export async function agentRequest(config: N8nAgentConfig, body: string, options: AgentRequestOptions = {}): Promise<Response> {
  validateConfig(config);
  if (Buffer.byteLength(body) > 512 * 1024) throw new AppError({ code: 'validation' });
  if (config.authHeader && (!headerNameAllowed(config.authHeader.name) || !headerValueAllowed(config.authHeader.value))) throw new AppError({ code: 'validation' });
  const controller = new AbortController();
  const timeout = () => controller.abort(new AppError({ code: 'timeout', retryable: false, provider: 'n8n' }));
  const total = setTimeout(timeout, config.timeoutMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort(new AppError({ code: 'aborted', provider: 'n8n' }));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const cleanup = () => { clearTimeout(total); clearTimeout(idle); options.signal?.removeEventListener('abort', abort); };
  const mapped = (error: unknown): AppError => {
    if (controller.signal.aborted) return controller.signal.reason as AppError;
    if (error instanceof AppError) return error;
    return new AppError({ code: error instanceof BlockedAddressError ? 'forbidden' : 'network', retryable: false, provider: 'n8n' });
  };
  try {
    controller.signal.throwIfAborted();
    options.beforePost?.();
    const response = await (options.fetch ?? publicFetch)(config.webhookUrl, {
      method: 'POST', redirect: 'manual', signal: controller.signal, body,
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, text/event-stream, application/json, text/plain', 'User-Agent': 'okaychat', ...(config.authHeader ? { [config.authHeader.name]: config.authHeader.value } : {}) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      if (status >= 300 && status < 400) throw new AppError({ code: 'agent_response', agentReason: 'redirect' });
      if (status === 401 || status === 403) throw new AppError({ code: 'agent_auth' });
      if (status === 404 || status === 410) throw new AppError({ code: 'agent_response', agentReason: 'inactive' });
      if (status === 429) {
        const raw = response.headers.get('retry-after');
        const ms = raw ? (/^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : NaN;
        throw new AppError({ code: 'rate_limited', retryable: false, ...(Number.isFinite(ms) ? { retryAfterMs: Math.max(0, Math.min(3600000, ms)) } : {}) });
      }
      throw new AppError({ code: status === 408 || status === 504 ? 'timeout' : 'agent_failed', retryable: false });
    }
    if (!response.body) { cleanup(); return response; }
    const reader = response.body.getReader();
    let closed = false;
    const close = async () => { if (closed) return; closed = true; cleanup(); await reader.cancel().catch(() => {}); reader.releaseLock(); };
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(timeout, config.idleTimeoutMs); };
    resetIdle();
    const stream = new ReadableStream<Uint8Array>({
      async pull(sink) {
        try {
          controller.signal.throwIfAborted();
          const result = await reader.read();
          controller.signal.throwIfAborted();
          if (result.done) { await close(); sink.close(); }
          else { resetIdle(); sink.enqueue(result.value); }
        } catch (error) { await close(); sink.error(mapped(error)); }
      },
      async cancel() { controller.abort(new AppError({ code: 'aborted' })); await close(); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: response.status, headers: response.headers });
  } catch (error) { cleanup(); throw mapped(error); }
}
