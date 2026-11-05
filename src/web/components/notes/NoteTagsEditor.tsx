import { XIcon } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { MAX_NOTE_TAGS } from "@shared/notes";
import { normalizeTag } from "@shared/tags";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Flat tag chips with an explicit add field. Invalid input is rejected, never silently truncated. */
export function NoteTagsEditor({
  tags,
  onChange,
  disabled = false,
  inputRef,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;

  const add = () => {
    const tag = normalizeTag(draft);
    if (!tag) {
      setError(t("notes.invalidTag"));
      return;
    }
    if (tags.includes(tag)) {
      setDraft("");
      setError(null);
      return;
    }
    if (tags.length >= MAX_NOTE_TAGS) {
      setError(t("notes.tooManyTags", { count: MAX_NOTE_TAGS }));
      return;
    }
    onChange([...tags, tag].sort());
    setDraft("");
    setError(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span key={tag} className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs">
            {tag}
            <button
              type="button"
              disabled={disabled}
              aria-label={`${t("notes.tags")}: ${tag}`}
              onClick={() => onChange(tags.filter((item) => item !== tag))}
              className="hover:text-foreground rounded-full p-0.5 disabled:opacity-50"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={ref}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={() => draft.trim() && add()}
          aria-label={t("notes.addTag")}
          placeholder={t("notes.addTag")}
          maxLength={24}
          className={cn("bg-transparent min-w-28 flex-1 border-0 p-0 text-sm outline-none placeholder:text-muted-foreground")}
        />
      </div>
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
