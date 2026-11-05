import { useEffect, useMemo, useState } from "react";
import { Trash2Icon } from "lucide-react";
import { TRANSLATION_LANGUAGES } from "@shared/locale-tag";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { currentLocale, t } from "@/i18n";
import { compareText, formatLanguageName } from "@/i18n/format";
import { shippedLocales } from "@/i18n/locales";
import { errorText } from "@/lib/error-text";
import { useData } from "@/state/data";
import { loadTranslations, removeTranslation, translateMessage, useMessageTranslations } from "@/state/message-translations";
import { useTranslationDialog } from "@/state/translation-dialog";

const useTargetLanguage = () => useData((s) => s.settings?.translationTarget) ?? currentLocale();

/** One dialog for the open chat, mounted beside the bookmark list. */
export function TranslationDialog() {
  const target = useTranslationDialog((s) => s.target);
  const close = useTranslationDialog((s) => s.close);
  const state = useMessageTranslations(target?.threadId, target?.messageId);
  const preferred = useTargetLanguage();
  const [lang, setLang] = useState(preferred);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setLang(preferred);
    setStatus(null);
    void loadTranslations(target.threadId, target.messageId);
  }, [target, preferred]);

  const choices = useMemo(
    () =>
      [...new Set([preferred, ...TRANSLATION_LANGUAGES, ...shippedLocales()])]
        .map((tag) => ({ value: tag, label: formatLanguageName(tag) }))
        .sort((a, b) => compareText(a.label, b.label)),
    [preferred],
  );
  // A stale row describes text the message no longer has, so it is not offered as a translation to show.
  const existing = Object.values(state.entries).filter((entry) => !entry.stale);

  const remove = (language: string) => {
    if (!target) return;
    void removeTranslation(target.threadId, target.messageId, language).then(
      () => setStatus(t("translation.removed")),
      (error: unknown) => setStatus(errorText(error, "translation.failed")),
    );
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("translation.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("translation.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Select
            aria-label={t("translation.languageLabel")}
            value={lang}
            onValueChange={setLang}
            options={choices}
            className="w-full"
          />
          {existing.length > 0 && (
            <ul className="flex flex-col gap-1">
              {existing.map((entry) => (
                <li key={entry.lang} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{formatLanguageName(entry.lang)}</span>
                  <Button variant="ghost" size="sm" className="pointer-coarse:min-h-9" onClick={() => remove(entry.lang)}>
                    <Trash2Icon className="size-3.5" />
                    {t("translation.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {status && (
            <p role="status" className="text-muted-foreground text-xs">
              {status}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!target || state.status === "translating"}
            onClick={() => {
              if (!target) return;
              void translateMessage(target.threadId, target.messageId, lang);
              close();
            }}
          >
            {t("translation.translateAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


export default TranslationDialog;
