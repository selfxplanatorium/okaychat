import { RotateCcwIcon } from "lucide-react";
import { Children, isValidElement, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Layout primitives shared by every settings page. Mirrors T3Code's SettingsSection / SettingsRow. */
export function SettingsPage({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  // Groups rise in one after another when the section mounts, so a dense page
  // reads top to bottom instead of appearing all at once.
  let group = 0;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
      <header className="stagger animate-rise-in" style={{ "--i": 0 } as CSSProperties}>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
      </header>
      {Children.map(children, (child) =>
        isValidElement(child) ? (
          <div className="stagger animate-rise-in" style={{ "--i": ++group } as CSSProperties}>
            {child}
          </div>
        ) : null,
      )}
    </div>
  );
}

export function SettingsSection({ title, description, action, children }: { title?: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      {(title || action) && (
        // A lone title centers on the action. With a description, the action sits level with its last line.
        <div className={cn("flex justify-between gap-4", description ? "items-end" : "items-center")}>
          <div>
            {title && <h2 className="text-sm font-medium">{title}</h2>}
            {description && <p className="text-muted-foreground text-xs">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="bg-card divide-border flex flex-col divide-y rounded-xl shadow-[var(--depth-highlight),var(--shadow-raised)]">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  control,
  reset,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  /** Shown when the value differs from its default. */
  reset?: (() => void) | null;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {label}
          {reset && (
            <button type="button" onClick={reset} aria-label="Reset to default" className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors duration-(--motion-fast)">
              <RotateCcwIcon className="size-3" />
            </button>
          )}
        </div>
        {description && <div className="text-muted-foreground text-xs">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

/** Range input styled by the ported `.settings-slider` CSS, with a value badge. */
export function SettingsSlider({
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => `${v}`,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  label: string;
}) {
  const ratio = (value - min) / (max - min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  return (
    <div className="flex w-full items-center gap-3 sm:w-56">
      <input
        type="range"
        aria-label={label}
        className="settings-slider min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        style={style}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <output className="text-foreground w-10 shrink-0 text-right font-sans text-sm tabular-nums">{format(value)}</output>
    </div>
  );
}
