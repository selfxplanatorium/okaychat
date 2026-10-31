import { parseErrorWire, type ErrorWire } from "@shared/errors";
import { t, type PlainMessageKey } from "@/i18n";
import { ApiError } from "@/lib/api";
import { presentError } from "@/lib/error-presentation";

const wireOf = (error: ApiError): ErrorWire => ({
  code: error.code,
  message: error.message,
  ...(error.hint ? { hint: error.hint } : {}),
  retryable: error.retryable,
  ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  ...(error.ref ? { ref: error.ref } : {}),
  ...(error.model ? { model: error.model } : {}),
  ...(error.provider ? { provider: error.provider } : {}),
  ...(error.requestId ? { requestId: error.requestId } : {}),
});

/**
 * Inline settings/upload text: a translated code message plus the server's safe, specific field
 * message when it has one. An arbitrary thrown value keeps the area's own fallback sentence: its
 * message is JS text that can carry a URL, a prompt, or a key.
 */
export function errorText(cause: unknown, fallback: PlainMessageKey): string {
  const wire = cause instanceof ApiError ? wireOf(cause) : parseErrorWire(cause);
  if (!wire) return t(fallback);
  const presentation = presentError(wire, "settings");
  const message = t(presentation.messageKey);
  return presentation.detail && presentation.detail !== message ? `${message} ${presentation.detail}` : message;
}
