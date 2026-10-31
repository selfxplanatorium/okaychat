import { useAui, useAuiState } from "@assistant-ui/react";
import { Loader2Icon, MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type FC, type KeyboardEvent } from "react";
import type { CallEngine } from "@shared/voice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { t, type PlainMessageKey } from "@/i18n";
import { formatDuration } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { useCommand } from "@/keyboard/registry";
import { useThreadSync } from "@/state/thread-sync";
import { CallController } from "./controller";
import { callBlock } from "./guard";
import { FAILURE_TEXT, noticeText } from "./messages";
import { isActive, type CallPhase } from "./state";
import { useCall } from "./store";

const ENGINE_LABEL: Record<CallEngine, PlainMessageKey> = {
  local: "voice.callEngineLocal",
  realtime: "voice.callEngineRealtime",
};
const ENGINE_HINT: Record<CallEngine, PlainMessageKey> = {
  local: "voice.callEngineLocalHint",
  realtime: "voice.callEngineRealtimeHint",
};

const STATUS: Record<CallPhase, PlainMessageKey> = {
  idle: "voice.callStart",
  starting: "voice.callStarting",
  preparing: "voice.callPreparing",
  listening: "voice.callListening",
  thinking: "voice.callThinking",
  speaking: "voice.callSpeaking",
  interrupted: "voice.callInterrupted",
  ended: "voice.callEnded",
  error: "voice.callErrFailed",
};

const optionalText = (message: { content: readonly { type: string; text?: string }[] }) =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("").trim();

