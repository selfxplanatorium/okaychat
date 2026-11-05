import { CopyIcon, TriangleAlertIcon } from "lucide-react";
import type { TestReview, ChatReview } from "@shared/custom-tools";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { RUN_ERROR_KEY, RUN_STATE_KEY } from "./custom-tool-keys";

/** Plain code only: no HTML, Markdown, links or remote images from a tool result. */
export function CustomToolReview({ review }: { review: TestReview | ChatReview }) {
  const warning = review.warning === "outbound_destructive" ? t("customTools.destructiveWarning") : t("customTools.outboundWarning");
  return (
    <div className="grid gap-2 rounded-lg border p-3 text-sm" data-slot="custom-tool-review">
      <div className="flex items-center gap-2">
        <TriangleAlertIcon className="text-warning size-4 shrink-0" aria-hidden />
        <span className="font-medium">{t("customTools.requestPreview")} · {t("customTools.reviewTitle")}</span>
      </div>
      <p className="text-muted-foreground text-xs">{warning}</p>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">{t("customTools.reviewDestination")}</span>
        <code className="bg-muted/50 rounded-md p-2 break-all whitespace-pre-wrap">{review.method} {review.url}</code>
      </label>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">{t("customTools.headers")}</span>
        <div className="bg-muted/50 grid gap-1 rounded-md p-2">
          {review.headers.map((header, index) => (
            <code key={`${header.name}-${index}`} className="break-all whitespace-pre-wrap">
              {header.name}: {header.secretName ? t("customTools.storedSecretLabel", { name: header.secretName }) : header.value}
            </code>
          ))}
        </div>
      </div>
      {review.body !== null && (
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">{t("customTools.reviewBody")}</span>
          <code className="bg-muted/50 max-h-72 overflow-auto rounded-md p-2 whitespace-pre-wrap">{review.body}</code>
        </label>
      )}
    </div>
  );
}

export function CustomToolRunResult({ run }: { run: import("@shared/custom-tools").RunView }) {
  const { copyToClipboard } = useCopyToClipboard();
  const text = run.result === null ? "" : JSON.stringify(run.result, null, 2);
  return (
    <div className="grid gap-2 rounded-lg border p-3 text-sm" data-slot="custom-tool-result">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">{t("customTools.status")}:</span>
        <span className="font-medium">{t(RUN_STATE_KEY[run.state])}</span>
        <span className="text-muted-foreground">{t("customTools.runRevision", { revision: run.revision })}</span>
        <span className="text-muted-foreground">{t("customTools.runSource", { source: run.source === "chat" ? t("customTools.sourceChat") : t("customTools.sourceTest") })}</span>
        {run.durationMs !== null && <span className="text-muted-foreground">{t("customTools.duration")}: {run.durationMs} ms</span>}
        <span className="text-muted-foreground">{t("customTools.bytes")}: {run.outputBytes}</span>
        {run.httpStatus !== null && <span className="text-muted-foreground">HTTP {run.httpStatus}</span>}
      </div>
      {run.error && <p className="text-destructive text-xs">{t(RUN_ERROR_KEY[run.error.code])}</p>}
      {run.resultRetained ? (
        <>
          <span className="text-muted-foreground text-xs">{t("customTools.result")}</span>
          <code className="bg-muted/50 max-h-96 overflow-auto rounded-md p-2 whitespace-pre-wrap">{text}</code>
          {text && (
            <Button type="button" size="xs" variant="outline" className="w-fit" onClick={() => void copyToClipboard(text)}>
              <CopyIcon className="size-3.5" /> {t("customTools.copyResult")}
            </Button>
          )}
        </>
      ) : run.state === "succeeded" || run.state === "failed" ? (
        <p className="text-muted-foreground text-xs">{t("customTools.resultPruned")}</p>
      ) : null}
    </div>
  );
}
