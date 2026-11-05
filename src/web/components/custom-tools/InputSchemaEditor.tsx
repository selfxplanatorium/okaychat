import { useState } from "react";
import type { InputSchema } from "@shared/custom-tools";
import { validateInputSchema } from "@shared/custom-tools";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { VALIDATION_KEY } from "./custom-tool-keys";
import { SchemaFieldEditor } from "./SchemaFieldEditor";

/** Builder and raw JSON are two views of the same supported subset. Switching waits for a valid schema. */
export function InputSchemaEditor({ value, onChange, disabled }: { value: InputSchema; onChange: (schema: InputSchema) => void; disabled?: boolean }) {
  const [mode, setMode] = useState<"builder" | "json">("builder");
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const openJson = () => {
    setJson(JSON.stringify(value, null, 2));
    setError(null);
    setMode("json");
  };
  const applyJson = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setError(t("customTools.rawJsonInvalid"));
      return;
    }
    const validated = validateInputSchema(parsed);
    if (!validated.ok) {
      setError(validated.issues[0] ? t(VALIDATION_KEY[validated.issues[0].reason]) : t("customTools.invalidSchema"));
      return;
    }
    onChange(validated.value);
    setError(null);
    setMode("builder");
  };
  return (
    <section aria-labelledby="custom-tool-schema-heading">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 id="custom-tool-schema-heading" className="text-sm font-medium">{t("customTools.inputSchema")}</h3>
        <div role="tablist" aria-label={t("customTools.inputSchema")} className="flex gap-1">
          <Button type="button" size="sm" variant={mode === "builder" ? "default" : "outline"} role="tab" aria-selected={mode === "builder"} onClick={() => setMode("builder")}>
            {t("customTools.schemaBuilder")}
          </Button>
          <Button type="button" size="sm" variant={mode === "json" ? "default" : "outline"} role="tab" aria-selected={mode === "json"} onClick={openJson}>
            {t("customTools.schemaJson")}
          </Button>
        </div>
      </div>
      {mode === "builder" && !validateInputSchema(value).ok && <p role="alert" className="text-destructive mb-2 text-xs">{t("customTools.builderInvalid")}</p>}
      {mode === "builder" ? (
        <SchemaFieldEditor
          depth={0}
          lockType
          field={value}
          onChange={(schema) => onChange(schema as InputSchema)}
        />
      ) : (
        <div className="grid gap-2">
          <Textarea aria-label={t("customTools.schemaJson")} rows={14} className="font-mono text-xs" value={json} onChange={(event) => setJson(event.target.value)} disabled={disabled} />
          {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
          <Button type="button" size="sm" className="w-fit" onClick={applyJson} disabled={disabled}>{t("customTools.save")}</Button>
        </div>
      )}
    </section>
  );
}
