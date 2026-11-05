import { useEffect, useRef, useState } from "react";
import type { Json, RunView, TestReview, ToolDetail } from "@shared/custom-tools";
import { INPUT_JSON_LIMITS, newRequestId, parseToolJson, validateInput } from "@shared/custom-tools";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { VALIDATION_KEY } from "./custom-tool-keys";
import { CustomToolReview, CustomToolRunResult } from "./CustomToolResult";

const requestId = () => newRequestId((bytes) => crypto.getRandomValues(new Uint8Array(bytes)));

/** Explicit workspace test. HTTP first shows an exact server-authored review; preparing is not consent. */
export function CustomToolTestPanel({ detail, dirty, onSaved }: { detail: ToolDetail; dirty: boolean; onSaved?: () => void }) {
  const [text, setText] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunView | null>(detail.lastRun);
  const [review, setReview] = useState<TestReview | null>(null);
  const controller = useRef<AbortController | null>(null);
  const visible = useRef(true);
  const reviewRef = useRef<TestReview | null>(null);
  reviewRef.current = review;

  useEffect(() => () => {
    visible.current = false;
    controller.current?.abort();
    const pending = reviewRef.current;
    if (pending) void api(`/custom-tools/${encodeURIComponent(detail.id)}/runs/${encodeURIComponent(pending.runId)}/cancel`, { method: "POST", json: {} }).catch(() => {});
  }, [detail.id]);

  useEffect(() => {
    if (!run || (run.state !== "running" && run.state !== "prepared")) return;
    const timer = setInterval(() => {
      if (!visible.current) return;
      void api<{ run: RunView }>(`/custom-tools/${encodeURIComponent(detail.id)}/runs/${encodeURIComponent(run.id)}`).then((value) => {
        if (visible.current) setRun(value.run);
      }).catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [detail.id, run]);

  const parseInput = (): Json | null => {
    const parsed = parseToolJson(text, INPUT_JSON_LIMITS);
    if (!parsed.ok) {
      setError(t(VALIDATION_KEY[parsed.issues[0]!.reason]));
      return null;
    }
    const validated = validateInput(detail.inputSchema, parsed.value);
    if (!validated.ok) {
      const issue = validated.issues[0]!;
      setError(t("customTools.fieldError", { path: issue.path || "/", reason: t(VALIDATION_KEY[issue.reason]) }));
      return null;
    }
    return validated.value;
  };

  const start = async () => {
    setError(null);
    if (dirty) {
      setError(t("customTools.saveBeforeTest"));
      return;
    }
    const input = parseInput();
    if (!input) return;
    controller.current?.abort();
    const local = new AbortController();
    controller.current = local;
    setBusy(true);
    setReview(null);
    try {
      const response = await api<{ run?: RunView; review?: TestReview }>(`/custom-tools/${encodeURIComponent(detail.id)}/test`, {
        method: "POST",
        json: { expectedRevision: detail.revision, input, requestId: requestId() },
        signal: local.signal,
      });
      if (response.review) setReview(response.review);
      if (response.run) setRun(response.run);
      onSaved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("customTools.invalidInput"));
    } finally {
      if (controller.current === local) setBusy(false);
    }
  };

  const send = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ run: RunView }>(`/custom-tools/${encodeURIComponent(detail.id)}/test/execute`, { method: "POST", json: { runId: review.runId, token: review.token } });
      setRun(response.run);
      setReview(null);
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      setError(status === 410 ? t("customTools.reviewExpired") : status === 409 ? t("customTools.definitionChanged") : failure instanceof Error ? failure.message : t("customTools.remoteUncertain"));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    controller.current?.abort();
    if (review) {
      void api(`/custom-tools/${encodeURIComponent(detail.id)}/runs/${encodeURIComponent(review.runId)}/cancel`, { method: "POST", json: {} }).catch(() => {});
      setReview(null);
    } else if (run && (run.state === "running" || run.state === "prepared")) {
      void api(`/custom-tools/${encodeURIComponent(detail.id)}/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST", json: {} }).then((value) => setRun((value as { run: RunView }).run)).catch(() => {});
    }
    setBusy(false);
  };

  return (
    <section aria-labelledby="custom-tool-test-heading" className="grid gap-2">
      <h3 id="custom-tool-test-heading" className="text-sm font-medium">{t("customTools.test")}</h3>
      {!detail.enabled && <p className="text-muted-foreground text-xs">{t("customTools.disabledTest")}</p>}
      <label className="text-xs">
        <span className="text-muted-foreground">{t("customTools.input")}</span>
        <Textarea aria-label={t("customTools.input")} rows={6} className="mt-1 font-mono text-xs" value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="xs" variant="outline" onClick={() => {
          try { setText(JSON.stringify(JSON.parse(text), null, 2)); setError(null); } catch { setError(t("customTools.validationInvalidJson")); }
        }}>{t("customTools.formatJson")}</Button>
      </div>
      <p className="text-muted-foreground text-xs">{t("customTools.jsonInputHelp")}</p>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => void start()} disabled={busy || dirty} data-command="customTools.test">{t("customTools.runTest")}</Button>
        {(busy || review || (run && (run.state === "running" || run.state === "prepared"))) && (
          <Button type="button" size="sm" variant="outline" onClick={cancel} data-command="customTools.cancelTest">{t("customTools.cancelTest")}</Button>
        )}
      </div>
      {review && (
        <>
          <CustomToolReview review={review} />
          <Button type="button" size="sm" onClick={() => void send()} disabled={busy}>{t("customTools.sendRequest")}</Button>
        </>
      )}
      {run && <><h4 className="text-muted-foreground text-xs">{t("customTools.lastRun")}</h4><CustomToolRunResult run={run} /></>}
      {run && detail.lastRun && run.id !== detail.lastRun.id && (
        <div>
          <p className="text-muted-foreground mb-1 text-xs">{t("customTools.previousResult", { revision: detail.lastRun.revision })}</p>
          <CustomToolRunResult run={detail.lastRun} />
        </div>
      )}
    </section>
  );
}
