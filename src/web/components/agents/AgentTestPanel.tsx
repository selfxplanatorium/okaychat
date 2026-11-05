import { Loader2Icon, PlayIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { N8nAgentInput, N8nTestResult } from "@shared/n8n-agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import { formatDuration } from "@/i18n/format";
import { useCommand } from "@/keyboard/registry";
import { agentErrorText } from "./agent-error";

interface TestFailure {
  message: string;
  hint?: string;
  reason?: string;
}

/**
 * One explicit test request against the workflow. It always starts a fresh session with empty history and
 * never reads or writes the chat, so a test cannot leak a real conversation into the workflow.
 */
export function AgentTestPanel({
  agentId,
  revision,
  input,
  invalidatesKey,
  disabled = false,
  testPath = "/agents/n8n/test",
  onResult,
}: {
  agentId?: string;
  revision?: number;
  /** Omitted for an unchanged saved form: the server then tests the stored definition and records status. */
  input?: N8nAgentInput;
  /** Changes whenever a saved value that affects the request changes, so an old preview is not trusted. */
  invalidatesKey: string;
  disabled?: boolean;
  /** The admin route can test a shared definition; the user route only an owned one. */
  testPath?: string;
  onResult?: (ok: boolean) => void;
}) {
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<N8nTestResult | null>(null);
  const [failure, setFailure] = useState<TestFailure | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const statusId = useId();
  const errorId = useId();

  const stop = () => {
    controller.current?.abort();
    controller.current = null;
    generation.current++;
    setRunning(false);
    setCancelled(true);
  };

  // A changed URL, header, or response mode makes the last preview misleading, and the request it ran
  // against is no longer the one on screen.
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    setRunning(false);
    setResult(null);
    setFailure(null);
    setCancelled(false);
  }, [invalidatesKey]);

  // Unmount (closing the editor, switching agents) cancels the test instead of letting it finish unseen.
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  const send = async () => {
    if (running || disabled) return;
    const own = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setResult(null);
    setFailure(null);
    setCancelled(false);
    try {
      const next = await api<N8nTestResult>(testPath, {
        method: "POST",
        signal: abort.signal,
        json: {
          ...(agentId ? { agentId, ...(revision === undefined ? {} : { revision }) } : {}),
          ...(input ? { input } : {}),
          ...(message.trim() ? { message: message.trim() } : {}),
        },
      });
      if (generation.current !== own) return;
      setResult(next);
      onResult?.(true);
    } catch (error) {
      if (generation.current !== own) return;
      if (abort.signal.aborted) {
        setCancelled(true);
        return;
      }
      setFailure(agentErrorText(error));
      onResult?.(false);
    } finally {
      if (generation.current === own) setRunning(false);
      if (controller.current === abort) controller.current = null;
    }
  };

  useCommand("agents.test", () => void send(), !running && !disabled);
  useCommand("agents.stopTest", () => {
    if (!running) return false;
    stop();
  }, running);

  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${statusId}-title`}>
      <h3 id={`${statusId}-title`} className="text-sm font-medium">
        {t("agents.testTitle")}
      </h3>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
          <span className="font-medium">{t("agents.testMessage")}</span>
          <Input
            className="pointer-coarse:h-11"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={1000}
            placeholder={t("agents.testMessage")}
            aria-describedby={failure ? `${statusId} ${errorId}` : statusId}
          />
        </label>
        <div className="flex shrink-0 gap-2">
          {running ? (
            <Button type="button" variant="outline" onClick={stop} data-command="agents.stopTest" className="min-h-10 pointer-coarse:min-h-11">
              <SquareIcon /> {t("agents.testStop")}
            </Button>
          ) : (
            <Button type="button" onClick={() => void send()} disabled={disabled} data-command="agents.test" className="min-h-10 pointer-coarse:min-h-11">
              <PlayIcon /> {t("agents.testSend")}
            </Button>
          )}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{t("agents.testSideEffects")}</p>
      <div id={statusId} role="status" aria-live="polite" className="text-xs">
        {running && (
          <p className="text-muted-foreground flex items-center gap-1.5">
            <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" /> {t("agents.testRunning")}
          </p>
        )}
        {cancelled && !running && <p className="text-muted-foreground">{t("agents.testCancelled")}</p>}
      </div>
      {failure && (
        <div id={errorId} role="alert" className="border-destructive/40 bg-destructive/10 flex min-w-0 flex-col gap-1 rounded-lg border p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium">
            <TriangleAlertIcon className="text-destructive size-3.5 shrink-0" /> {failure.message}
          </p>
          {failure.hint && <p className="text-muted-foreground wrap-break-word">{failure.hint}</p>}
          {failure.reason && <p className="text-muted-foreground wrap-break-word">{failure.reason}</p>}
        </div>
      )}
      {result && (
        <div role="status" aria-live="polite" className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-medium">{t("agents.testSuccess")}</p>
          <pre className="bg-muted/60 max-h-56 min-w-0 overflow-auto rounded-lg border p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap wrap-break-word">
            {result.preview}
          </pre>
          {result.truncated && <p className="text-muted-foreground text-xs">{t("agents.testTruncated")}</p>}
          <p className="text-muted-foreground text-xs">{t("agents.elapsed", { duration: formatDuration(Math.round(result.durationMs / 1000)) })}</p>
        </div>
      )}
    </section>
  );
}
