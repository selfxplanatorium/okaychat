import { useAui } from "@assistant-ui/react";
import { CommandIcon, SearchIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { settingsHref, permissionsHref } from "@/lib/settings-link";
import { signOut } from "@/lib/sign-out";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/state/appearance";
import { useArtifactPanel } from "@/state/artifacts";
import { useChatPrivacyStore } from "@/state/chat-privacy";
import { showChat, useData } from "@/state/data";
import { useThreadSelection } from "@/state/thread-selection";
import { t } from "@/i18n";
import { COMMAND_GROUPS, COMMANDS, commandLabel, groupLabel } from "./commands";
import { Kbd } from "./Kbd";
import { commandAvailable, commandTarget, dialogReturnFocus, press, runCommand, useBindings, useCommand, useKeyboardDialog, useKeyboardDispatcher } from "./registry";

const COMPOSER = "[data-slot=aui_composer-shell] textarea";

const messages = () => [...document.querySelectorAll<HTMLElement>("[data-slot=aui_thread-viewport] [data-message-root]")];
const focusedMessage = () => document.activeElement?.closest<HTMLElement>("[data-message-root]") ?? null;
const lastMessage = (role: "user" | "assistant") => messages().filter((m) => m.dataset.role === role).at(-1) ?? null;

function focusMessage(el: HTMLElement | undefined) {
  if (!el) return false;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
  return true;
}

/** Runs a message's action. Older messages mount their action bar on focus, so those take a frame. */
function messageAction(id: string, message: HTMLElement | null) {
  if (!message) return false;
  const target = commandTarget(id, message);
  // Clicked without moving focus, so copying or retrying from the message box keeps the cursor there.
  if (target) return target.click(), true;
  message.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    const late = commandTarget(id, message);
    if (late) press(late);
  });
  return true;
}

