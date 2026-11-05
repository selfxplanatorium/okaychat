import { PlusIcon, Trash2Icon } from "lucide-react";
import type { FieldSchema, ObjectFieldSchema, ScalarSchema } from "@shared/custom-tools";
import { CUSTOM_LIMITS } from "@shared/custom-tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";

const TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;
type FieldType = (typeof TYPES)[number];

function defaultFor(type: FieldType): FieldSchema {
  switch (type) {
    case "string": return { type: "string" };
    case "number": return { type: "number" };
    case "integer": return { type: "integer" };
    case "boolean": return { type: "boolean" };
    case "array": return { type: "array", maxItems: 10, items: { type: "string" } };
    case "object": return { type: "object", properties: {}, required: [], additionalProperties: false };
  }
}

const isScalar = (field: FieldSchema): field is ScalarSchema =>
  field.type === "string" || field.type === "number" || field.type === "integer" || field.type === "boolean";

export function SchemaFieldEditor({ field, name, required, siblingNames, depth, onChange, onRename, onRemove, onRequiredChange }: {
  field: FieldSchema;
  name?: string;
  required?: boolean;
  siblingNames?: readonly string[];
  depth: number;
  onChange: (field: FieldSchema) => void;
  onRename?: (name: string) => void;
  onRemove?: () => void;
  onRequiredChange?: (required: boolean) => void;
}) {
  const identifier = (value: string) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
  const renameAllowed = (value: string) => identifier(value) && !(siblingNames ?? []).includes(value);
  const switchType = (type: FieldType) => {
    if (type === field.type) return;
    onChange(defaultFor(type));
  };
  return (
    <div className="bg-muted/40 rounded-lg border p-3" data-depth={depth}>
      <div className="flex flex-wrap items-end gap-2">
        {name !== undefined && onRename && (
          <label className="min-w-32 flex-1 text-xs">
            <span className="text-muted-foreground">{t("customTools.fieldName")}</span>
            <Input aria-label={t("customTools.fieldName")} className="mt-1 h-8" value={name} onChange={(event) => {
              if (renameAllowed(event.target.value)) onRename(event.target.value);
            }} />
          </label>
        )}
        <label className="w-32 text-xs">
          <span className="text-muted-foreground">{t("customTools.fieldType")}</span>
          <Select className="mt-1" aria-label={t("customTools.fieldType")} value={field.type} onValueChange={(value) => switchType(value as FieldType)} options={TYPES.map((type) => ({ value: type, label: type }))} />
        </label>
        {required !== undefined && onRequiredChange && (
          <label className="flex items-center gap-1.5 pb-1 text-xs">
            <input type="checkbox" className="size-4" checked={required} onChange={(event) => onRequiredChange(event.target.checked)} />
            {t("customTools.fieldRequired")}
          </label>
        )}
        {onRemove && (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("customTools.removeField")} onClick={onRemove}>
            <Trash2Icon className="size-4" />
          </Button>
        )}
      </div>
      <label className="mt-2 block text-xs">
        <span className="text-muted-foreground">{t("customTools.fieldDescription")}</span>
        <Input aria-label={t("customTools.fieldDescription")} className="mt-1 h-8" value={field.description ?? ""} onChange={(event) => {
          const description = event.target.value.trim();
          onChange({ ...field, ...(description ? { description } : { description: undefined }) });
        }} />
      </label>
      {field.type === "string" && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="text-muted-foreground">{t("customTools.maxLength")}</span>
            <Input type="number" min={1} max={CUSTOM_LIMITS.maxLengthMax} className="mt-1 h-8" value={field.maxLength ?? ""} onChange={(event) => {
              const value = event.target.value ? Number(event.target.value) : undefined;
              onChange({ ...field, maxLength: value });
            }} />
          </label>
          <label className="text-xs">
            <span className="text-muted-foreground">{t("customTools.enumValues")}</span>
            <Textarea rows={2} className="mt-1 text-xs" value={field.enum?.join("\n") ?? ""} onChange={(event) => {
              const values = event.target.value.split("\n").map((item) => item.trim()).filter(Boolean).slice(0, CUSTOM_LIMITS.enumValues);
              onChange({ ...field, ...(values.length ? { enum: values } : { enum: undefined }) });
            }} />
          </label>
        </div>
      )}
      {(field.type === "number" || field.type === "integer") && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="text-muted-foreground">{t("customTools.minimum")}</span>
            <Input type="number" step={field.type === "integer" ? 1 : "any"} className="mt-1 h-8" value={field.minimum ?? ""} onChange={(event) => onChange({ ...field, minimum: event.target.value ? Number(event.target.value) : undefined })} />
          </label>
          <label className="text-xs">
            <span className="text-muted-foreground">{t("customTools.maximum")}</span>
            <Input type="number" step={field.type === "integer" ? 1 : "any"} className="mt-1 h-8" value={field.maximum ?? ""} onChange={(event) => onChange({ ...field, maximum: event.target.value ? Number(event.target.value) : undefined })} />
          </label>
        </div>
      )}
      {field.type === "array" && (
        <div className="mt-3 border-s-2 ps-3">
          <label className="mb-2 block w-32 text-xs">
            <span className="text-muted-foreground">{t("customTools.maxItems")}</span>
            <Input type="number" min={1} max={CUSTOM_LIMITS.maxItemsMax} className="mt-1 h-8" value={field.maxItems} onChange={(event) => onChange({ ...field, maxItems: Number(event.target.value) })} />
          </label>
          <p className="text-muted-foreground mb-1 text-xs">{t("customTools.items")}</p>
          <SchemaFieldEditor depth={depth + 1} field={field.items} onChange={(items) => onChange({ ...field, items })} />
        </div>
      )}
      {field.type === "object" && (
        <ObjectProperties field={field} depth={depth} onChange={onChange} />
      )}
      {isScalar(field) && null}
    </div>
  );
}

function ObjectProperties({ field, depth, onChange }: { field: ObjectFieldSchema; depth: number; onChange: (field: ObjectFieldSchema) => void }) {
  const names = Object.keys(field.properties);
  const add = () => {
    let index = names.length + 1;
    let name = `field${index}`;
    while (field.properties[name]) name = `field${++index}`;
    onChange({ ...field, properties: { ...field.properties, [name]: { type: "string" } } });
  };
  return (
    <div className="mt-3 border-s-2 ps-3">
      {names.map((name) => (
        <div key={name} className="mb-2">
          <SchemaFieldEditor
            depth={depth + 1}
            field={field.properties[name]!}
            name={name}
            siblingNames={names.filter((item) => item !== name)}
            required={field.required.includes(name)}
            onChange={(next) => onChange({ ...field, properties: { ...field.properties, [name]: next } })}
            onRename={(next) => {
              if (next === name) return;
              const properties = { ...field.properties };
              const required = field.required.map((item) => item === name ? next : item);
              const value = properties[name]!;
              delete properties[name];
              properties[next] = value;
              onChange({ ...field, properties, required });
            }}
            onRequiredChange={(required) => onChange({ ...field, required: required ? [...new Set([...field.required, name])] : field.required.filter((item) => item !== name) })}
            onRemove={() => {
              const properties = { ...field.properties };
              delete properties[name];
              onChange({ ...field, properties, required: field.required.filter((item) => item !== name) });
            }}
          />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add} disabled={names.length >= CUSTOM_LIMITS.objectProperties}>
        <PlusIcon className="size-3.5" /> {t("customTools.addField")}
      </Button>
    </div>
  );
}
