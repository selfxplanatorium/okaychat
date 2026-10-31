import { defineCatalog, type JsonSchema } from "generative-frame/spec";
import type { SpecComponentProps, SpecComponents } from "generative-frame/spec/react";
import type { ReactNode } from "react";
import { ProtectedMarkdownImage } from "@/components/ui/protected-markdown-image";
import { t } from "@/i18n";
import { formatPercent } from "@/i18n/format";
import { cn } from "@/lib/utils";

// Declarative components the model composes with `render_spec`. They render in the app's own theme,
// so structured answers (comparisons, plans, dashboards, forms) look native. Free-form visuals go to widgets.

const str = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const num = (description?: string): JsonSchema => ({ type: "number", ...(description ? { description } : {}) });
const bool = (description?: string): JsonSchema => ({ type: "boolean", ...(description ? { description } : {}) });
const oneOf = (values: string[], description?: string): JsonSchema => ({ type: "string", enum: values, ...(description ? { description } : {}) });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const TONES = ["default", "muted", "info", "success", "warning", "error"];
const VALUE = "Bind with `$bindState` to read the user's input from state.";

export const catalog = defineCatalog({
  components: {
    Stack: {
      description: "Lays out children in a column (default) or row.",
      props: obj({ direction: oneOf(["column", "row"]), gap: oneOf(["sm", "md", "lg"]), align: oneOf(["start", "center", "end", "stretch"]), wrap: bool() }),
      slots: ["default"],
    },
    Grid: {
      description: "Responsive grid of equal columns. Collapses to one column on phones.",
      props: obj({ columns: { type: "integer", minimum: 1, maximum: 4 } }, ["columns"]),
      slots: ["default"],
    },
    Card: {
      description: "Bordered panel with an optional title and description, a body, and an optional footer slot.",
      props: obj({ title: str(), description: str() }),
      slots: ["default", "footer"],
    },
    Heading: { description: "Section heading.", props: obj({ text: str(), level: { type: "integer", minimum: 1, maximum: 3 } }, ["text"]) },
    Text: {
      description: "A paragraph. Supports **bold** and `code` inline only.",
      props: obj({ text: str(), tone: oneOf(TONES), size: oneOf(["sm", "md", "lg"]) }, ["text"]),
    },
    Badge: { description: "Small label, e.g. a status.", props: obj({ text: str(), tone: oneOf(TONES) }, ["text"]) },
    Metric: {
      description: "A single key number with a label, optional change, and hint.",
      props: obj({ label: str(), value: { type: ["string", "number"] }, delta: str("e.g. +12%"), trend: oneOf(["up", "down", "flat"]), hint: str() }, ["label", "value"]),
    },
    Table: {
      description: "Data table. Each row is an object keyed by column `key`.",
      props: obj(
        {
          columns: { type: "array", items: obj({ key: str(), label: str(), align: oneOf(["left", "right", "center"]) }, ["key", "label"]) },
          rows: { type: "array", items: { type: "object" } },
          caption: str(),
        },
        ["columns", "rows"],
      ),
    },
    List: { description: "Bulleted or numbered list of short items.", props: obj({ items: { type: "array", items: { type: "string" } }, ordered: bool() }, ["items"]) },
    KeyValue: {
      description: "Label/value pairs, e.g. specs or a summary of facts.",
      props: obj({ items: { type: "array", items: obj({ label: str(), value: { type: ["string", "number"] } }, ["label", "value"]) } }, ["items"]),
    },
    BarList: {
      description: "Horizontal bars comparing values. Simple charts only; use a widget for anything richer.",
      props: obj({ items: { type: "array", items: obj({ label: str(), value: num() }, ["label", "value"]) }, unit: str("Suffix like % or ms") }, ["items"]),
    },
    Progress: { description: "Progress bar, 0 to 100.", props: obj({ value: num(), label: str() }, ["value"]) },
    Callout: { description: "Highlighted note or warning.", props: obj({ title: str(), text: str(), tone: oneOf(["info", "success", "warning", "error"]) }, ["text"]) },
    Divider: { description: "Horizontal rule.", props: obj({}) },
    Image: { description: "Image from an https URL.", props: obj({ src: str(), alt: str(), caption: str() }, ["src", "alt"]) },
    Link: { description: "External link.", props: obj({ label: str(), href: str() }, ["label", "href"]) },
    Button: { description: "Button. Bind `press` to an action, e.g. sendMessage.", props: obj({ label: str(), variant: oneOf(["primary", "secondary", "ghost"]) }, ["label"]), events: ["press"] },
    Input: {
      description: `Text or number field. ${VALUE}`,
      props: obj({ label: str(), placeholder: str(), value: { type: ["string", "number"] }, type: oneOf(["text", "number"]) }),
      events: ["change"],
    },
    Select: {
      description: `Dropdown. ${VALUE}`,
      props: obj({ label: str(), value: str(), options: { type: "array", items: obj({ value: str(), label: str() }, ["value", "label"]) } }, ["options"]),
      events: ["change"],
    },
    Checkbox: { description: `Checkbox. ${VALUE}`, props: obj({ label: str(), checked: bool() }, ["label"]), events: ["change"] },
    Slider: {
      description: `Range slider. ${VALUE}`,
      props: obj({ label: str(), value: num(), min: num(), max: num(), step: num() }, ["min", "max"]),
      events: ["change"],
    },
  },
});

