import { ChevronDownIcon, FileTextIcon, WrenchIcon } from "lucide-react";
import { useState } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * A historical tool record from an imported archive. It is inert by construction: no approval, retry,
 * install, draft, send, widget, or browser callback is rendered, and the stored data never becomes a tool
 * call. Files it references are ordinary owned uploads.
 */
export function ImportedToolRecord({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false);
  const record = (data ?? {}) as {
    name?: unknown;
    input?: unknown;
    output?: unknown;
    state?: unknown;
    references?: Array<{ kind?: unknown; key?: unknown; version?: unknown }>;
  };
  const name = typeof record.name === "string" ? record.name : "tool";
  const state = record.state === "failed" ? "failed" : record.state === "interrupted" ? "interrupted" : "completed";
  const references = Array.isArray(record.references) ? record.references : [];
  return (
    <div className="border-border/60 my-1.5 rounded-lg border text-sm" data-imported-tool>
      <button type="button" onClick={() => setOpen((value) => !value)} className="hover:bg-muted/50 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start">
        <WrenchIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t("chatArchives.historicalTool")} · {name}
        </span>
        <span className={cn("text-xs", state === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {state === "interrupted" ? t("chatArchives.historicalInterrupted") : state}
        </span>
        <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2.5 pb-2.5">
          <div>
            <p className="text-muted-foreground mb-0.5 text-xs font-medium">{t("chatArchives.historicalInput")}</p>
            <pre className="bg-muted/40 max-h-48 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap break-all">{JSON.stringify(record.input ?? null, null, 2)}</pre>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5 text-xs font-medium">{t("chatArchives.historicalOutput")}</p>
            <pre className="bg-muted/40 max-h-48 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap break-all">{JSON.stringify(record.output ?? null, null, 2)}</pre>
          </div>
          {references.some((reference) => reference.kind === "asset" && typeof reference.key === "string") && (
            <div className="flex flex-wrap gap-2">
              {references
                .filter((reference) => reference.kind === "asset" && typeof reference.key === "string")
                .map((reference) => (
                  <a
                    key={String(reference.key)}
                    href={`/api/uploads/${encodeURIComponent(String(reference.key))}/file`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                  >
                    <FileTextIcon className="size-3.5" /> {t("common.download")}
                  </a>
                ))}
            </div>
          )}
          {references.some((reference) => reference.kind === "artifact") && <p className="text-muted-foreground text-xs">{t("chatArchives.embeddedLinks")}</p>}
        </div>
      )}
    </div>
  );
}
