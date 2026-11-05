import { ActionBarMorePrimitive, TextMessagePartProvider } from "@assistant-ui/react";
import { CheckIcon, CopyIcon, EyeOffIcon, LanguagesIcon, Loader2Icon, RotateCwIcon } from "lucide-react";
import { useState } from "react";
import { MAX_TRANSLATION_SOURCE_CHARS } from "@shared/message-translations";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { currentLocale, t } from "@/i18n";
import { formatLanguageName } from "@/i18n/format";
import { useCommand } from "@/keyboard/registry";
import { ApiError } from "@/lib/api";
import { errorText } from "@/lib/error-text";
import { editKey, useMessageEdits } from "@/state/message-edits";
import {
  cancelTranslation,
  hideTranslation,
  lastTranslationLang,
  preferredTranslationTarget,
  translateMessage,
  useMessageTranslations,
} from "@/state/message-translations";
import { useData } from "@/state/data";
import { useTranslationDialog } from "@/state/translation-dialog";
import { focusedMessageId, useTranslationGate } from "./annotation-gates";

const MENU_ITEM =
  "aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors duration-(--motion-fast) ease-out-quart select-none disabled:opacity-50";

const useTargetLanguage = () => useData((s) => s.settings?.translationTarget) ?? currentLocale();

/** "Translate to …" in either message's More menu. Disabled with the reason when the gate blocks it. */
export function TranslationMenuItem({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const gate = useTranslationGate(threadId, messageId);
  const language = useTargetLanguage();
  const label = gate.available ? t("translation.menuTranslate", { language: formatLanguageName(language) }) : t(gate.reason ?? "annotations.busy");
  return (
    <ActionBarMorePrimitive.Item
      disabled={!gate.available}
      title={!gate.available && gate.reason ? t(gate.reason) : undefined}
      onClick={() => {
        if (!threadId || !gate.available) return;
        void translateMessage(threadId, messageId, language);
      }}
      className={MENU_ITEM}
    >
      <LanguagesIcon className="size-4" />
      {label}
    </ActionBarMorePrimitive.Item>
  );
}

/** Opens the language picker, where an existing translation can be shown, removed, or replaced. */
export function TranslationChooseMenuItem({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const gate = useTranslationGate(threadId, messageId);
  const open = useTranslationDialog((s) => s.open);
  return (
    <ActionBarMorePrimitive.Item
      disabled={!gate.available || !threadId}
      title={!gate.available && gate.reason ? t(gate.reason) : undefined}
      onClick={() => {
        if (!threadId || !gate.available) return;
        open({ threadId, messageId });
      }}
      className={MENU_ITEM}
    >
      <LanguagesIcon className="size-4" />
      {gate.available ? t("translation.menuChoose") : t(gate.reason ?? "annotations.busy")}
    </ActionBarMorePrimitive.Item>
  );
}

function TranslatingRow({ threadId, messageId }: { threadId: string; messageId: string }) {
  return (
    <div role="status" aria-live="polite" className="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
      <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
      <span>{t("translation.translating")}</span>
      <Button variant="ghost" size="sm" className="ms-auto pointer-coarse:min-h-9" onClick={() => cancelTranslation(threadId, messageId)}>
        {t("translation.cancelTranslation")}
      </Button>
    </div>
  );
}

function ErrorRow({ threadId, messageId, error }: { threadId: string; messageId: string; error: unknown }) {
  const retryable = error instanceof ApiError && error.retryable;
  const language = lastTranslationLang(threadId, messageId) ?? preferredTranslationTarget();
  return (
    <div role="alert" className="border-destructive/40 bg-destructive/5 text-destructive mt-2 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs">
      <span className="min-w-0 flex-1">{errorText(error, "translation.failed")}</span>
      {retryable && (
        <Button variant="ghost" size="sm" className="pointer-coarse:min-h-9" onClick={() => void translateMessage(threadId, messageId, language)}>
          <RotateCwIcon className="size-3.5" />
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

/** The translated text under a message. It reads like message text, so code, math, and citations keep working. */
export function MessageTranslationBlock({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const state = useMessageTranslations(threadId, messageId);
  const editing = useMessageEdits((s) => (threadId ? s.editing === editKey(threadId, messageId) : false));
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  if (!threadId || editing) return null;
  const entry = state.active ? state.entries[state.active] : undefined;
  const shown = entry && !entry.stale ? entry : undefined;
  const language = shown ? formatLanguageName(shown.lang) : null;
  return (
    <>
      {shown && language && (
        <section aria-label={t("translation.translatedTo", { language })} className="bg-muted/40 border-border mt-2 rounded-xl border px-3 py-2">
          <header className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <LanguagesIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="font-medium">{t("translation.translatedTo", { language })}</span>
            {shown.truncated && <span className="min-w-0">{t("translation.truncatedNote", { count: MAX_TRANSLATION_SOURCE_CHARS })}</span>}
            <span className="ms-auto flex items-center gap-0.5">
              <TooltipIconButton
                tooltip={t("translation.copyTranslation")}
                aria-label={t("translation.copyTranslation")}
                onClick={() => void copyToClipboard(shown.text)}
              >
                {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              </TooltipIconButton>
              <TooltipIconButton
                tooltip={t("translation.retranslate")}
                aria-label={t("translation.retranslate")}
                onClick={() => void translateMessage(threadId, messageId, shown.lang, { refresh: true })}
              >
                <RotateCwIcon className="size-3.5" />
              </TooltipIconButton>
              <TooltipIconButton
                tooltip={t("translation.hide")}
                aria-label={t("translation.hide")}
                onClick={() => hideTranslation(threadId, messageId)}
              >
                <EyeOffIcon className="size-3.5" />
              </TooltipIconButton>
            </span>
          </header>
          <div className="mt-1 text-sm">
            <TextMessagePartProvider text={shown.text} isRunning={false}>
              <MarkdownText />
            </TextMessagePartProvider>
          </div>
        </section>
      )}
      {state.status === "translating" && <TranslatingRow threadId={threadId} messageId={messageId} />}
      {state.status === "error" && <ErrorRow threadId={threadId} messageId={messageId} error={state.error} />}
      {isCopied && (
        <span role="status" className="sr-only">
          {t("translation.copied")}
        </span>
      )}
    </>
  );
}

/** Keyboard command for the focused message, never the newest visible reply. */
export function TranslationCommand({ threadId, messageId }: { threadId: string | null | undefined; messageId: string }) {
  const gate = useTranslationGate(threadId, messageId);
  const open = useTranslationDialog((s) => s.open);
  useCommand(
    "message.translate",
    () => {
      if (!threadId || focusedMessageId() !== messageId || !gate.available) return false;
      void translateMessage(threadId, messageId, preferredTranslationTarget());
      return true;
    },
    gate.available,
  );
  useCommand(
    "message.translateChoose",
    () => {
      if (!threadId || focusedMessageId() !== messageId || !gate.available) return false;
      open({ threadId, messageId });
      return true;
    },
    gate.available,
  );
  return null;
}
