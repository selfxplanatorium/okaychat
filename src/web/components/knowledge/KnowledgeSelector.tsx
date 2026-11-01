import { PlusIcon, CheckIcon, Loader2Icon, SettingsIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { useChatKnowledge } from "@/state/chat-knowledge";
import { useCommand, useShortcut } from "@/keyboard/registry";
import { ariaCombo } from "@/keyboard/keys";
import { useChatModel } from "@/state/thread-meta";

/** Collection attachments for the active chat, opened from the sidebar. */
export function KnowledgeMenuItems() {
  const { ids, collections, loading, toggle, refresh, temporary } = useChatKnowledge();
  const [error, setError] = useState<string | null>(null);
  // Several collections can be in flight at once; each clears only its own id.
  const [busy, setBusy] = useState<string[]>([]);
  const [, navigate] = useLocation();
  useEffect(() => {
    void refresh().catch(() => setError(t("knowledge.loadFailed")));
  }, [refresh]);
  if (temporary) return <MenuLabel>{t("knowledge.temporaryUnavailable")}</MenuLabel>;
  return (
    <>
      <MenuLabel>{t("knowledge.selectorTitle")}</MenuLabel>
      <p className="text-muted-foreground px-2.5 pb-1 text-xs">{t("knowledge.selectorHelp")}</p>
      {loading && !collections && (
        <div role="status" className="text-muted-foreground flex items-center gap-2 px-2.5 py-2 text-sm">
          <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" /> {t("common.loading")}
        </div>
      )}
      {error && <p role="alert" className="text-destructive px-2.5 py-2 text-xs">{error}</p>}
      {!loading && collections && collections.length === 0 && (
        <p className="text-muted-foreground px-2.5 py-2 text-xs">{t("knowledge.selectorEmpty")}</p>
      )}
      {collections?.map((collection) => {
        const attached = ids.includes(collection.id);
        return (
          <MenuItem
            key={collection.id}
            closeOnClick={false}
            disabled={busy.includes(collection.id)}
            onClick={async () => {
              setBusy((list) => [...list, collection.id]);
              setError(null);
              try {
                await toggle(collection.id);
              } catch {
                setError(t("knowledge.attachFailed"));
              } finally {
                setBusy((list) => list.filter((value) => value !== collection.id));
              }
            }}
          >
            <CheckIcon className={cn("shrink-0", attached ? "opacity-100" : "opacity-0")} />
            <span className="min-w-0 flex-1 truncate">{collection.name}</span>
            {attached && <span className="sr-only">{t("knowledge.attached")}</span>}
            {collection.status === "processing" && <Loader2Icon className="text-muted-foreground shrink-0 animate-spin motion-reduce:animate-none" />}
            <span className="text-muted-foreground shrink-0 text-xs">{t("knowledge.chunks", { count: collection.chunkCount })}</span>
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <MenuItem data-command="nav.knowledge" onClick={() => navigate("/knowledge")}>
        <SettingsIcon />
        {t("knowledge.selectorManage")}
      </MenuItem>
    </>
  );
}

/** Sidebar companion to the Knowledge page link. */
export function KnowledgeControl({ reveal }: { reveal: () => void }) {
  const active = useChatModel();
  const { ids, temporary } = useChatKnowledge();
  const combo = useShortcut("composer.knowledge");
  const trigger = useRef<HTMLButtonElement>(null);
  useCommand("composer.knowledge", () => {
    reveal();
    requestAnimationFrame(() => trigger.current?.click());
  }, !!active?.toolCall && !temporary);
  if (!active?.toolCall || temporary) return null;
  const hint = ids.length ? t("knowledge.selectorAttached", { count: ids.length }) : t("knowledge.selectorHelp");
  return (
    <Menu>
      <MenuTrigger
        ref={trigger}
        data-command="composer.knowledge"
        aria-label={t("knowledge.selector")}
        aria-pressed={ids.length > 0}
        aria-keyshortcuts={combo ? ariaCombo(combo) : undefined}
        title={hint}
        className={cn("text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-ring inline-flex h-8 min-w-8 pointer-coarse:h-11 pointer-coarse:min-w-11 shrink-0 items-center justify-center gap-1 rounded-lg px-1.5", ids.length > 0 && "bg-primary/12 text-primary")}
      >
        <PlusIcon className="size-4" />
        {ids.length > 0 && <span className="tabular-nums">{formatNumber(ids.length)}</span>}
      </MenuTrigger>
      <MenuContent side="right" align="start" className="max-h-80 w-72">
        <KnowledgeMenuItems />
      </MenuContent>
    </Menu>
  );
}