type P<T> = SpecComponentProps<T & Record<string, unknown>>;

const toneText: Record<string, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
};
const toneSoft: Record<string, string> = {
  default: "bg-muted text-foreground",
  muted: "bg-muted text-muted-foreground",
  info: "bg-info/12 text-info border-info/25",
  success: "bg-success/12 text-success border-success/25",
  warning: "bg-warning/12 text-warning border-warning/25",
  error: "bg-error/12 text-error border-error/25",
};

/** Bold and inline code only. Anything richer belongs in Markdown outside the spec. */
function Inline({ text }: { text: string }): ReactNode {
  return String(text ?? "")
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={i} className="bg-muted rounded px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
    );
}

const Field = ({ label, children }: { label?: string; children: ReactNode }) => (
  <label className="flex min-w-0 flex-col gap-1 text-sm">
    {label && <span className="text-muted-foreground text-xs font-medium">{label}</span>}
    {children}
  </label>
);

const controlClass =
  "bg-background focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm outline-none transition-[border-color,box-shadow] duration-(--motion-fast) ease-out-quart focus-visible:ring-2";

const safeUrl = (url: unknown) => (typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined);

export const components: SpecComponents = {
  Stack: ({ props, children }: P<{ direction?: string; gap?: string; align?: string; wrap?: boolean }>) => (
    <div
      className={cn(
        "flex min-w-0",
        props.direction === "row" ? "flex-row" : "flex-col",
        { sm: "gap-1.5", md: "gap-3", lg: "gap-5" }[props.gap ?? "md"],
        props.align && { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" }[props.align],
        props.wrap && "flex-wrap",
      )}
    >
      {children}
    </div>
  ),
  Grid: ({ props, children }: P<{ columns: number }>) => (
    <div className={cn("grid gap-3", { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" }[props.columns] ?? "sm:grid-cols-2")}>
      {children}
    </div>
  ),
  Card: ({ props, children, slots }: P<{ title?: string; description?: string }>) => (
    <section className="bg-card text-card-foreground animate-rise-in flex min-w-0 flex-col gap-3 rounded-xl border p-4">
      {(props.title || props.description) && (
        <header>
          {props.title && <h3 className="font-semibold">{props.title}</h3>}
          {props.description && <p className="text-muted-foreground text-sm">{props.description}</p>}
        </header>
      )}
      {children}
      {slots.footer && <footer className="flex flex-wrap gap-2 border-t pt-3">{slots.footer}</footer>}
    </section>
  ),
  Heading: ({ props }: P<{ text: string; level?: number }>) => {
    const Tag = (["h2", "h3", "h4"] as const)[(props.level ?? 2) - 1] ?? "h3";
    return <Tag className={cn("font-semibold tracking-tight", { 1: "text-xl", 2: "text-lg", 3: "text-base" }[props.level ?? 2])}>{props.text}</Tag>;
  },
  Text: ({ props }: P<{ text: string; tone?: string; size?: string }>) => (
    <p className={cn("leading-relaxed", toneText[props.tone ?? "default"], { sm: "text-sm", md: "", lg: "text-lg" }[props.size ?? "md"])}>
      <Inline text={props.text} />
    </p>
  ),
  Badge: ({ props }: P<{ text: string; tone?: string }>) => (
    <span className={cn("inline-flex w-fit items-center rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium", toneSoft[props.tone ?? "default"])}>{props.text}</span>
  ),
  Metric: ({ props }: P<{ label: string; value: string | number; delta?: string; trend?: string; hint?: string }>) => (
    <div className="animate-rise-in flex min-w-0 flex-col gap-0.5 rounded-xl border p-3">
      <span className="text-muted-foreground text-xs font-medium">{props.label}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">{props.value}</span>
      {(props.delta || props.hint) && (
        <span className="text-muted-foreground text-xs">
          {props.delta && (
            <span className={cn("me-1.5 font-medium", props.trend === "up" ? "text-success" : props.trend === "down" ? "text-error" : "text-muted-foreground")}>
              {props.trend === "up" ? "↑ " : props.trend === "down" ? "↓ " : ""}
              {props.delta}
            </span>
          )}
          {props.hint}
        </span>
      )}
    </div>
  ),
  Table: ({ props }: P<{ columns: Array<{ key: string; label: string; align?: string }>; rows: Array<Record<string, unknown>>; caption?: string }>) => (
    <div className="min-w-0 overflow-x-auto rounded-xl border">
      <table className="w-full text-sm">
        {props.caption && <caption className="text-muted-foreground px-3 pt-2 text-left text-xs">{props.caption}</caption>}
        <thead className="bg-muted/50">
          <tr>
            {props.columns.map((c) => (
              <th key={c.key} className={cn("px-3 py-2 font-medium whitespace-nowrap", c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, i) => (
            <tr key={i} className="animate-fade-in stagger border-t" style={{ "--i": i } as React.CSSProperties}>
              {props.columns.map((c) => (
                <td key={c.key} className={cn("px-3 py-2 tabular-nums", c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left")}>
                  {String(row[c.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
  List: ({ props }: P<{ items: string[]; ordered?: boolean }>) => {
    const Tag = props.ordered ? "ol" : "ul";
    return (
      <Tag className={cn("flex flex-col gap-1 ps-5", props.ordered ? "list-decimal" : "list-disc")}>
        {props.items.map((item, i) => (
          <li
            key={i}
            className="animate-rise-in stagger"
            style={{ "--i": i } as React.CSSProperties}
          >
            <Inline text={item} />
          </li>
        ))}
      </Tag>
    );
  },
  KeyValue: ({ props }: P<{ items: Array<{ label: string; value: string | number }> }>) => (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {props.items.map((item, i) => (
        <div key={i} className="contents">
          <dt
            className="text-muted-foreground animate-fade-in stagger"
            style={{ "--i": i } as React.CSSProperties}
          >
            {item.label}
          </dt>
          <dd
            className="animate-fade-in stagger text-right font-medium tabular-nums"
            style={{ "--i": i } as React.CSSProperties}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  ),
  BarList: ({ props }: P<{ items: Array<{ label: string; value: number }>; unit?: string }>) => {
    const max = Math.max(1, ...props.items.map((i) => Math.abs(Number(i.value) || 0)));
    return (
      <div className="flex flex-col gap-1.5 text-sm">
        {props.items.map((item, i) => (
          <div
            key={i}
            className="animate-rise-in stagger grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3"
            style={{ "--i": i } as React.CSSProperties}
          >
            <span className="truncate">{item.label}</span>
            <span className="bg-muted h-2 overflow-hidden rounded-full">
              <span className="chat-bar-grow bg-primary block h-full rounded-full" style={{ width: `${(Math.abs(Number(item.value) || 0) / max) * 100}%` }} />
            </span>
            <span className="text-muted-foreground tabular-nums">
              {item.value}
              {props.unit}
            </span>
          </div>
        ))}
      </div>
    );
  },
  Progress: ({ props }: P<{ value: number; label?: string }>) => (
    <div className="flex flex-col gap-1 text-sm">
      {props.label && (
        <span className="text-muted-foreground flex justify-between text-xs">
          {props.label}
          <span className="tabular-nums">{formatPercent(props.value / 100)}</span>
        </span>
      )}
      <span className="bg-muted h-2 overflow-hidden rounded-full">
        <span className="chat-bar-grow bg-primary block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, props.value))}%` }} />
      </span>
    </div>
  ),
  Callout: ({ props }: P<{ title?: string; text: string; tone?: string }>) => (
    <div className={cn("rounded-xl border px-3 py-2.5 text-sm", toneSoft[props.tone ?? "info"])}>
      {props.title && <p className="font-medium">{props.title}</p>}
      <p className="text-foreground/90">
        <Inline text={props.text} />
      </p>
    </div>
  ),
  Divider: () => <hr className="border-border" />,
  Image: ({ props }: P<{ src: string; alt: string; caption?: string }>) =>
    safeUrl(props.src) ? (
      <figure className="flex flex-col gap-1">
        <ProtectedMarkdownImage src={safeUrl(props.src)} alt={props.alt} className="max-h-96 rounded-xl border object-contain" />
        {props.caption && <figcaption className="text-muted-foreground text-xs">{props.caption}</figcaption>}
      </figure>
    ) : null,
  Link: ({ props }: P<{ label: string; href: string }>) => (
    <a href={safeUrl(props.href)} target="_blank" rel="noreferrer" className="text-primary w-fit text-sm underline-offset-2 transition-opacity duration-(--motion-fast) ease-out-quart hover:underline hover:opacity-80">
      {props.label}
    </a>
  ),
  Button: ({ props, emit }: P<{ label: string; variant?: string }>) => (
    <button
      type="button"
      onClick={() => emit("press")}
      className={cn(
        "h-8 w-fit rounded-lg px-3 text-sm font-medium transition-[background-color,color,scale] duration-(--motion-fast) ease-out-quart active:scale-[0.97]",
        props.variant === "secondary" ? "bg-muted hover:bg-muted/70 border" : props.variant === "ghost" ? "hover:bg-muted" : "bg-primary text-primary-foreground hover:bg-primary/90",
      )}
    >
      {props.label}
    </button>
  ),
  Input: ({ props, setProp, emit }: P<{ label?: string; placeholder?: string; value?: string | number; type?: string }>) => (
    <Field label={props.label}>
      <input
        className={controlClass}
        type={props.type === "number" ? "number" : "text"}
        placeholder={props.placeholder}
        value={props.value ?? ""}
        onChange={(e) => {
          const value = props.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value;
          setProp("value", value);
          emit("change", value);
        }}
      />
    </Field>
  ),
  Select: ({ props, setProp, emit }: P<{ label?: string; value?: string; options: Array<{ value: string; label: string }> }>) => (
    <Field label={props.label}>
      <select
        className={controlClass}
        value={props.value ?? ""}
        onChange={(e) => {
          setProp("value", e.target.value);
          emit("change", e.target.value);
        }}
      >
        {props.value === undefined && <option value="">{t("genui.selectPlaceholder")}</option>}
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  ),
  Checkbox: ({ props, setProp, emit }: P<{ label: string; checked?: boolean }>) => (
    <label className="flex w-fit items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="accent-primary size-4 transition-colors duration-(--motion-fast) ease-out-quart"
        checked={!!props.checked}
        onChange={(e) => {
          setProp("checked", e.target.checked);
          emit("change", e.target.checked);
        }}
      />
      {props.label}
    </label>
  ),
  Slider: ({ props, setProp, emit }: P<{ label?: string; value?: number; min: number; max: number; step?: number }>) => (
    <Field label={props.label && `${props.label}: ${props.value ?? props.min}`}>
      <input
        type="range"
        className="accent-primary w-full transition-colors duration-(--motion-fast) ease-out-quart"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value ?? props.min}
        onChange={(e) => {
          setProp("value", Number(e.target.value));
          emit("change", Number(e.target.value));
        }}
      />
    </Field>
  ),
};
