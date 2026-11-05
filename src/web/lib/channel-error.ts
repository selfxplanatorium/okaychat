import { ApiError } from "@/lib/api";
import { t, type PlainMessageKey } from "@/i18n";

/**
 * Maps the safe wire error to channel-specific copy. Raw provider or database text is never shown;
 * the server's message is used only to disambiguate the authored conflict reasons.
 */
export function channelError(error: unknown, fallback: PlainMessageKey, options: { owner: boolean } = { owner: false }): string {
  if (!(error instanceof ApiError)) return t(fallback);
  switch (error.code) {
    case "storage_quota":
      return t(options.owner ? "channels.quotaOwner" : "channels.quotaMember");
    case "rate_limited":
      return t("channels.rateLimited", { seconds: Math.max(1, Math.ceil((error.retryAfterMs ?? 1000) / 1000)) });
    case "forbidden":
      return t("channels.accessLost");
    case "not_found":
      return t("channels.notFound");
    case "conflict":
    case "validation":
      if (/capacity|limit/i.test(error.message)) return t("channels.limitReached");
      if (/still being written|source/i.test(error.message)) return t("channels.sourceBusy");
      if (/already running|reply/i.test(error.message)) return t("channels.aiBusy");
      return t("channels.invalidMessage");
    default:
      return t(fallback);
  }
}
