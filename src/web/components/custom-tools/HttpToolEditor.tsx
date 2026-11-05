import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { Binding, HttpConfig, InputSchema, JsonTemplate } from "@shared/custom-tools";
import { CUSTOM_LIMITS, HTTP_METHODS, isScalarSchema } from "@shared/custom-tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { VALIDATION_KEY } from "./custom-tool-keys";
import { SecretHeadersEditor } from "./SecretHeadersEditor";

/** Fixed HTTPS request definition. No dynamic origin, no redirects, no browser fetch. */
export function HttpToolEditor({ config, schema, onChange, storedNames, secretValues, onSecretValue, removedSecrets, onRemoveSecret, disabled }: {
  config: HttpConfig;
  schema: InputSchema;
  onChange: (config: HttpConfig) => void;
  storedNames: readonly string[];
  secretValues: Record<string, string>;
  onSecretValue: (name: string, value: string) => void;
  removedSecrets: readonly string[];
  onRemoveSecret: (name: string) => void;
  disabled?: boolean;
}) {
  const [bodyText, setBodyText] = useState(() => config.body ? JSON.stringify(config.body, null, 2) : "");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const scalarFields = Object.entries(schema.properties)
    .filter(([name, field]) => schema.required.includes(name) && isScalarSchema(field))
    .map(([name]) => name);
  const updateQuery = (index: number, value: Binding, name: string) => onChange({ ...config, query: config.query.map((item, i) => i === index ? { name, value } : item) });
  const addQuery = () => onChange({ ...config, query: [...config.query, { name: `param${config.query.length + 1}`, value: scalarFields[0] ? { input: scalarFields[0] } : { literal: "" } }] });
  const applyBody = (text: string) => {
    setBodyText(text);
    if (!text.trim()) {
      setBodyError(null);
      onChange({ ...config, body: null });
      return;
    }
    try {
      const parsed = JSON.parse(text) as JsonTemplate;
      onChange({ ...config, body: parsed });
      setBodyError(null);
    } catch {
      setBodyError(t("customTools.validationInvalidJson"));
    }
  };
  return (
    <section aria-labelledby="custom-tool-http-heading" className="grid gap-3">
      <h3 id="custom-tool-http-heading" className="text-sm font-medium">{t("customTools.http")}</h3>
      <div className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
        <label className="text-xs">
          <span className="text-muted-foreground">{t("customTools.method")}</span>
          <Select className="mt-1" aria-label={t("customTools.method")} value={config.method} onValueChange={(method) => onChange({ ...config, method: method as HttpConfig["method"], ...(method === "GET" || method === "HEAD" ? { body: null } : {}) })} options={HTTP_METHODS.map((method) => ({ value: method, label: method }))} />
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">{t("customTools.origin")}</span>
          <Input className="mt-1" aria-label={t("customTools.origin")} value={config.origin} placeholder="https://api.example.com" onChange={(event) => onChange({ ...config, origin: event.target.value })} disabled={disabled} />
        </label>
      </div>
      <label className="text-xs">
        <span className="text-muted-foreground">{t("customTools.path")}</span>
        <Input className="mt-1 font-mono" aria-label={t("customTools.path")} value={config.path} placeholder="/items/{{id}}" onChange={(event) => onChange({ ...config, path: event.target.value })} disabled={disabled} />
      </label>
      <p className="text-muted-foreground text-xs">{t("customTools.approvalHelp")}</p>
      <div>
        <p className="mb-1 text-xs font-medium">{t("customTools.query")}</p>
        <div className="grid gap-2">
          {config.query.map((item, index) => {
            const mode = "input" in item.value ? "input" : "literal";
            return (
              <div key={index} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_auto]">
                <Input aria-label={t("customTools.queryName")} className="h-8" value={item.name} onChange={(event) => updateQuery(index, item.value, event.target.value)} />
                <Select aria-label={t("customTools.query")} value={mode} onValueChange={(value) => updateQuery(index, value === "input" ? { input: scalarFields[0] ?? "" } : { literal: "" }, item.name)} options={[
                  { value: "input", label: t("customTools.bindingInput") },
                  { value: "literal", label: t("customTools.bindingLiteral") },
                ]} />
                {mode === "input" ? (
                  <Select aria-label={t("customTools.bindingInput")} value={(item.value as { input: string }).input} onValueChange={(value) => updateQuery(index, { input: value }, item.name)} options={scalarFields.map((name) => ({ value: name, label: name }))} />
                ) : (
                  <Input aria-label={t("customTools.bindingLiteral")} className="h-8" value={String((item.value as { literal: string | number | boolean }).literal)} onChange={(event) => updateQuery(index, { literal: event.target.value }, item.name)} />
                )}
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t("customTools.remove")} onClick={() => onChange({ ...config, query: config.query.filter((_, i) => i !== index) })}>
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={addQuery} disabled={config.query.length >= CUSTOM_LIMITS.queryItems}>
          <PlusIcon className="size-3.5" /> {t("customTools.addQuery")}
        </Button>
      </div>
      <SecretHeadersEditor headers={config.headers} onChange={(headers) => onChange({ ...config, headers })} storedNames={storedNames} secretValues={secretValues} onSecretValue={onSecretValue} removedSecrets={removedSecrets} onRemoveSecret={onRemoveSecret} />
      <label className="text-xs">
        <span className="text-muted-foreground">{t("customTools.body")}</span>
        <Textarea rows={8} className="mt-1 font-mono text-xs" aria-label={t("customTools.body")} value={bodyText} placeholder={'{"value":{"input":"field"}}'} onChange={(event) => applyBody(event.target.value)} disabled={disabled || config.method === "GET" || config.method === "HEAD"} />
      </label>
      <p className="text-muted-foreground text-xs">{t("customTools.bodyTemplateHelp")}</p>
      {bodyError && <p role="alert" className="text-destructive text-xs">{bodyError}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs">
          <span className="text-muted-foreground">{t("customTools.responseMode")}</span>
          <Select className="mt-1" aria-label={t("customTools.responseMode")} value={config.response} onValueChange={(response) => onChange({ ...config, response: response as "json" | "text" })} options={[
            { value: "json", label: t("customTools.responseJson") },
            { value: "text", label: t("customTools.responseText") },
          ]} />
        </label>
        <label className="text-xs">
          <span className="text-muted-foreground">{t("customTools.timeout")}</span>
          <Input type="number" min={CUSTOM_LIMITS.httpTimeoutMin} max={CUSTOM_LIMITS.httpTimeoutMax} step={1000} className="mt-1" value={config.timeoutMs} onChange={(event) => onChange({ ...config, timeoutMs: Number(event.target.value) })} disabled={disabled} />
        </label>
      </div>
      <p className="text-muted-foreground text-xs">{t("customTools.weakPoint")}</p>
    </section>
  );
}
