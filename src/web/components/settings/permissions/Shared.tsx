import { ChevronLeftIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { t, type PlainMessageKey } from "@/i18n";
import { cn } from "@/lib/utils";

// Shared, dependency-free building blocks for the permissions workspace: a roving tablist, a compact
// radio group for tri-state values, and the field frame that shows effective value + source + local editor.

export function WorkspaceCard({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("bg-card divide-border flex flex-col divide-y rounded-xl border border-transparent shadow-[var(--depth-highlight),var(--shadow-raised)]", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-medium">{title}</h2>}
            {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Tabs({
  items,
  value,
  onChange,
  label,
  idPrefix,
  className,
}: {
  items: ReadonlyArray<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
  label: string;
  idPrefix: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("border-border flex gap-1 overflow-x-auto border-b", className)}>
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            id={`${idPrefix}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              const index = items.findIndex((entry) => entry.id === item.id);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : event.key === "ArrowLeft" || event.key === "ArrowUp"
                      ? (index - 1 + items.length) % items.length
                      : event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? (index + 1) % items.length
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              onChange(items[next]!.id);
              document.getElementById(`${idPrefix}-tab-${items[next]!.id}`)?.focus();
            }}
            className={cn(
              "focus-visible:outline-ring shrink-0 rounded-t-md border-x border-t border-transparent px-3 py-2 text-sm transition-colors duration-(--motion-fast) pointer-coarse:min-h-11",
              selected ? "border-border bg-card text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="bg-muted/60 inline-flex flex-wrap gap-0.5 rounded-lg p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "focus-visible:outline-ring rounded-md px-2.5 py-1 text-xs transition-colors duration-(--motion-fast) disabled:opacity-50 pointer-coarse:min-h-9",
            value === option.value ? "depth-row-active text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function FieldFrame({
  label,
  help,
  effective,
  source,
  children,
  problem,
}: {
  label: string;
  help?: ReactNode;
  effective: ReactNode;
  source?: ReactNode;
  children: ReactNode;
  problem?: ReactNode;
}) {
  return (
    <div className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {help && <p className="text-muted-foreground mt-0.5 text-xs">{help}</p>}
        <p className="text-muted-foreground mt-1 text-xs">
          {t("permissions.effectiveNow")} <span className="text-foreground font-medium">{effective}</span>
          {source && <> · {source}</>}
        </p>
        {problem && <p className="text-warning mt-1 text-xs">{problem}</p>}
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

export function StatusLine({ status, error, className }: { status: "idle" | "loading" | "ready" | "error" | "saving"; error?: string | null; className?: string }) {
  if (status === "loading" || status === "saving") {
    return (
      <p className={cn("text-muted-foreground flex items-center gap-2 text-sm", className)}>
        <Loader2Icon className="size-4 animate-spin" /> {status === "saving" ? t("permissions.stateSaving") : t("permissions.stateLoading")}
      </p>
    );
  }
  if (status === "error") {
    return (
      <p role="alert" className={cn("text-error text-sm", className)}>
        {error ?? t("permissions.stateLoadFailed")}
      </p>
    );
  }
  return <p className={cn("text-muted-foreground text-sm", className)}>{t("permissions.stateEmpty")}</p>;
}

export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="md:hidden" onClick={onClick}>
      <ChevronLeftIcon /> {label}
    </Button>
  );
}

export function HelpText({ k }: { k: PlainMessageKey }) {
  return <span className="text-muted-foreground text-xs">{t(k)}</span>;
}
