import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import type { McpElicitation, McpElicitationField } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { t, type MessageKey } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Value = string | number | boolean | string[];

/** A preliminary MCP tool result carrying a form, as yielded by the server while the call waits. */
export function elicitationOf(result: unknown): McpElicitation | null {
  const e = (result as { elicitation?: McpElicitation } | null)?.elicitation;
  return e && typeof e.id === "string" && Array.isArray(e.fields) ? e : null;
}

const OUTCOME = {
  accept: "tools.elicitationSent",
  decline: "tools.elicitationDeclined",
  cancel: "tools.elicitationCancelled",
} as const satisfies Record<NonNullable<McpElicitation["answered"]>, MessageKey>;

const initial = (field: McpElicitationField): Value | undefined => field.default;

/**
 * The form an MCP server asked for mid-call. The server named the fields, so labels come from it; the
 * header makes clear which server is asking, and nothing here is sent unless the user presses Send.
 */
export function McpElicitationCard({ elicitation }: { elicitation: McpElicitation }) {
  const [values, setValues] = useState<Record<string, Value | undefined>>(() =>
    Object.fromEntries(elicitation.fields.map((f) => [f.name, initial(f)])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<McpElicitation["answered"]>(elicitation.answered);

  const answer = async (action: "accept" | "decline" | "cancel") => {
    setBusy(action);
    setError(null);
    try {
      const content = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== ""));
      await api(`/mcp/elicitations/${elicitation.id}`, { method: "POST", json: action === "accept" ? { action, content } : { action } });
      setSent(action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const outcome = elicitation.answered ?? sent;
  if (outcome) {
    return (
      <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
        {outcome === "accept" ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
        {t(OUTCOME[outcome], { message: elicitation.message })}
      </p>
    );
  }

  return (
    <form
      className="bg-muted/40 mt-2 flex flex-col gap-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void answer("accept");
      }}
    >
      <div>
        <p className="text-muted-foreground text-xs font-medium">{t("tools.elicitationAsks", { server: elicitation.server })}</p>
        <p className="text-sm whitespace-pre-wrap">{elicitation.message}</p>
      </div>
      {elicitation.fields.map((field, index) => (
        <Field key={field.name} field={field} autoFocus={index === 0} value={values[field.name]} onChange={(v) => setValues({ ...values, [field.name]: v })} />
      ))}
      <p className="text-muted-foreground text-xs">{t("tools.elicitationWarning", { server: elicitation.server })}</p>
      {error && <p className="text-error text-xs">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => answer("decline")}>
          {busy === "decline" && <Loader2Icon className="animate-spin" />}
          {t("tools.decline")}
        </Button>
        <Button type="submit" size="sm" disabled={!!busy}>
          {busy === "accept" && <Loader2Icon className="animate-spin" />}
          {t("tools.send")}
        </Button>
      </div>
    </form>
  );
}

function Field({ field, value, onChange, autoFocus }: { field: McpElicitationField; value: Value | undefined; onChange: (v: Value | undefined) => void; autoFocus: boolean }) {
  const label = (
    <span className="font-medium">
      {field.title ?? field.name}
      {field.required && <span className="text-muted-foreground"> {t("tools.required")}</span>}
    </span>
  );
  const hint = field.description && <span className="text-muted-foreground">{field.description}</span>;
  switch (field.type) {
    case "boolean":
      return (
        <label className="flex items-start gap-3 text-xs">
          <Switch className="mt-0.5" checked={value === true} onCheckedChange={(v) => onChange(v)} />
          <span className="flex flex-col">
            {label}
            {hint}
          </span>
        </label>
      );
    case "select":
      return (
        <label className="flex flex-col gap-1 text-xs">
          {label}
          <Select
            value={typeof value === "string" ? value : ""}
            onValueChange={(v) => onChange(v || undefined)}
            aria-label={field.title ?? field.name}
            options={[...(field.required ? [] : [{ value: "", label: "—" }]), ...field.options]}
          />
          {hint}
        </label>
      );
    case "multiselect": {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <fieldset className="flex flex-col gap-1 text-xs">
          <legend className="mb-1">{label}</legend>
          <div className="flex flex-wrap gap-1.5">
            {field.options.map((o) => {
              const on = chosen.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(on ? chosen.filter((v) => v !== o.value) : [...chosen, o.value])}
                  className={cn("rounded-md border px-2 py-1 transition-colors duration-(--motion-fast)", on ? "bg-primary/12 text-primary border-primary/40" : "hover:bg-muted")}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          {hint}
        </fieldset>
      );
    }
    case "number":
    case "integer":
      return (
        <label className="flex flex-col gap-1 text-xs">
          {label}
          <Input
            type="number"
            autoFocus={autoFocus}
            required={field.required}
            min={field.minimum}
            max={field.maximum}
            step={field.type === "integer" ? 1 : "any"}
            value={typeof value === "number" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          />
          {hint}
        </label>
      );
    default:
      return (
        <label className="flex flex-col gap-1 text-xs">
          {label}
          <Input
            type={field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : field.format === "date-time" ? "datetime-local" : "text"}
            autoComplete="off"
            autoFocus={autoFocus}
            required={field.required}
            minLength={field.minLength}
            maxLength={field.maxLength}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
          {hint}
        </label>
      );
  }
}
