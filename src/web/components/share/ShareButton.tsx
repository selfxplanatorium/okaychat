import { useAuiState } from "@assistant-ui/react";
import { CheckIcon, CopyIcon, Link2Icon, Loader2Icon, Share2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ShareLink } from "@shared/share-links";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { api } from "@/lib/api";
import { errorText } from "@/lib/error-text";
import { cn } from "@/lib/utils";
import { useCurrentThreadId } from "@/state/thread-meta";
import { openShareManager } from "@/state/share-manager";
import { t } from "@/i18n";
import { ShareBadges } from "./ShareBadges";
import { ShareEditForm, shareUrl } from "./ShareEditForm";

/** Top-right of a chat: every public link of this chat. */
export function ShareButton() {
  const threadId = useCurrentThreadId();
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  // A temporary chat never reaches the API: it has no stored thread to share.
  if (!threadId || threadId.startsWith("tmp_") || !hasMessages) return null;
  return (
    <Popover>
      <PopoverTrigger
        className="surface-glass text-muted-foreground hover:text-foreground animate-fade-in relative z-20 rounded-lg border p-1.5 pointer-coarse:p-2.5 transition-colors duration-(--motion-fast) ease-out-quart"
        aria-label={t("share.shareChat")}
        data-command="chat.share"
      >
        <Share2Icon className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-1rem)] p-3">
        <SharePanel threadId={threadId} />
      </PopoverContent>
    </Popover>
  );
}

function CopyButton({ url }: { url: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  return (
    <Button size="icon-sm" variant="outline" aria-label={t("share.copyLink")} title={isCopied ? t("share.copied") : t("share.copyLink")} onClick={() => copyToClipboard(url)}>
      <span className="relative grid place-items-center">
        <CopyIcon className={cn("col-start-1 row-start-1 transition-opacity duration-(--motion-fast) ease-out-quart", isCopied && "opacity-0")} />
        <CheckIcon
          aria-hidden
          className={cn(
            "col-start-1 row-start-1 transition-[opacity,scale] duration-(--motion-base) ease-spring",
            isCopied ? "scale-100 opacity-100" : "scale-75 opacity-0",
          )}
        />
      </span>
    </Button>
  );
}

/** Share controls for one thread, used by the chat's share popover and the sidebar row menu. */
export function SharePanel({ threadId, title = t("share.shareThisChat") }: { threadId: string; title?: ReactNode | null }) {
  const [shares, setShares] = useState<ShareLink[] | null>(null);
  const [sharingDisabled, setSharingDisabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // The panel can stay open across a chat switch; an answer for the previous chat must not land here.
  const current = useRef(threadId);
  current.current = threadId;

  const load = useCallback(async () => {
    try {
      const result = await api<{ shares: ShareLink[]; sharingDisabled: boolean }>(`/threads/${threadId}/shares`);
      if (current.current !== threadId) return;
      setShares(result.shares);
      setSharingDisabled(result.sharingDisabled);
    } catch (cause) {
      if (current.current === threadId) setError(errorText(cause, "share.loadFailed"));
    }
  }, [threadId]);

  useEffect(() => {
    setShares(null);
    setError(null);
    setEditing(null);
    setRevoking(null);
    void load();
  }, [load, threadId]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ share: ShareLink }>(`/threads/${threadId}/shares`, { method: "POST", json: {} });
      if (current.current === threadId) setShares((list) => [result.share, ...(list ?? [])]);
    } catch (cause) {
      if (current.current === threadId) setError(errorText(cause, "share.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/shares/${token}`, { method: "DELETE" });
      if (current.current === threadId) setShares((list) => (list ?? []).filter((share) => share.token !== token));
      setRevoking(null);
    } catch (cause) {
      if (current.current === threadId) setError(errorText(cause, "share.revokeFailed"));
    } finally {
      setBusy(false);
    }
  };

  const replace = (next: ShareLink) => setShares((list) => (list ?? []).map((share) => (share.token === next.token ? next : share)));

  return (
    <div className="flex flex-col gap-3">
      {title !== null && <p className="text-sm font-medium">{title}</p>}
      <div className="text-muted-foreground flex flex-col gap-1 text-xs">
        <p>{t("share.shareNotice")}</p>
        <p>{t("share.liveModeHint")}</p>
        <p>{t("share.frozenModeHint")}</p>
      </div>
      {sharingDisabled && (
        <p role="status" className="bg-muted rounded-lg p-2 text-xs">
          {t("share.sharingDisabled")}
        </p>
      )}

      {shares !== null && shares.length === 0 && (
        <div className="flex flex-col items-start gap-2 py-2">
          <p className="text-sm">{t("share.noLinks")}</p>
          <p className="text-muted-foreground text-xs">{t("share.noLinksBody")}</p>
        </div>
      )}

      <ul className="flex max-h-[min(26rem,60vh)] flex-col gap-2 overflow-y-auto">
        {(shares ?? []).map((share) => (
          <li key={share.token} className="rounded-xl border p-2.5">
            {editing === share.token ? (
              <ShareEditForm
                share={share}
                onSaved={(next) => {
                  replace(next);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate text-sm font-medium">{share.label || t("share.linkUntitled")}</span>
                  <ShareBadges share={share} />
                </div>
                <div className="flex gap-1">
                  <input readOnly value={shareUrl(share.token)} aria-label={t("share.copyLink")} className="bg-muted min-w-0 flex-1 rounded-lg px-2 text-xs" onFocus={(event) => event.target.select()} />
                  <CopyButton url={shareUrl(share.token)} />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(share.token); setRevoking(null); }} className="pointer-coarse:min-h-11">
                    {t("share.editLink")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => (revoking === share.token ? void revoke(share.token) : setRevoking(share.token))}
                    className={cn("pointer-coarse:min-h-11", revoking === share.token ? "text-destructive" : "text-muted-foreground")}
                  >
                    {revoking === share.token ? t("share.confirmRevoke") : t("share.revokeLink")}
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" className="pointer-coarse:min-h-11" disabled={busy || shares === null} onClick={() => void create()}>
          {busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <Link2Icon />} {t("share.newLink")}
        </Button>
        <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={openShareManager}>
          {t("share.manageAllLinks")}
        </Button>
      </div>
    </div>
  );
}
