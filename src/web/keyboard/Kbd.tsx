import { cn } from "@/lib/utils";
import { comboKeys } from "./keys";
import { useShortcut } from "./registry";

/** One combo as key caps. */
export function Kbd({ combo, className }: { combo: string; className?: string }) {
  return (
    <kbd className={cn("inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap font-sans", className)}>
      {comboKeys(combo).map((key, i) => (
        <span key={i} className="bg-muted text-muted-foreground border-border inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border px-1 text-[11px] leading-none font-medium">
          {key}
        </span>
      ))}
    </kbd>
  );
}

/** A command's first shortcut, for tooltips and menu rows. Renders nothing while the command is unbound. */
export function ShortcutHint({ command, className }: { command: string; className?: string }) {
  const combo = useShortcut(command);
  return combo ? <Kbd combo={combo} className={className} /> : null;
}
