import { Loader2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { t } from "@/i18n";
import { Kbd } from "@/keyboard/Kbd";
import { commandById, commandLabel } from "@/keyboard/commands";
import { useBindings, useCommand } from "@/keyboard/registry";
import { settingsHref } from "@/lib/settings-link";
import { useData } from "@/state/data";

/** The few bindings a new account is most likely to want; labels and combos come from the live catalogue. */
const HINTS = ["app.search", "composer.model", "app.commands"] as const;

/**
 * A quiet first-run row under the welcome line. Dismissal is stored on the account, so it follows the
 * user across devices. The visible row stays mounted while the save is in flight: hiding it optimistically
 * would make a failed request look permanently dismissed.
 */
export function ShortcutHints() {
  const loaded = useData((s) => s.loaded);
  const settings = useData((s) => s.settings);
  const updateSettings = useData((s) => s.updateSettings);
  const bindings = useBindings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const hints = HINTS.flatMap((id) => {
    const combo = bindings.get(id)?.[0];
    const command = commandById.get(id);
    return combo && command ? [{ id, combo, label: commandLabel(command) }] : [];
  });
  const shown = loaded && !!settings && !(settings.shortcutHintsDismissed === true && !saving) && hints.length > 0;

  const dismiss = async () => {
    if (saving) return;
    const previous = useData.getState().settings?.shortcutHintsDismissed;
    setSaving(true);
    setError(false);
    try {
      await updateSettings({ shortcutHintsDismissed: true });
    } catch {
      // `updateSettings` applies its patch before the request, so a failure must put the old value back.
      useData.setState((s) => ({ settings: s.settings ? { ...s.settings, shortcutHintsDismissed: previous } : s.settings }));
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  useCommand("ux.dismissHints", () => {
    if (!shown || saving) return false;
    void dismiss();
  }, shown);

  if (!shown) return null;

  return (
    <div data-slot="aui_shortcut-hints" className="text-muted-foreground animate-fade-in mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 px-2 text-xs">
      <span className="sr-only">{t("ux.shortcutHintsLabel")}</span>
      {hints.map((hint) => (
        <span key={hint.id} className="inline-flex items-center gap-1.5">
          <Kbd combo={hint.combo} />
          <span>{hint.label}</span>
        </span>
      ))}
      <Link href={settingsHref("keyboard")} className="hover:text-foreground underline underline-offset-4">
        {t("ux.customizeShortcuts")}
      </Link>
      <button
        type="button"
        data-command="ux.dismissHints"
        disabled={saving}
        aria-busy={saving || undefined}
        onClick={() => void dismiss()}
        aria-label={t("keyboard.cmdUxDismissHints")}
        className="hover:text-foreground hover:bg-muted focus-visible:outline-ring -me-1 ms-auto inline-flex size-7 pointer-coarse:size-11 items-center justify-center rounded-lg transition-colors duration-(--motion-fast) ease-out-quart disabled:opacity-60"
      >
        {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <XIcon className="size-3.5" />}
      </button>
      {error && (
        <p role="alert" className="text-error basis-full text-xs">
          {t("ux.shortcutHintsSaveFailed")}
        </p>
      )}
    </div>
  );
}
