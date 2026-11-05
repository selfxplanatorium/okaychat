import { useEffect, useMemo, useState } from "react";
import { CheckIcon, PlusIcon, TagIcon, XIcon } from "lucide-react";
import { MAX_TAGS_PER_THREAD, normalizeTag, normalizeTags } from "@shared/tags";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useTagFilter } from "@/state/tag-filter";

/** The fields `updateCustom` needs; the caller owns the rest of the chat's metadata. */
export interface TagEditorThread {
  id: string;
  tags: string[];
  custom: Record<string, unknown>;
}

/**
 * Tags for one chat or a whole selection. The editor shows the union of the selection's tags; saving
 * adds what was added and removes what was removed on every chosen chat, so bulk tagging never erases a
 * chat's other labels.
 */
export function TagEditorDialog({
  open,
  onOpenChange,
  threads,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: TagEditorThread[];
  /** Receives one update per changed chat. */
  onSave: (updates: Array<{ id: string; custom: Record<string, unknown> }>) => Promise<void>;
}) {
  const library = useTagFilter((s) => s.tags);
  const [initial, setInitial] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Freeze what the selection looked like when the dialog opened, so a background refresh cannot move it.
  useEffect(() => {
    if (!open) return;
    setInitial(normalizeTags(threads.flatMap((thread) => thread.tags)));
    setValue("");
    setError(null);
    setSaving(false);
  }, [open]);

  const suggestions = useMemo(
    () => library.map((item) => item.tag).filter((tag) => !initial.includes(tag)).slice(0, 12),
    [library, initial],
  );
  const typed = normalizeTag(value);

  const add = (raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag) {
      setError(t("tags.tagInvalid"));
      return;
    }
    if (initial.includes(tag)) {
      setValue("");
      setError(null);
      return;
    }
    if (initial.length >= MAX_TAGS_PER_THREAD) {
      setError(t("tags.tagLimit", { count: MAX_TAGS_PER_THREAD }));
      return;
    }
    setInitial((current) => [...current, tag]);
    setValue("");
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const removed = new Set(threads.flatMap((thread) => thread.tags).filter((tag) => !initial.includes(tag)));
      const added = initial.filter((tag) => !threads.some((thread) => thread.tags.includes(tag)));
      const updates: Array<{ id: string; custom: Record<string, unknown> }> = [];
      for (const thread of threads) {
        const next = normalizeTags([...thread.tags.filter((tag) => !removed.has(tag)), ...added]);
        if (next.length === thread.tags.length && next.every((tag, index) => tag === thread.tags[index])) continue;
        updates.push({ id: thread.id, custom: { ...thread.custom, tags: next } });
      }
      if (updates.length) await onSave(updates);
      onOpenChange(false);
    } catch {
      setError(t("tags.tagSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tags.editTags")}</DialogTitle>
          <DialogDescription>{t("tags.tagLimit", { count: MAX_TAGS_PER_THREAD })}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {initial.map((tag) => (
            <span key={tag} className="bg-muted inline-flex items-center gap-1 rounded-full py-1 ps-2 pe-1 text-xs">
              <TagIcon aria-hidden className="size-3" />#{tag}
              <button
                type="button"
                aria-label={t("tags.removeTag", { tag })}
                onClick={() => setInitial((current) => current.filter((item) => item !== tag))}
                className="text-muted-foreground hover:bg-background hover:text-foreground rounded-full p-0.5"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            add(value);
          }}
          className="flex gap-2"
        >
          <Input
            autoFocus
            aria-label={t("tags.tagInputLabel")}
            value={value}
            placeholder={t("tags.newTagPlaceholder")}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add(value);
              } else if (event.key === "Backspace" && !value) {
                setInitial((current) => current.slice(0, -1));
              }
            }}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline" disabled={!typed} aria-label={t("tags.addTag")}>
            <PlusIcon /> {t("tags.addTag")}
          </Button>
        </form>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => add(tag)}
                className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex min-h-8 items-center gap-1 rounded-full border px-2 text-xs pointer-coarse:min-h-11"
              >
                <PlusIcon aria-hidden className="size-3" />#{tag}
              </button>
            ))}
          </div>
        )}
        <p aria-live="polite" className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {error ?? (typed ? <span className="inline-flex items-center gap-1"><CheckIcon className="size-3" />#{typed}</span> : "")}
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={saving} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
