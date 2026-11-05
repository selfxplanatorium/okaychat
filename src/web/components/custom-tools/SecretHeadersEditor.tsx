import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { Header } from "@shared/custom-tools";
import { CUSTOM_LIMITS, headerNeedsSecret } from "@shared/custom-tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { t } from "@/i18n";

/** Write-only secret editor: stored values show as “Stored”, never as a password field to resubmit. */
export function SecretHeadersEditor({ headers, onChange, storedNames, secretValues, onSecretValue, removedSecrets, onRemoveSecret }: {
  headers: Header[];
  onChange: (headers: Header[]) => void;
  storedNames: readonly string[];
  secretValues: Record<string, string>;
  onSecretValue: (name: string, value: string) => void;
  removedSecrets: readonly string[];
  onRemoveSecret: (name: string) => void;
}) {
  const update = (index: number, header: Header) => onChange(headers.map((item, i) => i === index ? header : item));
  const add = () => {
    const name = headers.some((header) => header.name === "x-custom-header") ? `x-custom-header-${headers.length}` : "x-custom-header";
    onChange([...headers, { name, secret: `secret${Object.keys(secretValues).length + 1}` }]);
  };
  const stored = new Set(storedNames.filter((name) => !removedSecrets.includes(name)));
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const replace = (name: string) => setReplacing((current) => new Set(current).add(name));
  return (
    <section aria-labelledby="custom-tool-headers-heading">
      <h3 id="custom-tool-headers-heading" className="mb-2 text-sm font-medium">{t("customTools.headers")}</h3>
      <p className="text-muted-foreground mb-2 text-xs">{t("customTools.secretHelp")}</p>
      <div className="grid gap-2">
        {headers.map((header, index) => {
          const secret = "secret" in header;
          return (
            <div key={index} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1.3fr)]">
              <label className="text-xs">
                <span className="text-muted-foreground">{t("customTools.headerName")}</span>
                <Input aria-label={t("customTools.headerName")} className="mt-1 h-8" value={header.name} onChange={(event) => {
                  const name = event.target.value.toLowerCase();
                  update(index, secret ? { name, secret: header.secret } : { name, value: header.value });
                }} />
              </label>
              <label className="text-xs">
                <span className="text-muted-foreground">{t("customTools.headerValue")}</span>
                <Select className="mt-1" aria-label={t("customTools.headerValue")} value={secret ? "secret" : "value"} onValueChange={(value) => {
                  if (value === "secret") update(index, { name: header.name, secret: `secret${Object.keys(secretValues).length + 1}` });
                  else update(index, { name: header.name, value: "" });
                }} options={[
                  { value: "value", label: t("customTools.bindingLiteral") },
                  { value: "secret", label: t("customTools.secretHeader") },
                ]} />
              </label>
              {secret ? (
                <div className="grid gap-1">
                  <label className="text-xs">
                    <span className="text-muted-foreground">{t("customTools.secretName")}</span>
                    <Input aria-label={t("customTools.secretName")} className="mt-1 h-8" value={header.secret} onChange={(event) => update(index, { name: header.name, secret: event.target.value })} />
                  </label>
                  {replacing.has(header.secret) ? (
                    <Input aria-label={t("customTools.secretValuePlaceholder")} className="h-8" placeholder={t("customTools.secretValuePlaceholder")} value={secretValues[header.secret] ?? ""} onChange={(event) => onSecretValue(header.secret, event.target.value)} />
                  ) : stored.has(header.secret) ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground">{t("customTools.secretStored")}</span>
                      <Button type="button" size="xs" variant="outline" onClick={() => replace(header.secret)}>{t("customTools.secretReplace")}</Button>
                      <Button type="button" size="xs" variant="ghost" onClick={() => onRemoveSecret(header.secret)}>{t("customTools.secretRemove")}</Button>
                    </div>
                  ) : (
                    <Input aria-label={t("customTools.secretValuePlaceholder")} className="h-8" placeholder={t("customTools.secretValuePlaceholder")} value={secretValues[header.secret] ?? ""} onChange={(event) => onSecretValue(header.secret, event.target.value)} />
                  )}
                </div>
              ) : (
                <label className="text-xs">
                  <span className="text-muted-foreground">{t("customTools.headerValue")}</span>
                  <Input aria-label={t("customTools.headerValue")} className="mt-1 h-8" value={header.value} onChange={(event) => update(index, { name: header.name, value: event.target.value })} />
                </label>
              )}
              <div className="sm:col-span-3">
                <Button type="button" size="xs" variant="ghost" onClick={() => onChange(headers.filter((_, i) => i !== index))} aria-label={t("customTools.remove")}>
                  <Trash2Icon className="size-3.5" /> {t("customTools.remove")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <Button type="button" size="sm" variant="outline" className="mt-2" onClick={add} disabled={headers.length >= CUSTOM_LIMITS.headers}>
        <PlusIcon className="size-3.5" /> {t("customTools.addHeader")}
      </Button>
      {replacing.size > 0 && <p className="text-muted-foreground mt-2 text-xs">{t("customTools.headerChangeWarning")}</p>}
      {headers.some((header) => "value" in header && headerNeedsSecret(header.name)) && (
        <p role="alert" className="text-destructive mt-2 text-xs">{t("customTools.validationInvalidHeader")}</p>
      )}
    </section>
  );
}