const Meter: FC<{ level: number; active: boolean }> = ({ level, active }) => {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const bars = reduced ? 1 : 28;
  return (
    <div aria-hidden className="flex h-16 items-center justify-center gap-[3px]">
      {Array.from({ length: bars }, (_, index) => {
        const shape = reduced ? 1 : 0.35 + 0.65 * Math.abs(Math.sin(index * 0.7 + 1.2));
        const height = active ? Math.max(3, Math.round(level * shape * 64)) : 3;
        return (
          <span
            key={index}
            className={cn(
              "bg-primary/70 rounded-full transition-[height] duration-100 ease-out motion-reduce:transition-none",
              reduced ? "w-16" : "w-[3px]",
              active ? "opacity-90" : "opacity-30",
            )}
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
};

/** Full-screen on a phone, a large sheet on a desktop. One obvious End, mute, elapsed time, live transcript. */
export function CallView() {
  const aui = useAui();
  const open = useCall((s) => s.open);
  const call = useCall((s) => s.call);
  const level = useCall((s) => s.level);
  const notice = useCall((s) => s.notice);
  const preferred = useCall((s) => s.preferred);
  const availability = useCall((s) => s.availability);
  const availabilityError = useCall((s) => s.availabilityError);
  const [now, setNow] = useState(() => Date.now());
  const [startIndex, setStartIndex] = useState(0);
  const messages = useAuiState((s) => s.thread.messages);
  // These selectors only subscribe the view; `callBlock` reads the same live state at action time.
  useThreadSync();
  useAuiState((s) => s.thread.isRunning);
  useAuiState((s) => s.thread.isLoading);
  useAuiState((s) => s.composer.dictation != null);
  const blocked = callBlock(aui);
  const controller = useRef<CallController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  if (!controller.current) controller.current = new CallController(aui);

  useEffect(() => {
    if (open) void useCall.getState().loadAvailability();
    else if (useCall.getState().availability === null) void useCall.getState().loadAvailability();
  }, [open]);

  // Opening the dialog shows an empty call, not the chat's previous messages as if they were spoken now.
  useEffect(() => {
    if (open && !wasOpen.current) setStartIndex(aui.thread.getState().messages.length);
    wasOpen.current = open;
  }, [open, aui]);

  useEffect(() => {
    const dispose = () => controller.current?.dispose();
    // A page hidden into the back/forward cache ends its call; restoring shows the ended state, not a dead one.
    const hide = () => {
      controller.current?.end();
      controller.current?.dispose();
    };
    addEventListener("pagehide", hide);
    return () => {
      removeEventListener("pagehide", hide);
      dispose();
    };
  }, []);

  const active = isActive(call.phase);
  // Starting has no microphone yet, but it is already a call: the End control and the elapsed area belong.
  const inCall = call.phase === "starting" || active;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const start = (engine: CallEngine) => {
    if (callBlock(aui)) return;
    const current = useCall.getState().availability;
    if (!current || (engine === "local" ? !current.local : !current.realtime)) return;
    setStartIndex(aui.thread.getState().messages.length);
    void controller.current?.start(engine);
  };

  const end = () => controller.current?.end();
  const mute = () => controller.current?.setMuted(!call.muted);
  const localAvailable = availability?.local ?? false;
  const realtimeAvailable = availability?.realtime ?? false;
  const localReason = !localAvailable ? availability?.localReason : undefined;
  const preferredAvailable = preferred === "local" ? localAvailable : realtimeAvailable;
  // Local is the private default. If it is down the call does not silently move to the cloud; the user has
  // to pick the other engine explicitly.
  const chosen: CallEngine | null = preferredAvailable ? preferred : null;
  const otherAvailable = preferred === "local" ? realtimeAvailable : localAvailable;
  const preferredReason = preferred === "local" ? availability?.localReason : availability?.realtimeReason;
  const canStart = !!chosen && !blocked;
  // If the remembered engine is unavailable its radio is disabled, so the other one must take the tab stop.
  const focusEngine: CallEngine = preferredAvailable ? preferred : localAvailable ? "local" : realtimeAvailable ? "realtime" : preferred;
  // Opening from the command list must re-probe too: a worker that was down can come back.
  const refreshAvailability = () => void useCall.getState().loadAvailability();

  useCommand("chat.voiceCall", () => {
    if (useCall.getState().open) return true;
    useCall.getState().openCall();
    return true;
  });
  useCommand(
    "call.start",
    () => {
      const phase = useCall.getState().call.phase;
      if (!useCall.getState().open || isActive(phase) || phase === "preparing" || phase === "starting") return false;
      if (!chosen || blocked) return false;
      start(chosen);
      return true;
    },
    open,
  );
  useCommand(
    "call.mute",
    () => {
      if (!useCall.getState().open || !isActive(useCall.getState().call.phase)) return false;
      mute();
      return true;
    },
    open,
  );
  useCommand(
    "call.end",
    () => {
      if (!useCall.getState().open || !inCall) return false;
      end();
      return true;
    },
    open && inCall,
  );
  useCommand(
    "call.retry",
    () => {
      if (useCall.getState().call.phase !== "error") return false;
      if (canStart && chosen) start(chosen);
      else refreshAvailability();
      return true;
    },
    open && call.phase === "error",
  );
  useCommand(
    "call.refresh",
    () => {
      if (!useCall.getState().open) return false;
      refreshAvailability();
      return true;
    },
    open,
  );

  const lines = messages
    .slice(startIndex)
    .map((message) => ({ role: message.role, text: optionalText(message as { content: readonly { type: string; text?: string }[] }) }))
    .filter((line) => (line.role === "user" || line.role === "assistant") && line.text)
    .slice(-12);

  useEffect(() => {
    const element = scroll.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines.length, lines.at(-1)?.text, call.partial]);

  const close = () => {
    controller.current?.end();
    useCall.getState().closeCall();
  };

  const onOpenChange = (next: boolean) => {
    if (next) return;
    // Escape and the backdrop end the call rather than leaving it running behind a closed view.
    close();
  };

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== " " || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (!active) return;
    // Space is the advertised mute shortcut even when focus is on a button (the dialog traps focus there).
    // Preventing the default stops that button from activating as well, so Enter remains its activation key.
    event.preventDefault();
    event.stopPropagation();
    mute();
  };

  const onEngineKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
    const options = (["local", "realtime"] as const).filter((engine) => (engine === "local" ? localAvailable : realtimeAvailable));
    if (!options.length) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const current = options.indexOf(preferred);
    const next = options[(current + direction + options.length) % options.length]!;
    useCall.getState().prefer(next);
    const group = event.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-engine="${next}"]`)?.focus());
  };

  const elapsed = call.startedAt ? formatDuration((now - call.startedAt) / 1000) : formatDuration(0);
  const statusText = call.phase === "error" && call.failure ? t(FAILURE_TEXT[call.failure.code].title) : t(STATUS[call.phase]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-no-drawer-swipe
        onKeyDownCapture={onKeyDownCapture}
        className="call-surface depth-float top-0 left-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 grid-rows-[auto_1fr_auto] gap-0 rounded-none p-0 data-[starting-style]:translate-y-2 data-[ending-style]:translate-y-2 sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[min(90dvh,780px)] sm:w-[min(92vw,760px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border"
      >
        <header className="flex items-start justify-between gap-3 border-b px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-4">
          <div className="min-w-0">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <PhoneIcon className="text-primary size-4" aria-hidden />
              {t("voice.callTitle")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground mt-0.5 text-xs">{t("voice.callPrivacy")}</DialogDescription>
          </div>
          <div className="flex items-center gap-1">
            {inCall && (
              <span className="text-muted-foreground tabular-nums text-sm" aria-live="off">
                {t("voice.callElapsed", { time: elapsed })}
              </span>
            )}
            <TooltipIconButton
              tooltip={t("voice.callClose")}
              command="call.end"
              variant="ghost"
              size="icon"
              className="size-9 pointer-coarse:size-11"
              aria-label={t("voice.callClose")}
              onClick={close}
            >
              <XIcon className="size-4" />
            </TooltipIconButton>
          </div>
        </header>

        <div className="flex min-h-0 flex-col gap-4 overflow-hidden px-5 py-4">
          <div className="flex flex-col items-center gap-2">
            <Meter level={level} active={call.phase === "speaking" || (call.phase === "listening" && level > 0.05)} />
            <p className="text-base font-medium" aria-live="polite">
              {statusText}
            </p>
            {call.phase === "preparing" && (
              <p className="text-muted-foreground flex items-center gap-1.5 text-center text-xs">
                <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                {t("voice.callPreparingHint")}
              </p>
            )}
            {call.phase === "starting" && <Loader2Icon className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none" aria-label={t("voice.callStarting")} />}
            {active && (
              <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
                <span>{t(ENGINE_LABEL[call.engine])}</span>
                {call.voice && <span aria-label={t("voice.callVoice")}>{call.voice}</span>}
                {call.model && <span aria-label={t("voice.callModel")}>{call.model}</span>}
              </div>
            )}
          </div>

          {call.fallback && (
            <div role="status" className="border-warning/40 bg-warning/10 rounded-lg border px-3 py-2 text-xs">
              <p>{t("voice.callFallback", { requested: t(ENGINE_LABEL.realtime), used: t(ENGINE_LABEL[call.engine]) })}</p>
              <p className="text-muted-foreground mt-0.5">{t(FAILURE_TEXT[call.fallback.code].title)}</p>
              <p className="text-muted-foreground mt-0.5">{t(FAILURE_TEXT[call.fallback.code].fix)}</p>
            </div>
          )}
          {notice && (
            <p role="status" className="border-warning/40 bg-warning/10 rounded-lg border px-3 py-2 text-xs">
              {t(noticeText(notice))}
            </p>
          )}

          {call.phase === "error" && call.failure && (
            <div role="alert" className="border-error/40 bg-error/10 rounded-lg border px-3 py-2">
              <p className="text-error text-sm font-medium">{t(FAILURE_TEXT[call.failure.code].title)}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">{t(FAILURE_TEXT[call.failure.code].fix)}</p>
            </div>
          )}

          {!inCall && (
            <div className="flex flex-col gap-3">
              <div
                role="radiogroup"
                aria-label={t("voice.callEngine")}
                onKeyDown={onEngineKeyDown}
                className="bg-muted/60 grid grid-cols-1 gap-2 rounded-xl p-1 sm:grid-cols-2"
              >
                {(["local", "realtime"] as const).map((engine) => {
                  const available = engine === "local" ? localAvailable : realtimeAvailable;
                  return (
                    <button
                      key={engine}
                      type="button"
                      role="radio"
                      aria-checked={preferred === engine}
                      aria-label={t(ENGINE_LABEL[engine])}
                      tabIndex={focusEngine === engine ? 0 : -1}
                      data-engine={engine}
                      disabled={!available}
                      onClick={() => useCall.getState().prefer(engine)}
                      className={cn(
                        "focus-visible:ring-ring min-h-11 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none",
                        preferred === engine ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                        !available && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <span className="block font-medium">{t(ENGINE_LABEL[engine])}</span>
                      <span className="text-muted-foreground block text-xs">{available ? t(ENGINE_HINT[engine]) : t("voice.callEngineUnavailable", { engine: t(ENGINE_LABEL[engine]) })}</span>
                    </button>
                  );
                })}
              </div>
              {blocked && (
                <div role="status" className="border-warning/40 bg-warning/10 rounded-lg border px-3 py-2 text-xs">
                  <p className="font-medium">{t(FAILURE_TEXT[blocked].title)}</p>
                  <p className="text-muted-foreground mt-0.5">{t(FAILURE_TEXT[blocked].fix)}</p>
                </div>
              )}
              {!availability && !availabilityError && <p className="text-muted-foreground text-xs">{t("voice.callStarting")}</p>}
              {(availabilityError || (!localAvailable && !realtimeAvailable) || (!preferredAvailable && otherAvailable)) && (
                <div role="alert" className="border-error/40 bg-error/10 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="text-error font-medium">
                      {availabilityError
                        ? t("voice.callErrNetwork")
                        : preferredReason
                          ? t(FAILURE_TEXT[preferredReason.code].title)
                          : localReason
                            ? t(FAILURE_TEXT[localReason.code].title)
                            : t("voice.callNoEngines")}
                    </p>
                    <p className="text-muted-foreground mt-0.5">
                      {availabilityError
                        ? t("voice.callFixNetwork")
                        : preferredReason
                          ? t(FAILURE_TEXT[preferredReason.code].fix)
                          : localReason
                            ? t(FAILURE_TEXT[localReason.code].fix)
                            : t("voice.callNoEnginesFix")}
                    </p>
                  </div>
                  <Button data-command="call.refresh" size="sm" variant="outline" onClick={refreshAvailability} className="min-h-9">
                    {t("voice.callRetry")}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto rounded-xl border bg-background/40 px-3 py-2" aria-label={t("voice.callTitle")}>
            {call.phase === "idle" || (lines.length === 0 && !call.partial) ? (
              <p className="text-muted-foreground flex h-full items-center justify-center text-center text-sm">
                {call.phase === "error" ? t("voice.callErrFailed") : call.phase === "idle" ? t("voice.callStartHint") : t(STATUS[call.phase])}
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {lines.map((line, index) => (
                  <li key={index} className={cn("text-sm", line.role === "user" ? "text-foreground" : "text-foreground/90")}>
                    <span className="text-muted-foreground mr-2 text-xs uppercase tracking-wide">
                      {line.role === "user" ? t("voice.callYou") : t("voice.callAssistant")}
                    </span>
                    <span className="whitespace-pre-wrap">{line.text}</span>
                  </li>
                ))}
                {call.partial && (
                  <li className="text-muted-foreground text-sm italic" aria-live="polite">
                    {t("voice.callPartial", { text: call.partial })}
                  </li>
                )}
              </ol>
            )}
          </div>

          {call.engine === "realtime" && active && <p className="text-muted-foreground text-xs">{t("voice.callRealtimeNote")}</p>}
          <p className="text-muted-foreground text-center text-xs">{t("voice.callStartHint")}</p>
        </div>

        <footer className="flex items-center justify-center gap-3 border-t px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {(call.phase === "idle" || call.phase === "ended") && (
            <Button data-command="call.start" onClick={() => chosen && start(chosen)} disabled={!canStart} className="min-h-11 min-w-40">
              <PhoneIcon className="size-4" aria-hidden />
              {call.phase === "ended" ? t("voice.callStartAgain") : t("voice.callStart")}
            </Button>
          )}
          {inCall && (
            <>
              <Button
                data-command="call.mute"
                variant="outline"
                onClick={mute}
                aria-pressed={call.muted}
                disabled={call.phase === "starting" || call.phase === "preparing"}
                aria-label={call.muted ? t("voice.callUnmute") : t("voice.callMute")}
                className="min-h-11 min-w-24"
              >
                {call.muted ? <MicOffIcon className="size-4" aria-hidden /> : <MicIcon className="size-4" aria-hidden />}
                {call.muted ? t("voice.callUnmute") : t("voice.callMute")}
              </Button>
              <Button data-command="call.end" variant="destructive" onClick={end} className="min-h-11 min-w-32">
                <PhoneOffIcon className="size-4" aria-hidden />
                {t("voice.callEnd")}
              </Button>
            </>
          )}
          {call.phase === "error" && (
            <Button
              data-command="call.retry"
              variant="outline"
              onClick={() => (canStart && chosen ? start(chosen) : refreshAvailability())}
              className="min-h-11 min-w-32"
            >
              <RotateCcwIcon className="size-4" aria-hidden />
              {t("voice.callRetry")}
            </Button>
          )}
          {call.phase === "ended" && (
            <Button variant="outline" onClick={close} className="min-h-11 min-w-24">
              {t("voice.callClose")}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
