import { useAui, useAuiState } from "@assistant-ui/react";
import { Loader2Icon, PencilIcon, PlusIcon, SearchIcon, SquareSlashIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { McpPromptInfo } from "@shared/types";
import {
  MAX_EXPANDED_PROMPT,
  MAX_PROMPT_BODY,
  MAX_PROMPT_VARIABLES,
  MAX_SAVED_PROMPTS,
  checkSavedPromptWrite,
  expandedWithinLimits,
  normalizeShortcut,
  parsePromptVariables,
  renderPromptTemplate,
  searchSavedPrompts,
  type SavedPrompt,
  type SavedPromptProblem,
  type SavedPromptWrite,
} from "@shared/saved-prompts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { compareText, formatList } from "@/i18n/format";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { insertPromptText } from "./prompt-insert";
import { useData } from "@/state/data";
import {
  createSavedPrompt,
  deleteSavedPrompt,
  loadSavedPrompts,
  updateSavedPrompt,
  useSavedPrompts,
} from "@/state/saved-prompts";
import { closePromptPicker, openExternal, openFill, usePromptPicker } from "@/state/prompt-picker";

// The combined prompt dialog: personal saved prompts, external server prompts, the library editor, and the
// variable fill view. One instance serves the toolbar, the plus menu, the slash menu, and the commands.

interface EditorDraft extends SavedPromptWrite {
  id?: string;
  revision?: number;
}

type DiscardIntent = "close" | "editor";

/** A template can be 20k characters; a list row renders only its beginning. */
const preview = (text: string) => [...text].slice(0, 160).join("");

const problemText = (problem: SavedPromptProblem): string | null => {
  switch (problem) {
    case "invalidShortcut":
      return t("savedPrompts.invalidShortcut");
    case "bodyTooLong":
      return t("savedPrompts.bodyTooLong", { count: MAX_PROMPT_BODY });
    case "tooManyVariables":
      return t("savedPrompts.tooManyVariables", { count: MAX_PROMPT_VARIABLES });
    default:
      return null;
  }
};

export function SavedPromptsDialog() {
  const aui = useAui();
  const threadKey = useAuiState((s) => s.threadListItem.id);
  const accountId = useData((s) => s.me?.id);
  const open = usePromptPicker((s) => s.open);
  const view = usePromptPicker((s) => s.view);
  const fill = usePromptPicker((s) => s.fill);
  const external = usePromptPicker((s) => s.external);
  const target = usePromptPicker((s) => s.target);
  const showPicker = usePromptPicker((s) => s.showPicker);
  const showManager = usePromptPicker((s) => s.showManager);

  const prompts = useSavedPrompts((s) => s.prompts);
  const loaded = useSavedPrompts((s) => s.loaded);
  const loading = useSavedPrompts((s) => s.loading);
  const loadError = useSavedPrompts((s) => s.error);
  const mcpPrompts = useData((s) => s.mcpPrompts);
  const refreshMcpPrompts = useData((s) => s.refreshMcpPrompts);

  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [editorOrigin, setEditorOrigin] = useState<"picker" | "manage">("manage");
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<DiscardIntent | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [externalValues, setExternalValues] = useState<Record<string, string>>({});
  const [externalBusy, setExternalBusy] = useState(false);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const [fillTouched, setFillTouched] = useState(false);
  const [composerChanged, setComposerChanged] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadSavedPrompts();
    if (mcpPrompts.length === 0) void refreshMcpPrompts();
    // The dialog is the only surface that keeps a list fresh; a shared GET is reused while one is in flight.
    const onFocus = () => void loadSavedPrompts(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, mcpPrompts.length, refreshMcpPrompts]);

  // A closing dialog discards local draft state; reopening starts clean.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setEditor(null);
    setDirty(false);
    setConfirmDiscard(null);
    setDeleting(null);
    setFieldError(null);
    setConflict(false);
    setNotice(null);
    setExternalValues({});
    setExternalError(null);
    setFillValues({});
    setFillTouched(false);
    setComposerChanged(false);
  }, [open]);

  useEffect(() => {
    setFillValues({});
    setFillTouched(false);
    setComposerChanged(false);
  }, [fill?.id]);

  useEffect(() => {
    setExternalValues({});
    setExternalError(null);
    setComposerChanged(false);
  }, [external]);

  const insert = (expanded: string): boolean => {
    const outcome = insertPromptText(aui, expanded, target, threadKey, accountId);
    if (outcome === "changed") {
      setComposerChanged(true);
      return false;
    }
    closePromptPicker();
    return true;
  };

  const startCreate = (origin: "picker" | "manage") => {
    setEditor({ name: "", shortcut: "", body: "" });
    setEditorOrigin(origin);
    setDirty(false);
    setFieldError(null);
    setConflict(false);
    setNotice(null);
  };

  const startEdit = (prompt: SavedPrompt) => {
    setEditor({ id: prompt.id, name: prompt.name, shortcut: prompt.shortcut, body: prompt.body, revision: prompt.revision });
    setEditorOrigin("manage");
    setDirty(false);
    setFieldError(null);
    setConflict(false);
    setNotice(null);
  };

  const requestEditorExit = () => {
    if (dirty) setConfirmDiscard("editor");
    else {
      setEditor(null);
      setFieldError(null);
      setConflict(false);
    }
  };

  const requestClose = () => {
    if (confirmDiscard) {
      setConfirmDiscard(null);
      return;
    }
    if (editor && dirty) setConfirmDiscard("close");
    else closePromptPicker();
  };

  const discard = () => {
    const intent = confirmDiscard;
    setConfirmDiscard(null);
    if (intent === "editor") {
      setEditor(null);
      setDirty(false);
      setFieldError(null);
      setConflict(false);
    } else {
      closePromptPicker();
    }
  };

  const chooseSaved = (prompt: SavedPrompt) => {
    setComposerChanged(false);
    if (parsePromptVariables(prompt.body).length === 0) {
      // Escapes still expand: `\{{name}}` becomes literal `{{name}}`.
      insert(renderPromptTemplate(prompt.body, {}));
    } else {
      openFill(prompt, target);
    }
  };

  const chooseExternal = async (prompt: McpPromptInfo) => {
    setExternalError(null);
    setComposerChanged(false);
    if (prompt.arguments.length) {
      openExternal(prompt, target);
      return;
    }
    try {
      const { text } = await api<{ text: string }>(`/mcp/${encodeURIComponent(prompt.serverId)}/prompts`, { method: "POST", json: { name: prompt.name, arguments: {} } });
      insert(text);
    } catch (cause) {
      setExternalError(cause instanceof ApiError ? cause.message : t("savedPrompts.saveError"));
    }
  };

  const submitExternal = async (prompt: McpPromptInfo) => {
    setExternalBusy(true);
    setExternalError(null);
    try {
      const args = Object.fromEntries(Object.entries(externalValues).filter(([, value]) => value.trim()));
      const { text } = await api<{ text: string }>(`/mcp/${encodeURIComponent(prompt.serverId)}/prompts`, { method: "POST", json: { name: prompt.name, arguments: args } });
      insert(text);
    } catch (cause) {
      setExternalError(cause instanceof ApiError ? cause.message : t("savedPrompts.saveError"));
    } finally {
      setExternalBusy(false);
    }
  };

  const save = async () => {
    if (!editor) return;
    const result = checkSavedPromptWrite(editor);
    if (!result.ok) return;
    setSaving(true);
    setFieldError(null);
    setConflict(false);
    setNotice(null);
    try {
      if (editor.id) {
        await updateSavedPrompt(editor.id, result.value, editor.revision ?? 1);
        setNotice(t("savedPrompts.saved"));
        setEditor(null);
        setDirty(false);
        showManager();
      } else {
        await createSavedPrompt(result.value);
        setNotice(t("savedPrompts.saved"));
        setEditor(null);
        setDirty(false);
        if (editorOrigin === "manage") showManager();
        else showPicker();
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        await loadSavedPrompts(true);
        const current = useSavedPrompts.getState().prompts;
        const owner = current.find((prompt) => prompt.shortcut === result.value.shortcut && prompt.id !== editor.id);
        if (owner) setFieldError(t("savedPrompts.shortcutTaken"));
        else if (!editor.id && current.length >= MAX_SAVED_PROMPTS) setFieldError(t("savedPrompts.limitReached", { count: MAX_SAVED_PROMPTS }));
        else setConflict(true);
      } else {
        setFieldError(t("savedPrompts.saveError"));
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (prompt: SavedPrompt) => {
    setFieldError(null);
    try {
      await deleteSavedPrompt(prompt.id, prompt.revision);
      setDeleting(null);
      setNotice(t("savedPrompts.deleted"));
      if (editor?.id === prompt.id) {
        setEditor(null);
        setDirty(false);
        showManager();
      }
    } catch (cause) {
      // Keep both the row and any editor content; the user can retry.
      if (cause instanceof ApiError && cause.status === 409) await loadSavedPrompts(true);
      setFieldError(t("savedPrompts.saveError"));
    }
  };

  const reloadStored = async () => {
    if (!editor?.id) return;
    setSaving(true);
    try {
      await loadSavedPrompts(true);
      const stored = useSavedPrompts.getState().prompts.find((prompt) => prompt.id === editor.id);
      if (stored) {
        setEditor({ id: stored.id, name: stored.name, shortcut: stored.shortcut, body: stored.body, revision: stored.revision });
        setDirty(false);
      }
      setConflict(false);
      setFieldError(null);
    } finally {
      setSaving(false);
    }
  };

  const keepEditing = () => {
    if (!editor?.id) {
      setConflict(false);
      return;
    }
    const stored = useSavedPrompts.getState().prompts.find((prompt) => prompt.id === editor.id);
    if (stored) setEditor({ ...editor, revision: stored.revision });
    setConflict(false);
  };

  const filtered = useMemo(
    () => searchSavedPrompts(prompts, query, compareText),
    [prompts, query],
  );
  const externalTerm = query.trim().toLowerCase();
  const externalFiltered = externalTerm
    ? mcpPrompts.filter((prompt) => (prompt.title ?? prompt.name).toLowerCase().includes(externalTerm) || prompt.server.toLowerCase().includes(externalTerm))
    : mcpPrompts;
  const externalServers = [...new Set(externalFiltered.map((prompt) => prompt.server))];

  const variables = fill ? parsePromptVariables(fill.body) : [];
  const filled = renderPromptTemplate(fill?.body ?? "", fillValues);
  const fillValid = variables.every((variable) => (fillValues[variable.name] ?? "").trim().length > 0);
  const fillTooLong = !expandedWithinLimits(filled);

  const checked = editor ? checkSavedPromptWrite(editor) : null;
  const problem = checked && !checked.ok ? checked.problem : null;
  const problemKey = problem ? problemText(problem) : null;

  const saveDisabled = !checked?.ok || saving;

  const title = editor
    ? editor.id
      ? t("savedPrompts.edit")
      : t("savedPrompts.create")
    : view === "fill" && fill
      ? t("savedPrompts.fillTitle", { name: fill.name })
      : view === "external" && external
        ? (external.title ?? external.name)
        : view === "manage"
          ? t("savedPrompts.manage")
          : t("savedPrompts.title");

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(next) => !next && requestClose()}>
      <DialogContent className="max-h-[min(85dvh,44rem)] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogTitle className="pe-6 text-base">{title}</DialogTitle>
        <DialogDescription className="sr-only">{t("savedPrompts.title")}</DialogDescription>

        {editor ? (
          <div className="flex min-h-0 flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">{t("savedPrompts.name")}</span>
              <Input
                value={editor.name}
                autoFocus
                disabled={saving}
                onChange={(event) => {
                  setEditor({ ...editor, name: event.target.value });
                  setDirty(true);
                  setFieldError(null);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">{t("savedPrompts.shortcut")}</span>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground font-mono text-sm">/</span>
                <Input
                  value={editor.shortcut}
                  className="font-mono"
                  disabled={saving}
                  onChange={(event) => {
                    setEditor({ ...editor, shortcut: normalizeShortcut(event.target.value) });
                    setDirty(true);
                    setFieldError(null);
                  }}
                />
              </div>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">{t("savedPrompts.body")}</span>
              <Textarea
                value={editor.body}
                rows={7}
                className="max-h-[40dvh] overflow-y-auto font-sans"
                disabled={saving}
                onChange={(event) => {
                  setEditor({ ...editor, body: event.target.value });
                  setDirty(true);
                  setFieldError(null);
                }}
              />
            </label>
            {parsePromptVariables(editor.body).length > 0 && (
              <p className="text-muted-foreground text-xs">
                {t("savedPrompts.variables", { names: formatList(parsePromptVariables(editor.body).map((variable) => variable.name)) })}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              {t("savedPrompts.variableHelp", { example: "{{topic}}" })} {t("savedPrompts.literalHelp", { example: "\\{{topic}}" })}
            </p>
            {problemKey && <p role="alert" className="text-error text-xs">{problemKey}</p>}
            {fieldError && <p role="alert" className="text-error text-xs">{fieldError}</p>}
            {conflict && (
              <div role="alert" className="border-warning/40 bg-warning/5 flex flex-col gap-2 rounded-lg border p-2 text-xs">
                <span>{t("savedPrompts.conflict")}</span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={keepEditing}>{t("savedPrompts.keepEditing")}</Button>
                  <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void reloadStored()}>{t("savedPrompts.reloadStored")}</Button>
                </div>
              </div>
            )}
            {confirmDiscard === "editor" && (
              <div role="alert" className="border-warning/40 bg-warning/5 flex flex-col gap-2 rounded-lg border p-2 text-xs">
                <span>{t("savedPrompts.discardChanges")}</span>
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDiscard(null)}>{t("savedPrompts.keepDraft")}</Button>
                  <Button type="button" size="sm" variant="outline" onClick={discard}>{t("savedPrompts.discard")}</Button>
                </div>
              </div>
            )}
            {notice && <p role="status" className="text-muted-foreground text-xs">{notice}</p>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2">
                {editor.id && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={saving}
                    onClick={() => setDeleting(editor.id ?? null)}
                  >
                    <Trash2Icon />
                    {t("common.delete")}
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" disabled={saving} onClick={requestEditorExit}>{t("common.cancel")}</Button>
                <Button type="button" disabled={saveDisabled} onClick={() => void save()}>
                  {saving && <Loader2Icon className="animate-spin" />}
                  {t("common.save")}
                </Button>
              </div>
            </div>
            {deleting && editor.id === deleting && (
              <div role="alert" className="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-lg border p-3 text-xs">
                <span>{t("savedPrompts.deleteConfirm", { name: editor.name })}</span>
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    onClick={() => {
                      const prompt = prompts.find((item) => item.id === editor.id);
                      if (prompt) void remove(prompt);
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : view === "fill" && fill ? (
          <div className="flex min-h-0 flex-col gap-3">
            <p className="text-muted-foreground text-xs">{t("savedPrompts.body")}</p>
            <ScrollArea className="max-h-[52dvh]" viewportClassName="pe-1">
              <div className="flex flex-col gap-2">
                {variables.map((variable, index) => {
                  const invalid = fillTouched && !(fillValues[variable.name] ?? "").trim();
                  return (
                    <label key={variable.name} className="flex flex-col gap-1 text-xs">
                      <span className="font-mono font-medium">{variable.name}</span>
                      <Textarea
                        autoFocus={index === 0}
                        rows={2}
                        value={fillValues[variable.name] ?? ""}
                        aria-invalid={invalid || undefined}
                        onChange={(event) => {
                          setFillValues({ ...fillValues, [variable.name]: event.target.value });
                          setFillTouched(true);
                        }}
                      />
                      {invalid && <span className="text-error">{t("savedPrompts.valueRequired")}</span>}
                    </label>
                  );
                })}
                <details className="text-xs">
                  <summary className="text-muted-foreground cursor-pointer select-none">{t("savedPrompts.preview")}</summary>
                  <pre className="bg-muted/50 mt-2 max-h-48 overflow-auto rounded-lg p-2 font-sans whitespace-pre-wrap">{filled}</pre>
                </details>
              </div>
            </ScrollArea>
            {fillTooLong && <p role="alert" className="text-error text-xs">{t("savedPrompts.expandedTooLong", { count: MAX_EXPANDED_PROMPT })}</p>}
            {composerChanged && <p role="alert" className="text-warning text-xs">{t("savedPrompts.composerChanged")}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={closePromptPicker}>{t("common.cancel")}</Button>
              <Button
                type="button"
                disabled={!fillValid || fillTooLong}
                onClick={() => {
                  setFillTouched(true);
                  if (fillValid && !fillTooLong) insert(filled);
                }}
              >
                {t("savedPrompts.insert")}
              </Button>
            </div>
          </div>
        ) : view === "external" && external ? (
          <form
            className="flex min-h-0 flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitExternal(external);
            }}
          >
            <p className="text-muted-foreground text-xs">{external.description ?? t("composer.promptFrom", { server: external.server })}</p>
            <ScrollArea className="max-h-[52dvh]" viewportClassName="pe-1">
              <div className="flex flex-col gap-2">
                {external.arguments.map((argument, index) => (
                  <label key={argument.name} className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">
                      {argument.name}
                      {argument.required && <span className="text-muted-foreground"> {t("composer.required")}</span>}
                    </span>
                    <Input
                      autoFocus={index === 0}
                      required={argument.required}
                      value={externalValues[argument.name] ?? ""}
                      onChange={(event) => setExternalValues({ ...externalValues, [argument.name]: event.target.value })}
                    />
                    {argument.description && <span className="text-muted-foreground">{argument.description}</span>}
                  </label>
                ))}
              </div>
            </ScrollArea>
            {externalError && <p role="alert" className="text-error text-xs">{externalError}</p>}
            {composerChanged && <p role="alert" className="text-warning text-xs">{t("savedPrompts.composerChanged")}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={showPicker}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={externalBusy}>
                {externalBusy && <Loader2Icon className="animate-spin" />}
                {t("savedPrompts.insert")}
              </Button>
            </div>
          </form>
        ) : view === "manage" ? (
          <div className="flex min-h-0 flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="sr-only">{t("savedPrompts.search")}</span>
              <span className="relative">
                <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("savedPrompts.search")} className="ps-8" />
              </span>
            </label>
            {notice && <p role="status" className="text-muted-foreground text-xs">{notice}</p>}
            {fieldError && <p role="alert" className="text-error text-xs">{fieldError}</p>}
            {loadError && !loaded ? (
              <div className="flex flex-col items-start gap-2 text-xs">
                <p className="text-error">{t("savedPrompts.loadError")}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void loadSavedPrompts(true)}>{t("common.retry")}</Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-start gap-3 py-4">
                <p className="text-muted-foreground text-sm">{query.trim() ? t("savedPrompts.noMatches") : t("savedPrompts.empty")}</p>
                <Button type="button" size="sm" onClick={() => startCreate("manage")} disabled={prompts.length >= MAX_SAVED_PROMPTS}>
                  <PlusIcon />
                  {t("savedPrompts.create")}
                </Button>
                {prompts.length >= MAX_SAVED_PROMPTS && <p className="text-muted-foreground text-xs">{t("savedPrompts.limitReached", { count: MAX_SAVED_PROMPTS })}</p>}
              </div>
            ) : (
              <ScrollArea className="max-h-[52dvh]" viewportClassName="pe-1">
                <div className="flex flex-col gap-1">
                  {filtered.map((prompt) => (
                    <div key={prompt.id} className="flex flex-col gap-1 rounded-lg p-1">
                      <div className="flex items-start gap-1">
                        <div className="min-w-0 flex-1 px-1.5 py-1">
                          <p className="truncate text-sm font-medium">{prompt.name}</p>
                          <p className="text-muted-foreground truncate font-mono text-[11px]">/{prompt.shortcut}</p>
                        </div>
                        <Button type="button" size="icon-sm" variant="ghost" className="pointer-coarse:size-9" aria-label={t("savedPrompts.edit")} onClick={() => startEdit(prompt)}>
                          <PencilIcon />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="text-destructive pointer-coarse:size-9"
                          aria-label={t("common.delete")}
                          onClick={() => setDeleting(prompt.id)}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                      {deleting === prompt.id && (
                        <div role="alert" className="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-lg border p-2 text-xs">
                          <span>{t("savedPrompts.deleteConfirm", { name: prompt.name })}</span>
                          <div className="flex justify-end gap-2">
                            <Button type="button" size="sm" variant="ghost" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
                            <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={() => void remove(prompt)}>{t("common.delete")}</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
            <div className="flex flex-wrap justify-between gap-2">
              <Button type="button" variant="ghost" onClick={showPicker}>{t("common.close")}</Button>
              <Button type="button" onClick={() => startCreate("manage")} disabled={prompts.length >= MAX_SAVED_PROMPTS}>
                <PlusIcon />
                {t("savedPrompts.create")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="sr-only">{t("savedPrompts.search")}</span>
              <span className="relative">
                <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("savedPrompts.search")} className="ps-8" />
              </span>
            </label>
            {notice && <p role="status" className="text-muted-foreground text-xs">{notice}</p>}
            {externalError && <p role="alert" className="text-error text-xs">{externalError}</p>}
            {composerChanged && <p role="alert" className="text-warning text-xs">{t("savedPrompts.composerChanged")}</p>}
            <ScrollArea className="max-h-[56dvh]" viewportClassName="pe-1">
              <section className="mb-3">
                <h3 className="text-muted-foreground px-1 pb-1 text-xs font-medium">{t("savedPrompts.savedSection")}</h3>
                {loadError && !loaded ? (
                  <div className="flex flex-col items-start gap-2 px-1 pb-2 text-xs">
                    <p className="text-error">{t("savedPrompts.loadError")}</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => void loadSavedPrompts(true)}>{t("common.retry")}</Button>
                  </div>
                ) : loading && !loaded ? (
                  <p className="text-muted-foreground flex items-center gap-2 px-1 py-2 text-xs">
                    <Loader2Icon className="size-3.5 animate-spin" />
                    {t("common.loading")}
                  </p>
                ) : filtered.length === 0 ? (
                  <div className="flex flex-col items-start gap-2 px-1 pb-2">
                    <p className="text-muted-foreground text-sm">{query.trim() ? t("savedPrompts.noMatches") : t("savedPrompts.empty")}</p>
                    {!query.trim() && (
                      <Button type="button" size="sm" variant="outline" onClick={() => startCreate("picker")} disabled={prompts.length >= MAX_SAVED_PROMPTS}>
                        <PlusIcon />
                        {t("savedPrompts.create")}
                      </Button>
                    )}
                    {prompts.length >= MAX_SAVED_PROMPTS && <p className="text-muted-foreground text-xs">{t("savedPrompts.limitReached", { count: MAX_SAVED_PROMPTS })}</p>}
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {filtered.map((prompt) => (
                      <button
                        key={prompt.id}
                        type="button"
                        onClick={() => chooseSaved(prompt)}
                        className="hover:bg-accent focus-visible:bg-accent flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-start outline-none transition-colors duration-(--motion-fast) ease-out-quart"
                      >
                        <span className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="truncate font-medium">{prompt.name}</span>
                          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">/{prompt.shortcut}</span>
                        </span>
                        <span className="text-muted-foreground line-clamp-1 text-xs">{preview(prompt.body)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
              {externalServers.length > 0 && (
                <section className="flex flex-col gap-2">
                  {externalServers.map((server) => (
                    <div key={server}>
                      <h3 className="text-muted-foreground px-1 pb-1 text-xs font-medium">{t("savedPrompts.externalSection", { server })}</h3>
                      <div className="flex flex-col gap-0.5">
                        {externalFiltered
                          .filter((prompt) => prompt.server === server)
                          .map((prompt) => (
                            <button
                              key={`${prompt.serverId}:${prompt.name}`}
                              type="button"
                              onClick={() => void chooseExternal(prompt)}
                              className="hover:bg-accent focus-visible:bg-accent flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-start outline-none transition-colors duration-(--motion-fast) ease-out-quart"
                            >
                              <span className="truncate text-sm">{prompt.title ?? prompt.name}</span>
                              {prompt.description && <span className="text-muted-foreground line-clamp-1 text-xs">{prompt.description}</span>}
                            </button>
                          ))}
                      </div>
                    </div>
                  ))}
                </section>
              )}
            </ScrollArea>
            <div className="flex flex-wrap justify-between gap-2">
              <Button type="button" variant="ghost" onClick={showManager}>
                <SquareSlashIcon />
                {t("savedPrompts.manage")}
              </Button>
              <Button type="button" onClick={() => startCreate("picker")} disabled={prompts.length >= MAX_SAVED_PROMPTS}>
                <PlusIcon />
                {t("savedPrompts.create")}
              </Button>
            </div>
          </div>
        )}

        {confirmDiscard === "close" && (
          <div role="alert" className="border-warning/40 bg-warning/5 flex flex-col gap-2 rounded-lg border p-3 text-xs">
            <span>{t("savedPrompts.discardChanges")}</span>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDiscard(null)}>{t("savedPrompts.keepDraft")}</Button>
              <Button type="button" size="sm" variant="outline" onClick={discard}>{t("savedPrompts.discard")}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