function focusComposer() {
  const input = document.querySelector<HTMLTextAreaElement>(COMPOSER);
  if (!input) return false;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

/** Shell-level commands, the key listeners, and the command list. Mounted once inside the runtime. */
export function KeyboardShortcuts() {
  useKeyboardDispatcher();
  const aui = useAui();
  const [location, navigate] = useLocation();
  const toggle = useKeyboardDialog((s) => s.toggle);

  useCommand("app.commands", () => toggle("commands"));
  useCommand("app.colorScheme", () => {
    const { mode, setMode } = useAppearance.getState();
    setMode(mode === "light" ? "system" : mode === "system" ? "dark" : "light");
  });
  useCommand("app.logout", () => void signOut());

  useCommand("nav.newChat", () => {
    void (async () => {
      await aui.threads.switchToNewThread();
      // The thread list knows the new id at once; the item scope lags a render after leaving a stored chat.
      useChatPrivacyStore.getState().set(aui.threads.getState().mainThreadId, { temporary: false, personalized: true });
      showChat(navigate);
      requestAnimationFrame(focusComposer);
    })();
  });
  const stepChat = (delta: number) => {
    const order = useThreadSelection.getState().order;
    if (!order.length) return false;
    const current = order.indexOf(aui.threads.getState().mainThreadId);
    const next = order[current === -1 ? (delta > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, current + delta))];
    if (!next) return false;
    void Promise.resolve(aui.threads.switchToThread(next)).then(() => showChat(navigate));
    return true;
  };
  useCommand("nav.previousChat", () => stepChat(-1));
  useCommand("nav.nextChat", () => stepChat(1));
  // Hooks in loops: the lists are constant, so they run in the same order on every render.
  for (const page of ["library", "knowledge", "projects", "scheduled", "plugins", "compare"] as const) {
    useCommand(`nav.${page}`, () => navigate(`/${page}`));
  }
  useCommand("nav.settings", () => navigate("/settings"));
  useCommand("app.openAgents", () => navigate(settingsHref("agents")));
  useCommand("nav.createProject", () => navigate("/projects?new=1"));
  useCommand("nav.createSchedule", () => navigate("/scheduled?new=1"));
  for (const command of COMMANDS.filter((c) => c.group === "Settings")) {
    const section = command.id.slice("settings.".length);
    useCommand(command.id, () => {
      if (section === "admin" && useData.getState().me?.role !== "admin") return false;
      if (section === "permissions") {
        if (useData.getState().me?.role !== "admin") return false;
        navigate(permissionsHref({ view: "people" }));
        return;
      }
      const anchored = section === "compaction" || section === "webTools" || section === "webSearchLimit";
      navigate(anchored ? settingsHref(section) : `/settings/${section}`);
    });
  }

  const inChat = !location.startsWith("/settings") && !["/scheduled", "/library", "/plugins", "/projects", "/compare"].includes(location);
  useCommand("chat.focusComposer", () => {
    if (inChat) return focusComposer();
    showChat(navigate);
    setTimeout(focusComposer, 50);
  });
  useCommand("chat.focusMessages", () => focusMessage(messages().at(-1)), inChat);
  useCommand("chat.stop", () => {
    if (!aui.thread().getState().isRunning) return false;
    aui.thread().cancelRun();
  }, inChat);
  useCommand("chat.retryLast", () => messageAction("message.retry", lastMessage("assistant")), inChat);
  useCommand("chat.editLast", () => messageAction("message.edit", lastMessage("user")), inChat);
  useCommand("chat.copyLast", () => messageAction("message.copy", lastMessage("assistant")), inChat);
  useCommand("chat.readLast", () => {
    const last = aui.thread().getState().messages.findLast((m) => m.role === "assistant");
    if (!last || !aui.thread().getState().capabilities.speech) return false;
    const message = aui.thread().message({ id: last.id });
    if (message.getState().speech) message.stopSpeaking();
    else message.speak();
  }, inChat);
  useCommand("chat.copyLastCode", () => {
    const target = messages().map((m) => commandTarget("code.copy", m)).filter(Boolean).at(-1);
    if (!target) return false;
    target.click();
  }, inChat);
  useCommand("chat.artifact", () => {
    const panel = useArtifactPanel.getState();
    if (panel.open) return panel.close();
    const card = commandTarget("artifact.open");
    if (!card) return false;
    press(card);
    // Into the panel, so Tab continues with its controls rather than the rest of the chat.
    setTimeout(() => document.querySelector<HTMLElement>(".shell-artifact-inner [data-command='chat.artifact']")?.focus(), 50);
  }, inChat);

  const step = (delta: number) => {
    const list = messages();
    const current = focusedMessage();
    const index = current ? list.indexOf(current) : -1;
    return focusMessage(list[index === -1 ? list.length - 1 : Math.max(0, Math.min(list.length - 1, index + delta))]);
  };
  useCommand("message.next", () => step(1));
  useCommand("message.previous", () => step(-1));
  useCommand("message.first", () => focusMessage(messages()[0]));
  useCommand("message.last", () => focusMessage(messages().at(-1)));
  for (const action of ["copy", "edit", "retry", "retryWithModel", "branch", "more"] as const) {
    useCommand(`message.${action}`, () => {
      const message = focusedMessage();
      if (!message) return false;
      const target = commandTarget(`message.${action}`, message);
      if (!target) return false;
      press(target);
    });
  }
  useCommand("message.exit", focusComposer);

  return <CommandList />;
}

