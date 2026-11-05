import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2Icon, PlusIcon, SendIcon, SquareIcon, Trash2Icon, XIcon } from "lucide-react";
import { REASONING_EFFORTS } from "@shared/reasoning";
import { COMPARE_MAX_PANES, COMPARE_MAX_PROMPT, COMPARE_MIN_PANES } from "@shared/compare";
import { isAgentTarget } from "@shared/n8n-agents";
import type { ThreadSummary } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { chatPath, useData } from "@/state/data";
import { useCompare } from "@/state/compare";
import { t } from "@/i18n";
import { formatDate } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { effortLabel, ModelSelect } from "@/components/chat/ModelPicker";
import { ComparePane, type PaneHandle } from "./ComparePane";

type Slot = { ref: string; effort: string };

function CompareSetup({ onStarted }: { onStarted: (prompt: string) => void }) {
  const models = useData((s) => s.models);
  const projects = useData((s) => s.projects);
  const settings = useData((s) => s.settings);
  const create = useCompare((s) => s.create);
  const groups = useCompare((s) => s.groups);
  const refreshList = useCompare((s) => s.refreshList);
  const load = useCompare((s) => s.load);
  const llm = useMemo(() => models.filter((model) => !isAgentTarget(model)), [models]);
  const first = settings?.defaultModel ?? settings?.favoriteModels[0] ?? llm[0]?.ref ?? "";
  const second = llm.find((model) => model.ref !== first)?.ref ?? "";
  const [slots, setSlots] = useState<Slot[]>([{ ref: first, effort: "" }, { ref: second, effort: "" }]);
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState("");
  const [sourceThreadId, setSourceThreadId] = useState("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshList();
    void api<ThreadSummary[]>("/threads")
      .then((rows) => setThreads(rows.slice(0, 20)))
      .catch(() => {});
  }, [refreshList]);

  // A model chosen once should not appear twice; the server refuses duplicates too.
  useEffect(() => {
    setSlots((current) => {
      if (!current[0]?.ref && first) return [{ ref: first, effort: "" }, ...current.slice(1)];
      return current;
    });
  }, [first]);

  const update = (index: number, patch: Partial<Slot>) =>
    setSlots((current) => current.map((slot, position) => (position === index ? { ...slot, ...patch } : slot)));

  const submit = async () => {
    setError(null);
    if (!prompt.trim()) return setError(t("compare.promptRequired"));
    if (prompt.length > COMPARE_MAX_PROMPT) return setError(t("compare.promptTooLong", { count: COMPARE_MAX_PROMPT }));
    if (slots.length < COMPARE_MIN_PANES || slots.length > COMPARE_MAX_PANES) return setError(t("compare.paneLimit"));
    if (slots.some((slot) => !slot.ref)) return setError(t("compare.modelRequired"));
    if (new Set(slots.map((slot) => slot.ref)).size !== slots.length) return setError(t("compare.sameModel"));
    setBusy(true);
    try {
      await create({
        prompt: prompt.trim(),
        models: slots.map((slot) => ({ ref: slot.ref, ...(slot.effort ? { effort: slot.effort } : {}) })),
        projectId: projectId || null,
        sourceThreadId: sourceThreadId || null,
      });
      onStarted(prompt.trim());
      setPrompt("");
    } catch {
      setError(t("compare.loadFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 overflow-y-auto px-4 py-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("compare.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("compare.intro")}</p>
      </div>
      <Menu>
        <MenuTrigger render={<Button variant="outline" size="sm" className="self-start" />}>{t("compare.recent")}</MenuTrigger>
        <MenuContent align="start">
          {groups.length === 0 && <p className="text-muted-foreground px-2.5 py-2 text-xs">{t("compare.noRecent")}</p>}
          {groups.map((group) => (
            <MenuItem key={group.id} onClick={() => void load(group.id)}>
              <span className="min-w-0 flex-1 truncate">{group.title}</span>
              <span className="text-muted-foreground shrink-0 text-xs">{formatDate(group.updatedAt)}</span>
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <div className="flex flex-col gap-2">
        {slots.map((slot, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground w-14 shrink-0 text-xs">{t("compare.model")} {index + 1}</span>
            <ModelSelect
              aria-label={`${t("compare.model")} ${index + 1}`}
              className="min-w-40 flex-1"
              value={slot.ref}
              onValueChange={(ref) => update(index, { ref })}
              filter={(model) => !isAgentTarget(model)}
              allowAgents={false}
            />
            <Select
              aria-label={`${t("compare.effort")} ${index + 1}`}
              className="w-40"
              value={slot.effort}
              onValueChange={(effort) => update(index, { effort })}
              options={[{ value: "", label: t("general.defaultReasoningEffort") }, ...REASONING_EFFORTS.map((effort) => ({ value: effort, label: effortLabel(effort) }))]}
            />
            {slots.length > COMPARE_MIN_PANES && (
              <Button type="button" size="icon-sm" variant="ghost" aria-label={t("compare.removeModel")} onClick={() => setSlots((current) => current.filter((_, position) => position !== index))}>
                <XIcon />
              </Button>
            )}
          </div>
        ))}
        {slots.length < COMPARE_MAX_PANES && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setSlots((current) => [...current, { ref: llm.find((model) => !current.some((slot) => slot.ref === model.ref))?.ref ?? "", effort: "" }])}
          >
            <PlusIcon /> {t("compare.addModel")}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Select
          aria-label={t("compare.startFromChat")}
          className="min-w-48 flex-1"
          value={sourceThreadId}
          onValueChange={setSourceThreadId}
          options={[{ value: "", label: t("compare.noChat") }, ...threads.map((thread) => ({ value: thread.id, label: thread.title ?? t("compare.noChat") }))]}
        />
        <Select
          aria-label={t("compare.project")}
          className="min-w-40 flex-1"
          value={projectId}
          onValueChange={setProjectId}
          options={[{ value: "", label: t("compare.noProject") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
        />
      </div>
      <Textarea
        value={prompt}
        maxLength={COMPARE_MAX_PROMPT}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={t("compare.promptPlaceholder")}
        aria-label={t("compare.promptPlaceholder")}
        className="min-h-28"
      />
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button type="button" className="self-start pointer-coarse:min-h-11" disabled={busy || slots.length < COMPARE_MIN_PANES} onClick={() => void submit()}>
        {busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <SendIcon />} {t("compare.compare")}
      </Button>
    </div>
  );
}

function CompareRun({ autoPrompt, clearAutoPrompt }: { autoPrompt: string | null; clearAutoPrompt: () => void }) {
  const [, navigate] = useLocation();
  const group = useCompare((s) => s.group)!;
  const promote = useCompare((s) => s.promote);
  const remove = useCompare((s) => s.remove);
  const setRunning = useCompare((s) => s.setRunning);
  const efforts = useCompare((s) => s.efforts);
  const reset = useCompare((s) => s.reset);
  const refreshList = useCompare((s) => s.refreshList);
  const groups = useCompare((s) => s.groups);
  const load = useCompare((s) => s.load);
  const running = useCompare((s) => s.running);
  const settings = useData((s) => s.settings);
  const [active, setActive] = useState(0);
  const [value, setValue] = useState("");
  const [unanswered, setUnanswered] = useState<Set<string>>(new Set());
  const [confirmPromote, setConfirmPromote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const controls = useRef(new Map<string, PaneHandle>());
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (!autoPrompt) return;
    pending.current = new Set(group.panes.map((pane) => pane.threadId));
  }, [autoPrompt, group.panes]);

  const register = useCallback((threadId: string, handle: PaneHandle | null) => {
    if (handle) controls.current.set(threadId, handle);
    else controls.current.delete(threadId);
  }, []);

  const onStatus = useCallback(
    (threadId: string, status: string) => {
      setRunning(threadId, status === "submitted" || status === "streaming");
    },
    [setRunning],
  );

  const onNeedsAnswer = useCallback((threadId: string, needs: boolean) => {
    setUnanswered((current) => {
      if (current.has(threadId) === needs) return current;
      const next = new Set(current);
      if (needs) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  }, []);

  const onAutoSent = useCallback(
    (threadId: string) => {
      pending.current.delete(threadId);
      if (!pending.current.size) clearAutoPrompt();
    },
    [clearAutoPrompt],
  );

  const anyRunning = running.size > 0;
  const anyUnanswered = [...unanswered].some((id) => group.panes.some((pane) => pane.threadId === id));

  const sendAll = () => {
    const text = value.trim();
    if (!text || anyRunning || anyUnanswered) return;
    setValue("");
    for (const pane of group.panes) controls.current.get(pane.threadId)?.send(text);
  };

  const stopAll = () => {
    for (const pane of group.panes) controls.current.get(pane.threadId)?.stop();
  };

  const openAsChat = (threadId: string) => {
    if (group.panes.length <= COMPARE_MIN_PANES) return setConfirmPromote(threadId);
    void finishPromote(threadId);
  };

  const finishPromote = async (threadId: string) => {
    setActionError(null);
    try {
      const thread = await promote(threadId);
      setConfirmPromote(null);
      // Opening the chat path switches the runtime through ChatUrlSync.
      navigate(chatPath(thread.id));
    } catch {
      // The refusal is the server's (a pane still replying); the copy names the action.
      setActionError(t("compare.stopFirst"));
      setConfirmPromote(null);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    setActionError(null);
    try {
      await remove();
      await refreshList();
      setConfirmDelete(false);
    } catch {
      setActionError(t("compare.stopFirst"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={group.prompt}>
          {group.prompt}
        </p>
        {actionError && (
          <p role="alert" className="text-destructive text-xs">
            {actionError}
          </p>
        )}
        <Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" onClick={reset}>
          {t("compare.newComparison")}
        </Button>
        {groups.length > 0 && (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="ghost" className="pointer-coarse:min-h-11" />}>{t("compare.recent")}</MenuTrigger>
            <MenuContent align="end">
              {groups.map((item) => (
                <MenuItem key={item.id} onClick={() => void load(item.id)}>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">{formatDate(item.updatedAt)}</span>
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        {anyRunning && (
          <>
            <span className="text-muted-foreground text-[11px]">{t("compare.stopFirst")}</span>
            <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={stopAll}>
              <SquareIcon /> {t("compare.stopAll")}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" className="text-muted-foreground pointer-coarse:min-h-11" onClick={() => setConfirmDelete(true)} aria-label={t("compare.deleteComparison")}>
          <Trash2Icon /> {t("compare.delete")}
        </Button>
      </div>

      {/* Below lg: one pane at a time. The tab strip is a real tablist with arrow navigation. */}
      <div role="tablist" aria-label={t("compare.title")} className="flex gap-1 overflow-x-auto lg:hidden">
        {group.panes.map((pane, index) => (
          <button
            key={pane.threadId}
            type="button"
            role="tab"
            aria-selected={index === active}
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === "Home" ? 0 : event.key === "End" ? group.panes.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + group.panes.length) % group.panes.length;
              setActive(next);
              const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role=tab]");
              tabs?.[next]?.focus();
            }}
            className={cn(
              "focus-visible:outline-ring flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs",
              index === active ? "bg-muted font-medium" : "text-muted-foreground",
            )}
          >
            <span className={cn("size-1.5 rounded-full", running.has(pane.threadId) ? "bg-primary animate-pulse" : "bg-muted-foreground/50")} />
            {pane.modelName}
          </button>
        ))}
      </div>

      <div className={cn("grid min-h-0 flex-1 gap-3", group.panes.length >= 3 ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
        {group.panes.map((pane, index) => (
          <ComparePane
            key={pane.threadId}
            pane={pane}
            effort={efforts[pane.threadId]}
            active={index === active}
            autoSend={autoPrompt}
            onRegister={register}
            onStatus={onStatus}
            onNeedsAnswer={onNeedsAnswer}
            onAutoSent={onAutoSent}
            onPromote={openAsChat}
            onDeleteComparison={() => setConfirmDelete(true)}
          />
        ))}
      </div>

      <div className="flex shrink-0 flex-col gap-1">
        {anyUnanswered && !anyRunning && <p className="text-muted-foreground text-xs">{t("compare.unansweredRetry")}</p>}
        <div className="flex items-end gap-2">
          <Textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={t("compare.sendToAll")}
            aria-label={t("compare.sendToAll")}
            rows={2}
            className="min-h-10 flex-1"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const mod = settings?.keyboard?.sendWith === "modEnter";
              const send = event.key === "Enter" && (mod ? event.metaKey || event.ctrlKey : !event.shiftKey && !event.metaKey && !event.ctrlKey);
              if (!send) return;
              event.preventDefault();
              sendAll();
            }}
          />
          {anyUnanswered && !anyRunning ? (
            <Button
              type="button"
              className="pointer-coarse:min-h-11"
              onClick={() => {
                for (const pane of group.panes) controls.current.get(pane.threadId)?.retry();
              }}
            >
              {t("compare.retry")}
            </Button>
          ) : (
            <Button type="button" className="pointer-coarse:min-h-11" disabled={!value.trim() || anyRunning} onClick={sendAll}>
              <SendIcon /> {anyRunning ? t("compare.sending") : t("compare.sendToAll")}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={confirmPromote !== null} onOpenChange={(open) => !open && setConfirmPromote(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("compare.openAsChatConfirm")}</DialogTitle>
            <DialogDescription>{t("compare.promoteEndsGroup")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmPromote(null)}>
              {t("compare.cancel")}
            </Button>
            <Button disabled={!confirmPromote} onClick={() => confirmPromote && void finishPromote(confirmPromote)}>
              {t("compare.openChat")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("compare.deleteConfirm")}</DialogTitle>
            <DialogDescription>{t("compare.deleteConfirmBody", { count: group.panes.length })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              {t("compare.cancel")}
            </Button>
            <Button variant="destructive" disabled={deleting || anyRunning} onClick={() => void doDelete()}>
              {deleting ? t("compare.deleting") : t("compare.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** `/compare`: two or three hidden chats answering one prompt side by side. */
export function ComparePage() {
  const group = useCompare((s) => s.group);
  const loading = useCompare((s) => s.loading);
  const error = useCompare((s) => s.error);
  const reset = useCompare((s) => s.reset);
  const [autoPrompt, setAutoPrompt] = useState<string | null>(null);

  if (loading && !group) {
    return (
      <p role="status" className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-8 text-sm">
        <Loader2Icon className="animate-spin motion-reduce:animate-none" /> {t("common.loading")}
      </p>
    );
  }
  if (error && !group) {
    return (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-sm">
        <p>{t(error)}</p>
        <Button variant="outline" onClick={reset}>
          {t("compare.retryLoad")}
        </Button>
      </div>
    );
  }
  if (!group) return <CompareSetup onStarted={(prompt) => setAutoPrompt(prompt)} />;
  return <CompareRun key={group.id} autoPrompt={autoPrompt} clearAutoPrompt={() => setAutoPrompt(null)} />;
}
