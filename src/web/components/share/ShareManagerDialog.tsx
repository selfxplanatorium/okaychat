import { useState } from "react";
import { useLocation } from "wouter";
import { CheckIcon, CopyIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import type { ShareLink } from "@shared/share-links";
import { chatPath } from "@/state/data";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useCommand } from "@/keyboard/registry";
import { errorText } from "@/lib/error-text";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { openShareManager, useShareManager, type ShareFilter } from "@/state/share-manager";
import { formatDate } from "@/i18n/format";
import { ShareBadges } from "./ShareBadges";
import { ShareEditForm, shareUrl } from "./ShareEditForm";

function ManagerRow({ share, onOpenChat }: { share: ShareLink; onOpenChat: () => void }) {
  const [editing, setEditing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const revoke = useShareManager((s) => s.revoke);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <li className="flex flex-col gap-2 rounded-xl border p-3">
      {editing ? (
        <ShareEditForm
          share={share}
          onSaved={(next) => {
            useShareManager.setState((state) => ({
              shares: (state.shares ?? []).map((item) => (item.token === next.token ? next : item)),
            }));
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="min-w-0 truncate text-sm font-medium">{share.label || t("share.linkUntitled")}</span>
            <span className="text-muted-foreground min-w-0 truncate text-xs">{share.threadTitle ?? t("notifications.unknownChat")}</span>
            <ShareBadges share={share} />
            <span className="text-muted-foreground text-[11px]">{formatDate(share.createdAt)}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => copyToClipboard(shareUrl(share.token))} title={isCopied ? t("share.copied") : t("share.copyLink")}>
              {isCopied ? <CheckIcon /> : <CopyIcon />} {isCopied ? t("share.copied") : t("share.copyLink")}
            </Button>
            <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setEditing(true)}>
              {t("share.editLink")}
            </Button>
            <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={onOpenChat}>
              <ExternalLinkIcon /> {t("share.openChat")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              className={cn("pointer-coarse:min-h-11", revoking ? "text-destructive" : "text-muted-foreground")}
              onClick={async () => {
                if (!revoking) return setRevoking(true);
                setBusy(true);
                try {
                  await revoke(share.token);
                } catch (cause) {
                  setError(errorText(cause, "share.revokeFailed"));
                  setRevoking(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {revoking ? t("share.confirmRevoke") : t("share.revokeLink")}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </li>
  );
}

/** Account-wide link manager: search, filter, edit, revoke, and open the chat behind each link. */
export function ShareManagerDialog() {
  const [, navigate] = useLocation();
  const { open, shares, cursor, filter, sharingDisabled, busy, error, close, load, more } = useShareManager();
  const [search, setSearch] = useState("");

  useCommand("share.manage", openShareManager);

  const query = search.trim().toLowerCase();
  const visible = (shares ?? []).filter(
    (share) => !query || (share.label ?? "").toLowerCase().includes(query) || (share.threadTitle ?? "").toLowerCase().includes(query),
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openShareManager() : close())}>
      <DialogContent className="flex max-h-[min(46rem,88vh)] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("share.shareManage")}</DialogTitle>
          <DialogDescription>{t("share.sharedLinks")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("share.searchLinks")} aria-label={t("share.searchLinks")} className="h-8 min-w-40 flex-1" />
          <SegmentedControl
            aria-label={t("share.sharedLinks")}
            value={filter}
            onValueChange={(value) => void load(value as ShareFilter, true)}
            items={[
              { value: "all", label: t("share.filterAll") },
              { value: "active", label: t("share.filterActive") },
              { value: "expired", label: t("share.filterExpired") },
            ]}
          />
        </div>
        {sharingDisabled && (
          <p role="status" className="bg-muted rounded-lg p-2 text-xs">
            {t("share.sharingDisabled")}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {busy && shares === null && (
            <p role="status" className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
              <Loader2Icon className="animate-spin motion-reduce:animate-none" /> {t("common.loading")}
            </p>
          )}
          {error && (
            <div role="alert" className="flex flex-col items-start gap-2 p-4">
              <p className="text-sm">{t(error)}</p>
              <Button size="sm" variant="outline" onClick={() => void load(filter, true)}>
                {t("common.tryAgain")}
              </Button>
            </div>
          )}
          {shares !== null && shares.length === 0 && !search && (
            <p className="text-muted-foreground p-4 text-sm">{t("share.noLinksBody")}</p>
          )}
          {search && visible.length === 0 && <p className="text-muted-foreground p-4 text-sm">{t("share.noLinks")}</p>}
          <ul className="flex flex-col gap-2 p-0.5">
            {visible.map((share) => (
              <ManagerRow
                key={share.token}
                share={share}
                onOpenChat={() => {
                  close();
                  navigate(chatPath(share.threadId));
                }}
              />
            ))}
          </ul>
          {cursor && !search && (
            <div className="flex justify-center py-3">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void more()}>
                {t("share.loadMore")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
