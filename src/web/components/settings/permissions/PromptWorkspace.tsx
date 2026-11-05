import { RotateCcwIcon, SearchIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { Subject } from "@shared/permissions";
import type { PromptKey } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import {
  effectivePromptText,
  promptDraftFor,
  promptLayers,
  serverPromptFor,
  usePermissions,
  type PermissionsState,
} from "@/state/permissions";
import { MAX_PROMPT_RULE_CHARS } from "@shared/permissions";
import { applyPromptLayer, estimateTokens, nextPromptDraft } from "@/state/permissions-draft";
import type { PolicyFilter } from "@/state/permissions-query";
import { ChoiceGroup } from "./Shared";
import { cn } from "@/lib/utils";

// Prompt overrides for one subject and model scope. The inherited text is read-only; the editor only
// changes this destination, keeps drafts in memory, and never renders prompt text as HTML.

export function PromptWorkspace({ subject, modelRef, filter }: { subject: Subject; modelRef: string | null; filter: PolicyFilter }) {
  const state = usePermissions();
  const [selected, setSelected] = useState<PromptKey | null>(null);
  const [query, setQuery] = useState("");
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const serverMode = subject.kind === "everyone" && modelRef === null;
  const prompts = useMemo(() => state.subjects["everyone:"]?.serverPrompts ?? [], [state.subjects]);
  const overriddenFor = (key: PromptKey) =>
    serverMode ? serverPromptFor(state, key).baseline !== null : promptDraftFor(state, subject, modelRef, key).baseline !== null;
  const shown = prompts
    .filter((prompt) => !query.trim() || `${prompt.label} ${prompt.key}`.toLowerCase().includes(query.trim().toLowerCase()))
    .filter((prompt) => filter === "all" || (filter === "overridden" ? overriddenFor(prompt.key) : filter === "inherited" ? !overriddenFor(prompt.key) : true));
  const activeKey = selected && prompts.some((prompt) => prompt.key === selected) ? selected : (shown[0]?.key ?? prompts[0]?.key ?? null);

  if (!prompts.length) {
    return <p className="text-muted-foreground px-4 py-6 text-sm">{t("permissions.stateLoading")}</p>;
  }
  if (!activeKey) return <p className="text-muted-foreground px-4 py-6 text-sm">{t("permissions.stateEmpty")}</p>;

  const prompt = serverMode ? serverPromptFor(state, activeKey) : null;
  const draft = serverMode ? null : promptDraftFor(state, subject, modelRef, activeKey);
  const inherited = serverMode ? (prompt!.baseline ?? prompt!.defaultText) : effectivePromptText(state, subject, modelRef, activeKey);
  const overridden = overriddenFor(activeKey);
  const activePrompt = prompts.find((item) => item.key === activeKey)!;

  const localRule = serverMode ? null : draft!.draft;
  const localText = serverMode ? (prompt!.draft ?? prompt!.defaultText) : (localRule?.text ?? "");
  const editMode = serverMode ? (prompt!.draft === null ? "serverDefault" : "replace") : (localRule?.mode ?? "inherit");
  const baseWithoutThisDestination = serverMode
    ? (prompt!.baseline ?? prompt!.defaultText)
    : effectiveWithoutDestination(state, subject, modelRef, activeKey);
  const preview = serverMode
    ? (prompt!.draft ?? prompt!.defaultText)
    : applyPromptLayer(baseWithoutThisDestination, localRule);
  const unknown = [...preview.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).filter((name) => !activePrompt.placeholders.includes(name));

  const setMode = (mode: string) => {
    if (serverMode) {
      if (mode === "serverDefault") usePermissions.getState().resetServerPrompt(activeKey);
      else usePermissions.getState().editServerPrompt(activeKey, inherited);
      return;
    }
    if (mode === "inherit") usePermissions.getState().resetPrompt(subject, modelRef, activeKey);
    else usePermissions.getState().editPrompt(subject, modelRef, activeKey, nextPromptDraft(draft!.baseline, mode as "replace" | "append", localText));
  };

  const setText = (text: string) => {
    if (serverMode) usePermissions.getState().editServerPrompt(activeKey, text);
    else usePermissions.getState().editPrompt(subject, modelRef, activeKey, { mode: localRule?.mode ?? "replace", text });
  };

  const insert = (name: string) => {
    const element = textarea.current;
    const token = `{${name}}`;
    if (!element) {
      setText(localText + token);
      return;
    }
    const start = element.selectionStart ?? localText.length;
    const end = element.selectionEnd ?? start;
    setText(localText.slice(0, start) + token + localText.slice(end));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="grid min-w-0 gap-4 p-4 lg:grid-cols-[minmax(13rem,18rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="relative">
          <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" aria-hidden />
          <Input aria-label={t("permissions.search")} placeholder={t("permissions.search")} value={query} onChange={(event) => setQuery(event.currentTarget.value)} className="h-8 pl-8" />
        </div>
        <div className="bg-muted/40 flex max-h-[32rem] flex-col overflow-y-auto rounded-lg border p-1" role="listbox" aria-label={t("permissions.promptTitle")}>
          {shown.map((item) => {
            const hasOverride = serverMode
              ? serverPromptFor(state, item.key).baseline !== null
              : promptDraftFor(state, subject, modelRef, item.key).baseline !== null;
            return (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={item.key === activeKey}
                onClick={() => setSelected(item.key)}
                className={cn(
                  "hover:bg-accent flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-(--motion-fast) pointer-coarse:min-h-11",
                  item.key === activeKey && "depth-row-active",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {hasOverride && <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">{t("permissions.promptOverridden")}</span>}
              </button>
            );
          })}
          {!shown.length && <p className="text-muted-foreground px-2 py-2 text-xs">{t("permissions.stateEmpty")}</p>}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {activePrompt.label}
            {overridden && <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">{t("permissions.promptOverridden")}</span>}
          </h3>
          <p className="text-muted-foreground text-xs">{activePrompt.description}</p>
        </div>

        <section className="flex flex-col gap-1">
          <p className="text-xs font-medium">{t("permissions.promptInherited")}</p>
          <pre className="bg-muted/40 max-h-48 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap break-words">{inherited || t("permissions.promptEmptyText")}</pre>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <ChoiceGroup
            label={t("permissions.promptMode")}
            value={editMode}
            onChange={setMode}
            options={
              serverMode
                ? [
                    { value: "serverDefault", label: t("permissions.promptServerDefault") },
                    { value: "replace", label: t("permissions.promptReplace") },
                  ]
                : [
                    { value: "inherit", label: t("permissions.valueInherit") },
                    { value: "append", label: t("permissions.promptAppend") },
                    { value: "replace", label: t("permissions.promptReplace") },
                  ]
            }
          />
          {(serverMode ? prompt!.baseline !== null : draft!.baseline !== null) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => (serverMode ? usePermissions.getState().resetServerPrompt(activeKey) : usePermissions.getState().resetPrompt(subject, modelRef, activeKey))}
            >
              <RotateCcwIcon /> {t("permissions.reset")}
            </Button>
          )}
        </div>

        {editMode !== "inherit" && editMode !== "serverDefault" && (
          <>
            <Textarea
              ref={textarea}
              aria-label={activePrompt.label}
              className="min-h-64 font-mono text-base md:text-sm"
              maxLength={MAX_PROMPT_RULE_CHARS}
              value={localText}
              onChange={(event) => setText(event.currentTarget.value)}
              spellCheck={false}
            />
            <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
              <span>{t("permissions.promptCharacters", { count: formatNumber(localText.length), max: formatNumber(MAX_PROMPT_RULE_CHARS) })}</span>
              <span>{t("permissions.promptTokens", { count: formatNumber(estimateTokens(localText)) })}</span>
            </div>
            {activePrompt.placeholders.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground text-xs">{t("permissions.promptPlaceholders")}</span>
                {activePrompt.placeholders.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => insert(name)}
                    className="bg-muted focus-visible:outline-ring rounded px-1.5 py-0.5 font-mono text-[11px] outline-none hover:bg-accent"
                  >
                    {`{${name}}`}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <section className="flex flex-col gap-1">
          <p className="text-xs font-medium">{t("permissions.promptPreview")}</p>
          <pre className="bg-muted/40 max-h-72 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap break-words">{preview || t("permissions.promptEmptyText")}</pre>
          <p className="text-muted-foreground text-[11px]">{t("permissions.promptApproximate")}</p>
          {unknown.length > 0 && (
            <p className="text-warning text-[11px]">{t("permissions.promptUnknownPlaceholder", { names: [...new Set(unknown)].map((name) => `{${name}}`).join(", ") })}</p>
          )}
        </section>
      </div>
    </div>
  );
}

/** The inherited prompt with the destination being edited removed, so the draft preview does not duplicate it. */
function effectiveWithoutDestination(
  state: PermissionsState,
  subject: Subject,
  modelRef: string | null,
  key: PromptKey,
): string {
  const prompt = state.subjects["everyone:"]?.serverPrompts?.find((item) => item.key === key);
  const layers = promptLayers(state, modelRef, key).filter(
    (layer) => !(layer.subject.kind === subject.kind && layer.subject.id === subject.id && layer.modelRef === modelRef),
  );
  const groupIds = subject.kind === "user" ? (state.bootstrap?.subjects.groups.filter((group) => group.userIds.includes(subject.id)).map((group) => group.id) ?? []) : subject.kind === "group" ? [subject.id] : [];
  const order = new Map((state.bootstrap?.subjects.groups ?? []).map((group) => [group.id, group.promptOrder ?? 0]));
  // Reuse the same algorithm with the current destination filtered out.
  let text = prompt?.value ?? prompt?.defaultValue ?? "";
  const rank = (kind: string) => (kind === "everyone" ? 0 : kind === "group" ? 1 : 2);
  const relevant = layers
    .filter((layer) => layer.subject.kind === "everyone" || (layer.subject.kind === "user" ? subject.kind === "user" && layer.subject.id === subject.id : groupIds.includes(layer.subject.id)))
    .sort((a, b) => rank(a.subject.kind) - rank(b.subject.kind) || (a.subject.kind === "group" ? (order.get(a.subject.id) ?? -1) - (order.get(b.subject.id) ?? -1) : 0) || Number(a.modelRef !== null) - Number(b.modelRef !== null));
  for (const layer of relevant) text = applyPromptLayer(text, layer.rule);
  return text;
}
