import { CircleAlertIcon, CheckIcon, CopyIcon, RotateCwIcon } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { t } from "@/i18n";
import { useCommand } from "@/keyboard/registry";
import { errorDetails } from "@/lib/error-presentation";

const RENDER_DETAILS = errorDetails({ code: "unknown", message: "", retryable: false, ref: "client-render" });

function RenderFailure() {
  useCommand("app.reload", () => location.reload());
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center px-4 py-10">
      <div data-slot="app-error-boundary" className="bg-card flex w-full max-w-md flex-col gap-4 rounded-xl border p-5 shadow-[var(--depth-highlight),var(--shadow-raised)]">
        <div className="flex items-start gap-2.5">
          <CircleAlertIcon aria-hidden className="text-destructive mt-0.5 size-5 shrink-0" />
          <div className="min-w-0">
            <h1 role="alert" className="text-base font-semibold">{t("errors.renderTitle")}</h1>
            <p className="text-muted-foreground mt-1 text-sm">{t("errors.renderBody")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" data-command="app.reload" onClick={() => location.reload()} className="pointer-coarse:h-10">
            <RotateCwIcon aria-hidden />
            {t("errors.reload")}
          </Button>
          <Button type="button" variant="outline" data-command="error.copyDetails" onClick={() => copyToClipboard(RENDER_DETAILS)} className="pointer-coarse:h-10">
            {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {isCopied ? t("errors.detailsCopied") : t("errors.copyDetails")}
          </Button>
        </div>
      </div>
    </main>
  );
}

interface State {
  failed: boolean;
}

/** The last line of defence for a render failure: a real page, never a blank screen or a raw stack. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // A render error can carry component props (a prompt, a provider payload) in its message or stack.
    // The page already shows a reference; the console gets only the error's class of failure.
    console.error("[ui] render failed:", error instanceof Error ? error.name : typeof error);
  }

  render() {
    return this.state.failed ? <RenderFailure /> : this.props.children;
  }
}
