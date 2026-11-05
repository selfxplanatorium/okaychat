import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { TriangleAlertIcon } from "lucide-react";
import type { ToolResult } from "@shared/custom-tools";
import type { InjectionReport } from "@shared/types";
import { InjectionBadge } from "@/components/chat/tool-ui";
import { t } from "@/i18n";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { RUN_ERROR_KEY } from "@/components/custom-tools/custom-tool-keys";

/** A custom tool call stays a normal work-log row, but its result is structured and read-only. */
export function CustomToolCallCard(props: ToolCallMessagePartProps) {
  const result = props.status?.type === "complete" ? props.result as ToolResult | undefined : undefined;
  const injection = result?.injection as InjectionReport | undefined;
  const value = result?.value === null || result?.value === undefined ? "" : JSON.stringify(result.value, null, 2);
  return (
    <ToolFallback.Root defaultOpen={props.status?.type === "requires-action"}>
      <ToolFallback.Trigger toolName={props.toolName} status={props.status} responseDeliveryStatus={props.responseDeliveryStatus} />
      <InjectionBadge report={injection} className="ps-6" />
      <ToolFallback.Content>
        {props.approval && (
          <ToolFallback.Approval
            addResult={props.addResult}
            resume={props.resume}
            interrupt={props.interrupt}
            approval={props.approval}
            respondToApproval={props.respondToApproval}
            status={props.status}
          />
        )}
        {result ? (
          <div className="grid gap-1 text-sm">
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>{result.name}</span>
              <span>{t("customTools.runRevision", { revision: result.revision })}</span>
              <span>run {result.runId}</span>
              <span>{t("customTools.duration")}: {result.durationMs} ms</span>
              {result.httpStatus !== null && <span>HTTP {result.httpStatus}</span>}
            </div>
            {result.error && (
              <p className="text-destructive flex items-start gap-1 text-xs">
                <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {t(RUN_ERROR_KEY[result.error.code])}
              </p>
            )}
            {result.ok && (
              <code className="bg-muted/50 max-h-80 overflow-auto rounded-md p-2 whitespace-pre-wrap">{value}</code>
            )}
          </div>
        ) : (
          <ToolFallback.Result result={props.result} />
        )}
      </ToolFallback.Content>
    </ToolFallback.Root>
  );
}