function CommandList() {
  const open = useKeyboardDialog((s) => s.open === "commands");
  const close = useKeyboardDialog((s) => s.close);
  const bindings = useBindings();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [available, setAvailable] = useState<ReadonlySet<string>>(new Set());
  const ran = useRef(false);
  const list = useRef<HTMLDivElement>(null);

  // Availability is read once per opening: the dialog itself hides what is behind it.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setSelected(0);
      const admin = useData.getState().me?.role === "admin";
      setAvailable(new Set(COMMANDS.filter((c) => c.palette !== false && c.id !== "app.commands" && (admin || c.id !== "settings.admin") && commandAvailable(c.id)).map((c) => c.id)));
    }
  }

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      COMMAND_GROUPS.flatMap((group) =>
        COMMANDS.filter((c) => c.group === group && available.has(c.id) && (!q || `${commandLabel(c)} ${groupLabel(c.group)}`.toLowerCase().includes(q))),
      ),
    [available, q],
  );
  const messageCommands = COMMANDS.filter((c) => c.scope === "message" && (bindings.get(c.id)?.length ?? 0) > 0 && (!q || commandLabel(c).toLowerCase().includes(q)));

  const run = (id: string) => {
    ran.current = true;
    close();
    // After the dialog has let go of focus, so a command that focuses something keeps it.
    setTimeout(() => runCommand(id), 0);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        data-command-dialog
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
        finalFocus={() => {
          const restore = !ran.current;
          ran.current = false;
          return restore && dialogReturnFocus();
        }}
      >
        <DialogTitle className="sr-only">{t("keyboard.commands")}</DialogTitle>
        <DialogDescription className="sr-only">{t("keyboard.commandsHelp")}</DialogDescription>
        <div className="border-border flex items-center gap-3 border-b px-5 py-4">
          <CommandIcon aria-hidden className="text-muted-foreground size-5 shrink-0" />
          <input
            autoFocus
            aria-label={t("keyboard.searchCommands")}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-activedescendant={rows[selected] ? `command-${rows[selected].id}` : undefined}
            aria-controls="command-results"
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-none"
            placeholder={t("keyboard.typeCommand")}
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
                list.current?.querySelector(`#command-${CSS.escape(rows[next]?.id ?? "")}`)?.scrollIntoView({ block: "nearest" });
              } else if (e.key === "Enter" && rows[selected]) {
                e.preventDefault();
                run(rows[selected].id);
              }
            }}
          />
          <button type="button" aria-label={t("keyboard.closeCommands")} onClick={close} className="text-muted-foreground hover:text-foreground rounded border px-1.5 py-1 text-xs">{t("keyboard.esc")}</button>
        </div>
        <div ref={list} id="command-results" role="listbox" aria-label={t("keyboard.commands")} className="max-h-[min(60dvh,30rem)] overflow-y-auto p-2">
          {rows.map((command, index) => (
            <div key={command.id}>
              {command.group !== rows[index - 1]?.group && <p className="text-muted-foreground px-3 pt-3 pb-1 text-xs">{groupLabel(command.group)}</p>}
              <button
                id={`command-${command.id}`}
                role="option"
                aria-selected={selected === index}
                type="button"
                tabIndex={-1}
                onClick={() => run(command.id)}
                onMouseMove={() => setSelected(index)}
                className={cn(
                  "flex min-h-9 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm",
                  selected === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{commandLabel(command)}</span>
                <span className="flex shrink-0 gap-1.5">
                  {(bindings.get(command.id) ?? []).map((combo) => <Kbd key={combo} combo={combo} />)}
                </span>
              </button>
            </div>
          ))}
          {rows.length === 0 && (
            <p role="status" className="text-muted-foreground flex items-center gap-2 px-3 py-6 text-sm">
              <SearchIcon className="size-4" /> {t("keyboard.noMatch")}
            </p>
          )}
          {messageCommands.length > 0 && (
            <div className="mt-2 border-t pt-1">
              <p className="text-muted-foreground px-3 pt-3 pb-1 text-xs">{t("keyboard.whileMessageFocus")}</p>
              {messageCommands.map((command) => (
                <div key={command.id} className="text-muted-foreground flex min-h-8 items-center gap-3 px-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">{commandLabel(command)}</span>
                  <span className="flex shrink-0 gap-1.5">
                    {(bindings.get(command.id) ?? []).map((combo) => <Kbd key={combo} combo={combo} />)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="text-muted-foreground border-border flex items-center justify-between gap-3 border-t px-5 py-3 text-xs">
          <span>{t("keyboard.paletteHint")}</span>
          <Link href={settingsHref("keyboard")} onClick={close} className="hover:text-foreground underline underline-offset-4">
            {t("keyboard.customize")}
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
