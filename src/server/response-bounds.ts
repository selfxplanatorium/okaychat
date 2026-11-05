// Bounded provider transports for the external API (docs/implementation/api-access.md). The app's own
// chat paths leave these unset, so their behaviour is unchanged. This wrapper sits between the retrying
// fetch and the provider parser: it counts decompressed bytes as they arrive, bounds the longest SSE or
// NDJSON record without buffering it, and cancels the underlying reader on overflow or abort.

export class ResponseLimitError extends Error {
  constructor(message = "The provider response exceeded the allowed size.") {
    super(message);
    this.name = "ResponseLimitError";
  }
}

export interface ResponseBounds {
  maxBytes: number;
  maxRecordBytes: number;
}

function boundedBody(body: ReadableStream<Uint8Array>, bounds: ResponseBounds): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  let record = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > bounds.maxBytes) throw new ResponseLimitError();
        for (let index = 0; index < value.byteLength; index++) {
          if (value[index] === 0x0a) record = 0;
          else if (++record > bounds.maxRecordBytes) throw new ResponseLimitError("The provider sent an oversized event record.");
        }
        controller.enqueue(value);
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** Wraps a fetch so every successful response body is byte- and record-bounded for this request only. */
export function withResponseBounds(base: typeof fetch, bounds: ResponseBounds): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (!response.body) return response;
    return new Response(boundedBody(response.body, bounds), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
