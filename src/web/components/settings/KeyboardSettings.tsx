import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { KeyboardSettings as KeyboardPrefs } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, type PlainMessageKey } from "@/i18n";
import { formatList } from "@/i18n/format";
import { Trans } from "@/i18n/react";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { COMMAND_GROUPS, COMMANDS, type CommandGroup, commandById, commandLabel, groupLabel, type CommandDef } from "@/keyboard/commands";
import { Kbd } from "@/keyboard/Kbd";
import { browserConflict, eventCombos, formatCombo, platform } from "@/keyboard/keys";
import { setRecording, useBindings, useKeyboardSettings } from "@/keyboard/registry";
import { useData } from "@/state/data";
import { SettingsPage, SettingsRow, SettingsSection } from "./SettingsUI";

const GROUP_NOTES = {
  Messages: "keyboard.noteMessages",
  Settings: "keyboard.noteSettings",
} as const satisfies Partial<Record<CommandGroup, PlainMessageKey>>;

const mod = platform === "mac" ? "⌘" : "Ctrl";

type Pending = { command: string; combo: string; others: string[]; browser: string | null };

export function KeyboardSettings() {
  const prefs = useKeyboardSettings();
  const bindings = useBindings();
  const update = useData((s) => s.updateSettings);
  const [query, setQuery] = useState("");
  const [recording, setRecordingFor] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<{ command: string; text: string } | null>(null);

  const save = (next: KeyboardPrefs) => void update({ keyboard: next });
  const setKeys = (changes: Record<string, string[]>) => {
    const overrides = { ...prefs.bindings };
    for (const [id, keys] of Object.entries(changes)) {
      const defaults = commandById.get(id)?.keys ?? [];
      // Equal to the defaults means no override, so later default changes still reach this account.
      if (keys.length === defaults.length && keys.every((k, i) => k === defaults[i])) delete overrides[id];
      else overrides[id] = keys;
    }
    save({ ...prefs, bindings: overrides });
  };

  const commit = ({ command, combo, others }: Pending) => {
    setKeys({
      [command]: [...(bindings.get(command) ?? []).filter((k) => k !== combo), combo].slice(-4),
      ...Object.fromEntries(others.map((id) => [id, (bindings.get(id) ?? []).filter((k) => k !== combo)])),
    });
    setPending(null);
  };

  const record = (command: string, combo: string) => {
    setRecordingFor(null);
    const conflict = browserConflict(combo);
    if (conflict?.level === "blocked") {
      setError({ command, text: t("keyboard.browserKeeps", { combo: formatCombo(combo), what: t(conflict.what) }) });
      return;
    }
    setError(null);
    const others = COMMANDS.filter((c) => c.id !== command && bindings.get(c.id)?.includes(combo)).map((c) => c.id);
    const next = { command, combo, others, browser: conflict ? t(conflict.what) : null };
    if (others.length || next.browser) setPending(next);
    else commit(next);
  };

  // The dispatcher stands down while a combo is being recorded, or the combo would run its command.
  useEffect(() => {
    if (!recording) return;
    setRecording(true);
    return () => setRecording(false);
  }, [recording]);

  const q = query.trim().toLowerCase();
  const visible = (c: CommandDef) =>
    !q || commandLabel(c).toLowerCase().includes(q) || (bindings.get(c.id) ?? []).some((k) => formatCombo(k).toLowerCase().includes(q));

  return (
    <SettingsPage
      title={t("keyboard.title")}
      description={t("keyboard.description", { combo: formatCombo(bindings.get("app.commands")?.[0] ?? "Mod+/") })}
    >
      <SettingsSection title={t("keyboard.typing")}>
        <SettingsRow
          label={t("keyboard.sendWith")}
          description={t("keyboard.sendWithHelp")}
          control={
            <Select
              aria-label={t("keyboard.sendWith")}
              className="w-full md:w-48"
              value={prefs.sendWith ?? "enter"}
              onValueChange={(v) => save({ ...prefs, sendWith: v as "enter" | "modEnter" })}
              options={[{ value: "enter", label: t("keyboard.enterKey") }, { value: "modEnter", label: t("keyboard.modEnterKey", { mod }) }]}
            />
          }
        />
        <SettingsRow
          label={t("keyboard.singleKeys")}
          description={t("keyboard.singleKeysHelp")}
          control={<Switch aria-label={t("keyboard.singleKeys")} checked={prefs.singleKeys !== false} onCheckedChange={(singleKeys) => save({ ...prefs, singleKeys })} />}
        />
      </SettingsSection>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input aria-label={t("keyboard.filter")} placeholder={t("keyboard.filterPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
        </div>
        <Button variant="outline" disabled={!Object.keys(prefs.bindings ?? {}).length} onClick={() => save({ ...prefs, bindings: {} })}>
          {t("keyboard.resetAll")}
        </Button>
      </div>

      {COMMAND_GROUPS.map((group) => {
        const commands = COMMANDS.filter((c) => c.group === group && visible(c));
        if (!commands.length) return null;
        return (
          <SettingsSection key={group} title={groupLabel(group)} description={group in GROUP_NOTES ? t(GROUP_NOTES[group as keyof typeof GROUP_NOTES]) : undefined}>
            {commands.map((command) => {
              const keys = bindings.get(command.id) ?? [];
              const overridden = Object.hasOwn(prefs.bindings ?? {}, command.id);
              const rowPending = pending?.command === command.id ? pending : null;
              const rowError = error?.command === command.id ? error.text : null;
              return (
                <SettingsRow
                  key={command.id}
                  label={commandLabel(command)}
                  reset={overridden ? () => setKeys({ [command.id]: command.keys }) : null}
                  description={
                    rowPending ? (
                      <span role="alert" className="text-foreground mt-1 flex flex-wrap items-center gap-2">
                        <span>
                          <PendingNote pending={rowPending} />
                        </span>
                        <Button size="xs" autoFocus onClick={() => commit(rowPending)}>
                          {rowPending.others.length ? t("keyboard.moveHere") : t("keyboard.useAnyway")}
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setPending(null)}>{t("common.cancel")}</Button>
                      </span>
                    ) : rowError ? (
                      <span role="alert" className="text-destructive">{rowError}</span>
                    ) : undefined
                  }
                  control={
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {keys.map((combo) => (
                        <span key={combo} className="inline-flex items-center">
                          <Kbd combo={combo} />
                          <button
                            type="button"
                            aria-label={t("keyboard.removeShortcut", { combo: formatCombo(combo), command: commandLabel(command) })}
                            onClick={() => setKeys({ [command.id]: keys.filter((k) => k !== combo) })}
                            className="text-muted-foreground hover:text-foreground rounded p-0.5"
                          >
                            <XIcon className="size-3" />
                          </button>
                        </span>
                      ))}
                      {keys.length < 4 && (
                        <Recorder
                          active={recording === command.id}
                          label={commandLabel(command)}
                          onStart={() => {
                            setPending(null);
                            setError(null);
                            setRecordingFor(command.id);
                          }}
                          onCancel={() => setRecordingFor(null)}
                          onRecord={(combo) => record(command.id, combo)}
                        />
                      )}
                    </div>
                  }
                />
              );
            })}
          </SettingsSection>
        );
      })}
    </SettingsPage>
  );
}

function PendingNote({ pending }: { pending: Pending }) {
  const combo = <Kbd combo={pending.combo} />;
  const commands = formatList(pending.others.map((id) => `“${commandById.get(id) ? commandLabel(commandById.get(id)!) : id}”`));
  if (pending.browser && pending.others.length) return <Trans k="keyboard.conflictBoth" params={{ combo, what: pending.browser, commands }} />;
  if (pending.browser) return <Trans k="keyboard.conflictBrowser" params={{ combo, what: pending.browser }} />;
  return <Trans k="keyboard.conflictCommands" params={{ combo, commands }} />;
}

/** Captures the next key combination. Escape cancels; Tab leaves, so focus is never trapped. */
function Recorder({ active, label, onStart, onCancel, onRecord }: { active: boolean; label: string; onStart: () => void; onCancel: () => void; onRecord: (combo: string) => void }) {
  return (
    <Button
      size="xs"
      variant={active ? "default" : "ghost"}
      aria-label={active ? t("keyboard.recordShortcut", { command: label }) : t("keyboard.addShortcut", { command: label })}
      onClick={() => (active ? onCancel() : onStart())}
      onBlur={() => active && onCancel()}
      onKeyDown={(event) => {
        if (!active) return;
        if (event.key === "Tab") return onCancel();
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") return onCancel();
        const combo = eventCombos({
          key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
          altGraph: event.nativeEvent.getModifierState?.("AltGraph"),
        })[0];
        if (combo) onRecord(combo);
      }}
    >
      {active ? t("keyboard.pressKeys") : <><PlusIcon /> {t("common.add")}</>}
    </Button>
  );
}
