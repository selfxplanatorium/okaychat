import { useAuiState } from "@assistant-ui/react";
import { CheckIcon, CopyIcon, Link2Icon, Loader2Icon, Share2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCurrentThreadId } from "@/state/thread-meta";

/** Top-right of a chat: create, copy, or revoke the thread's public read-only link. */
export function ShareButton() {
  const threadId = useCurrentThreadId();
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  useEffect(() => {
    setToken(undefined);
    if (threadId) void api<{ token: string | null }>(`/threads/${threadId}/share`).then((r) => setToken(r.token)).catch(() => setToken(null));
  }, [threadId]);

  if (!threadId || !hasMessages) return null;
  const url = token ? `${location.origin}/share/${token}` : "";
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        className="surface-glass text-muted-foreground hover:text-foreground animate-fade-in absolute top-2 right-2 z-20 rounded-lg border p-1.5 transition-colors duration-(--motion-fast) ease-out-quart"
        aria-label="Share chat"
      >
        <Share2Icon className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <p className="mb-1 text-sm font-medium">Share this chat</p>
        <p className="text-muted-foreground mb-3 text-xs">Anyone with the link can read the chat, including later messages. Reasoning, tool inputs, and costs stay private.</p>
        {token ? (
          <div className="animate-rise-in">
            <div className="mb-2 flex gap-1">
              <input readOnly value={url} className="bg-muted min-w-0 flex-1 rounded-lg px-2 text-xs" onFocus={(e) => e.target.select()} />
              <Button size="icon-sm" variant="outline" aria-label="Copy link" onClick={() => copyToClipboard(url)}>
                {/* Both icons share a grid cell so the check can pop over the copy icon. */}
                <span className="relative grid place-items-center">
                  <CopyIcon
                    className={cn("col-start-1 row-start-1 transition-opacity duration-(--motion-fast) ease-out-quart", isCopied && "opacity-0")}
                  />
                  <CheckIcon
                    aria-hidden
                    className={cn(
                      "col-start-1 row-start-1 transition-[opacity,scale] duration-(--motion-base) ease-spring",
                      isCopied ? "scale-100 opacity-100" : "scale-75 opacity-0",
                    )}
                  />
                </span>
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-error w-full"
              disabled={busy}
              onClick={() => run(async () => void (await api(`/threads/${threadId}/share`, { method: "DELETE" }), setToken(null)))}
            >
              Stop sharing
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="animate-rise-in w-full"
            disabled={busy || token === undefined}
            onClick={() => run(async () => setToken((await api<{ token: string }>(`/threads/${threadId}/share`, { method: "POST" })).token))}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <Link2Icon />} Create link
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
