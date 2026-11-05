import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { Loader2Icon } from "lucide-react";
import { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import { parsePromptVariables, renderPromptTemplate, searchSavedPrompts } from "@shared/saved-prompts";
import { ScrollArea } from "@/components/ui/scroll-area";
import { t } from "@/i18n";
import { compareText } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { useSavedPrompts, loadSavedPrompts } from "@/state/saved-prompts";
import { useData } from "@/state/data";
import { openFill, type PromptInsertTarget } from "@/state/prompt-picker";
import { insertPromptText } from "./prompt-insert";
import { slashTokenAt, slashTokenKey } from "./prompt-slash";

// The main composer input with a personal-prompt slash menu. The menu only appears when the whole input is
// `/` plus a shortcut fragment, so URLs, paths, and prose never open it. See docs/implementation/saved-prompts.md.

type Props = ComponentProps<typeof ComposerPrimitive.Input>;

// An empty or failed library must not leave an empty bordered popup; normal typing/sending stays untouched.
const rowsWouldShow = (rows: number, loading: boolean, loaded: boolean, failed: boolean) => rows > 0 || loading || (loaded && !failed);

/** A template can be 20k characters; a one-line row renders only its beginning. */
const preview = (text: string) => [...text].slice(0, 160).join("");

export const PromptSlashInput = forwardRef<HTMLTextAreaElement, Props>(function PromptSlashInput(
  { onChange, onSelect, onKeyDown, onCompositionStart, onCompositionEnd, ...rest },
  forwardedRef,
) {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const threadKey = useAuiState((s) => s.threadListItem.id);
  const accountId = useData((s) => s.me?.id);
  const prompts = useSavedPrompts((s) => s.prompts);
  const loaded = useSavedPrompts((s) => s.loaded);
  const loading = useSavedPrompts((s) => s.loading);
  const loadFailed = useSavedPrompts((s) => s.error);
  const composing = useRef(false);
  const [selection, setSelection] = useState({ start: text.length, end: text.length });
  const [active, setActive] = useState(0);
  const [suppressed, setSuppressed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const setRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (typeof forwardedRef === "function") forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    },
    [forwardedRef],
  );

  const slash = slashTokenAt(text, selection.start, selection.end, composing.current);
  const tokenKey = slashTokenKey(text, selection.start);
  const open = !!slash && suppressed !== tokenKey;
  const rows = useMemo(
    () => (slash && open ? searchSavedPrompts(prompts, slash.query, compareText).slice(0, 8) : []),
    [prompts, slash?.query, open],
  );
  const menuOpen = open && rowsWouldShow(rows.length, loading, loaded, loadFailed);
  const activeIndex = rows.length === 0 ? 0 : Math.min(active, rows.length - 1);

  useEffect(() => {
    if (!slash) return;
    void loadSavedPrompts();
  }, [slash?.query]);

  // A new query starts at the first result.
  useEffect(() => {
    setActive(0);
  }, [slash?.query]);

  // A switched chat starts with ordinary typing, not a suppression or notice from the previous chat.
  useEffect(() => {
    setSuppressed(null);
    setNotice(null);
  }, [threadKey]);

  // Keyboard navigation keeps the active row inside the popup's own scroll area.
  useEffect(() => {
    if (!menuOpen || rows.length === 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, rows.length, activeIndex]);

  const choose = (promptId: string) => {
    const prompt = prompts.find((p) => p.id === promptId);
    if (!prompt || !slash) return;
    const target: PromptInsertTarget = { kind: "replace", threadKey, text, ...(accountId && { accountId }) };
    setSuppressed(tokenKey);
    if (parsePromptVariables(prompt.body).length === 0) {
      const outcome = insertPromptText(aui, renderPromptTemplate(prompt.body, {}), target, threadKey, accountId);
      setNotice(outcome === "changed" ? t("savedPrompts.composerChanged") : null);
      return;
    }
    // The fill view keeps the captured target; a chat switch or edited text aborts the replacement.
    setNotice(null);
    openFill(prompt, target);
  };

  const readSelection = (element: HTMLTextAreaElement) => {
    const start = element.selectionStart ?? element.value.length;
    // Any text or caret change ends Escape's suppression, even if the caret later returns to the same spot.
    setSuppressed((current) => (current && current !== slashTokenKey(element.value, start) ? null : current));
    setSelection({ start, end: element.selectionEnd ?? element.value.length });
  };

  return (
    <div className="relative">
      <ComposerPrimitive.Input
        {...rest}
        ref={setRef}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? listId : undefined}
        aria-activedescendant={menuOpen && rows.length > 0 ? optionId(activeIndex) : undefined}
        onChange={(event) => {
          onChange?.(event);
          readSelection(event.currentTarget);
          setNotice(null);
        }}
        onSelect={(event) => {
          onSelect?.(event);
          readSelection(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (menuOpen && slash) {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length > 0) {
              event.preventDefault();
              setActive((current) => (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
              return;
            }
            if (event.key === "Enter" && rows.length > 0) {
              // Enter inserts the prompt and never sends the slash token.
              event.preventDefault();
              event.stopPropagation();
              choose(rows[activeIndex]!.id);
              return;
            }
            if (event.key === "Escape") {
              // Escape closes this menu only; the composer keeps its text and the next Escape is ordinary.
              event.preventDefault();
              event.stopPropagation();
              setSuppressed(tokenKey);
              return;
            }
            if (event.key === "Tab") {
              // Focus follows the normal order; nothing is inserted.
              setSuppressed(tokenKey);
            }
          }
          onKeyDown?.(event);
        }}
        onCompositionStart={(event) => {
          composing.current = true;
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onCompositionEnd?.(event);
          readSelection(event.currentTarget);
        }}
      />
      {notice && (
        <p role="status" className="text-warning px-2.5 pb-1 text-xs">
          {notice}
        </p>
      )}
      {menuOpen && slash && (
        <div
          id={listId}
          role="listbox"
          aria-label={t("savedPrompts.title")}
          className="dropdown-glass text-popover-foreground absolute bottom-full left-0 z-30 mb-2 w-full overflow-hidden rounded-xl border depth-float"
        >
          {rows.length > 0 ? (
            <ScrollArea className="max-h-64" viewportClassName="p-1">
              {rows.map((prompt, index) => (
                <button
                  key={prompt.id}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(prompt.id)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-start transition-colors duration-(--motion-instant) ease-out-quart",
                    index === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate font-medium">{prompt.name}</span>
                    <span className="text-muted-foreground shrink-0 font-mono text-[11px]">/{prompt.shortcut}</span>
                  </span>
                  <span className="text-muted-foreground line-clamp-1 text-xs">{preview(prompt.body)}</span>
                </button>
              ))}
            </ScrollArea>
          ) : loading ? (
            <p role="status" className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
              <Loader2Icon className="size-3.5 animate-spin" />
              {t("common.loading")}
            </p>
          ) : loaded && !loadFailed ? (
            <p role="status" className="text-muted-foreground px-3 py-2 text-xs">
              {t("savedPrompts.noMatches")}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
});
