import type { RequestPreview } from "@shared/outgoing-webhooks";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatDateTime } from "@/i18n/format";

/**
 * The exact stored request a test will send. Custom header values are already `[redacted]` and the
 * signature/time/attempt values are explicit placeholders, so this display is honest about what is
 * shown rather than claiming to be byte-for-byte the wire request.
 */
export function WebhookTestPreview({
  preview,
  expiresAt,
  sending,
  sent,
  error,
  onSend,
}: {
  preview: RequestPreview;
  expiresAt: number;
  sending: boolean;
  sent: boolean;
  error: string | null;
  onSend: () => void;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="webhook-test-preview-title">
      <h2 id="webhook-test-preview-title" className="text-sm font-medium">{t("webhooks.previewTitle")}</h2>
      <p className="text-muted-foreground text-xs">{t("webhooks.previewNote")}</p>
      <p className="text-muted-foreground text-xs font-mono">{formatDateTime(expiresAt)}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">{t("webhooks.previewUrl")}</dt>
        <dd className="break-all font-mono">{preview.url}</dd>
        <dt className="text-muted-foreground">{t("webhooks.previewHeaders")}</dt>
        <dd>
          <ul className="flex flex-col gap-0.5 font-mono">
            {Object.entries(preview.headers).map(([name, value]) => (
              <li key={name} className="break-all">{name}: {value}</li>
            ))}
          </ul>
        </dd>
        <dt className="text-muted-foreground">{t("webhooks.previewBody")}</dt>
        <dd>
          <pre data-no-drawer-swipe className="bg-muted/50 max-h-64 overflow-auto rounded-lg p-2 font-mono text-xs whitespace-pre-wrap break-all">{preview.body}</pre>
        </dd>
      </dl>
      <p className="text-destructive text-xs font-medium">{t("webhooks.testWarning")}</p>
      <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
        {sent && <p className="text-success">{t("webhooks.testSent")}</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
      <Button className="self-start pointer-coarse:h-11" onClick={onSend} disabled={sending || sent}>
        {sending ? t("webhooks.sendingTest") : t("webhooks.sendTest")}
      </Button>
    </section>
  );
}
