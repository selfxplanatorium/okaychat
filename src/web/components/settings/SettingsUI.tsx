import { RotateCcwIcon } from "lucide-react";
import { Children, isValidElement, type CSSProperties, type ReactNode } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** Layout primitives shared by every settings page. Mirrors T3Code's SettingsSection / SettingsRow. */
export function SettingsPage({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  // Groups rise in one after another when the section mounts, so a dense page
  // reads top to bottom instead of appearing all at once.
  let group = 0;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
      {(title || description) && <header className="stagger animate-rise-in" style={{ "--i": 0 } as CSSProperties}>
        {title && <h1 className="text-xl font-semibold tracking-tight">{title}</h1>}
        {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
      </header>}
      {Children.map(children, (child) =>
        isValidElement(child) ? (
          // A settings section that renders nothing (for example an absent token allowance) must
          // not leave an empty flex row behind.
          <div className="stagger animate-rise-in empty:hidden" style={{ "--i": ++group } as CSSProperties}>
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
  id,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  /** Shown when the value differs from its default. */
  reset?: (() => void) | null;
  className?: string;
  /** Deep-link target. `SettingsLayout` focuses `setting-<anchor>` after the page mounts. */
  id?: string;
}) {
  return (
    <div
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3 sm:flex-nowrap",
        id && "scroll-mt-24 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      {/* Short controls (switches, small buttons) share the label's line like a native list row; wide ones wrap below it. */}
      <div className="min-w-0 flex-[1_1_12rem]">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {label}
          {reset && (
            <button type="button" onClick={reset} aria-label={t("settings.resetToDefault")} className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors duration-(--motion-fast)">
              <RotateCcwIcon className="size-3" />
            </button>
          )}
        </div>
        {description && <div className="text-muted-foreground text-xs">{description}</div>}
      </div>
      <div className="flex max-w-full shrink-0 items-center gap-2">{control}</div>
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
