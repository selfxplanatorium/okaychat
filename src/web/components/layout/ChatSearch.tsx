import { useAui } from "@assistant-ui/react";
import { CommandIcon, Loader2Icon, MessageSquareIcon, SearchIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { ThreadSummary } from "@shared/types";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { showChat, useData } from "@/state/data";
import { Kbd } from "@/keyboard/Kbd";
import { COMMANDS, commandLabel, groupLabel } from "@/keyboard/commands";
import { commandAvailable, dialogReturnFocus, runCommand, useBindings } from "@/keyboard/registry";

type Hit = { threadId: string; title: string | null; messageId: string; snippet: string };
type CommandRow = { kind: "command"; id: string; label: string; combos: string[] };
type ChatRow = { kind: "chat"; id: string; title: string | null; snippet?: string };
type Row = CommandRow | ChatRow;

export function ChatSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const aui = useAui();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const loading = recentLoading || messageLoading;
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  // Read once per opening: the dialog hides (and makes inert) everything behind it, so availability
  // must be snapshotted before the modal mounts, not queried from the DOM afterwards.
  const [available, setAvailable] = useState<ReadonlySet<string>>(new Set());
  const [wasOpen, setWasOpen] = useState(false);
  const ran = useRef(false);
  const results = useRef<HTMLDivElement>(null);
  const bindings = useBindings();
  const q = query.trim();

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(0);
      const admin = useData.getState().me?.role === "admin";
      setAvailable(new Set(COMMANDS.filter((c) => c.palette !== false && c.id !== "app.search" && (admin || c.id !== "settings.admin") && commandAvailable(c.id)).map((c) => c.id)));
    }
  }

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setQuery("");
    setThreads([]);
    setError(null);
    setRecentLoading(true);
    api<ThreadSummary[]>("/threads", { signal: controller.signal }).then(setThreads, () => {
      if (!controller.signal.aborted) setError(t("sidebar.searchLoadFailed"));
    }).finally(() => { if (!controller.signal.aborted) setRecentLoading(false); });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    setHits([]);
    setMessageLoading(false);
    setSelected(0);
    if (!open || q.length < 2) return;
    const controller = new AbortController();
    setMessageLoading(true);
    const timer = setTimeout(() => {
      setError(null);
      api<Hit[]>(`/search?${new URLSearchParams({ q })}`, { signal: controller.signal }).then(setHits, () => {
        if (!controller.signal.aborted) setError(t("sidebar.searchMessagesFailed"));
      }).finally(() => { if (!controller.signal.aborted) setMessageLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, q]);

  const commands = useMemo<CommandRow[]>(() => {
    const needle = q.toLowerCase();
    return COMMANDS.filter(
      (c) => available.has(c.id) && (!needle || `${commandLabel(c)} ${groupLabel(c.group)}`.toLowerCase().includes(needle)),
    ).map((c) => ({
      kind: "command",
      id: c.id,
      label: commandLabel(c),
      combos: bindings.get(c.id) ?? [],
    }));
  }, [available, q, bindings]);

  const titles = threads.filter((thread) => (q || thread.status === "regular") && (thread.title ?? t("common.newChat")).toLowerCase().includes(q.toLowerCase())).slice(0, 20);
  const titleIds = new Set(titles.map((t) => t.id));
  const chats: ChatRow[] = [
    ...titles.map((t) => ({ kind: "chat" as const, id: t.id, title: t.title })),
    ...hits.filter((h) => !titleIds.has(h.threadId)).map((h) => ({ kind: "chat" as const, id: h.threadId, title: h.title, snippet: h.snippet })),
  ];
  // Actions are the better match while searching; recent chats stay first when the box is empty.
  const commandFirst = q.length > 0;
  const rows: Row[] = commandFirst ? [...commands, ...chats] : [...chats, ...commands];
  const groups = commandFirst
    ? [
        { key: "commands", label: t("keyboard.commands"), rows: commands as Row[], offset: 0 },
        { key: "chats", label: q ? t("sidebar.matchingChats") : t("sidebar.recentChats"), rows: chats as Row[], offset: commands.length },
      ]
    : [
        { key: "chats", label: q ? t("sidebar.matchingChats") : t("sidebar.recentChats"), rows: chats as Row[], offset: 0 },
        { key: "commands", label: t("keyboard.commands"), rows: commands as Row[], offset: chats.length },
      ];

  const choose = async (id: string) => {
    try {
      // Search spans projects. Clear the sidebar filter before opening a result.
      if (useData.getState().activeProject) {
        useData.getState().setActiveProject(null);
        await aui.threads.reload();
      }
      await aui.threads.switchToThread(id);
      showChat(navigate);
      onOpenChange(false);
    } catch { setError(t("sidebar.searchOpenFailed")); }
  };

  const run = (id: string) => {
    // Close first, and suppress the dialog's return-focus: the command focuses its own destination.
    ran.current = true;
    onOpenChange(false);
    setTimeout(() => runCommand(id), 0);
  };

  const activate = (row: Row) => {
    if (row.kind === "command") run(row.id);
    else void choose(row.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
        finalFocus={() => {
          const restore = !ran.current;
          ran.current = false;
          return restore && dialogReturnFocus();
        }}
      >
        <DialogTitle className="sr-only">{t("ux.searchChatsAndCommands")}</DialogTitle>
        <DialogDescription className="sr-only">{t("sidebar.searchDescription")}</DialogDescription>
        <div className="border-border flex items-center gap-3 border-b px-5 py-4">
          <SearchIcon aria-hidden className="text-muted-foreground size-5 shrink-0" />
          <input
            autoFocus
            aria-label={t("ux.searchChatsAndCommands")}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-activedescendant={rows[selected] ? `chat-search-option-${selected}` : undefined}
            aria-controls="chat-search-results"
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-none"
            placeholder={t("sidebar.searchPlaceholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = Math.max(0, Math.min(rows.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1)));
                setSelected(next);
                results.current?.querySelector(`#chat-search-option-${next}`)?.scrollIntoView({ block: "nearest" });
              } else if (e.key === "Enter" && rows[selected]) {
                e.preventDefault();
                activate(rows[selected]);
              }
            }}
          />
          <button type="button" aria-label={t("sidebar.closeSearch")} onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-foreground rounded border px-1.5 py-1 text-xs">{t("sidebar.escKey")}</button>
        </div>
        <div ref={results} id="chat-search-results" role="listbox" aria-label={t("ux.searchChatsAndCommands")} className="max-h-[min(55dvh,28rem)] overflow-y-auto p-2">
          {groups.map((group) =>
            group.key === "commands" && group.rows.length === 0 ? null : (
              <div key={group.key} role="group" aria-label={group.key === "chats" ? t("sidebar.chats") : group.label}>
                <p aria-hidden className="text-muted-foreground px-3 pt-2 pb-2 text-xs">{group.label}</p>
                {group.rows.map((row, index) => {
                  const position = group.offset + index;
                  return row.kind === "command" ? (
                    <button
                      key={`command:${row.id}`}
                      id={`chat-search-option-${position}`}
                      role="option"
                      aria-selected={selected === position}
                      type="button"
                      tabIndex={-1}
                      onClick={() => run(row.id)}
                      onMouseMove={() => setSelected(position)}
                      className={cn(
                        "focus-visible:outline-ring flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm",
                        selected === position ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                      )}
                    >
                      <CommandIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{row.label}</span>
                      <span className="flex shrink-0 gap-1.5">
                        {row.combos.map((combo) => <Kbd key={combo} combo={combo} />)}
                      </span>
                    </button>
                  ) : (
                    <button
                      key={`chat:${row.id}`}
                      id={`chat-search-option-${position}`}
                      role="option"
                      aria-selected={selected === position}
                      type="button"
                      tabIndex={-1}
                      onClick={() => void choose(row.id)}
                      onFocus={() => setSelected(position)}
                      onMouseMove={() => setSelected(position)}
                      className={cn(
                        "focus-visible:outline-ring flex min-h-11 w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm",
                        selected === position ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                      )}
                    >
                      <MessageSquareIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block truncate">{row.title ?? t("common.newChat")}</span>
                        {row.snippet && <span className="text-muted-foreground mt-1 line-clamp-2 text-xs">{row.snippet.split(/(\u0002[^\u0003]*\u0003)/).map((part, i) => part.startsWith("\u0002") ? <mark key={i} className="bg-primary/15 text-foreground rounded-sm">{part.slice(1, -1)}</mark> : <Fragment key={i}>{part}</Fragment>)}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ),
          )}
        </div>
        {loading && <p role="status" className="text-muted-foreground flex items-center gap-2 px-5 py-3 text-sm"><Loader2Icon className="size-4 animate-spin" /> {t("sidebar.searching")}</p>}
        {error && <p role="alert" className="text-destructive px-5 py-3 text-sm">{error}</p>}
        {!loading && !error && (q ? rows.length === 0 : chats.length === 0) && <p role="status" className="text-muted-foreground px-5 py-3 text-sm">{q ? t("sidebar.noChatsFound") : t("sidebar.chatsAppearHere")}</p>}
        <div className="text-muted-foreground border-border border-t px-5 py-3 text-xs">{t("sidebar.searchHints")}</div>
      </DialogContent>
    </Dialog>
  );
}
