import { CheckIcon, CopyIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { api } from "@/lib/api";

type CodexStatus = { version: string | null; connected: boolean; login: { url?: string; code?: string; error?: string } | null };

/** Connects the user's ChatGPT account through `codex login --device-auth` on the server. */
export function CodexConnect() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const refresh = useCallback(() => api<CodexStatus>("/codex").then(setStatus), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a device login is waiting for the user to approve it.
  const waiting = !!status?.login?.code && !status.login.error && !status.connected;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  if (!status) return null;
  if (!status.version) return <p className="text-muted-foreground animate-rise-in text-sm">The Codex CLI is not installed on this server.</p>;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/codex/login", { method: "POST" });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    await api("/codex", { method: "DELETE" });
    await refresh();
  };

  if (status.connected) {
    return (
      <div className="animate-rise-in flex items-center gap-3">
        <span className="text-success flex items-center gap-1.5 text-sm">
          <CheckIcon className="animate-pop-in size-4" /> Connected
        </span>
        <Button size="sm" variant="outline" onClick={disconnect}>
          Disconnect
        </Button>
      </div>
    );
  }

  if (waiting) {
    return (
      <div className="animate-rise-in flex flex-col items-end gap-2 text-sm">
        <a href={status.login!.url} target="_blank" rel="noreferrer" className="text-primary flex items-center gap-1 transition-colors duration-(--motion-fast) hover:underline">
          Open {new URL(status.login!.url!).host} <ExternalLinkIcon className="size-3.5" />
        </a>
        <button type="button" onClick={() => copyToClipboard(status.login!.code!)} className="bg-muted flex items-center gap-2 rounded-lg px-3 py-1.5 font-mono text-base tracking-wider" aria-label="Copy code">
          {status.login!.code}
          {isCopied ? <CheckIcon className="animate-pop-in size-4" /> : <CopyIcon className="text-muted-foreground size-4" />}
        </button>
        <span className="text-muted-foreground animate-pulse-soft flex items-center gap-1.5 text-xs">
          <Loader2Icon className="size-3 animate-spin" /> Waiting for approval
        </span>
        <Button size="xs" variant="ghost" onClick={disconnect}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-rise-in flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={connect} disabled={busy}>
        {busy && <Loader2Icon className="animate-spin" />}
        Connect ChatGPT
      </Button>
      {(error ?? status.login?.error) && <span className="text-error animate-fade-in text-xs">{error ?? status.login?.error}</span>}
    </div>
  );
}
