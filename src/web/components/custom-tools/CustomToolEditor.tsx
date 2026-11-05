import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeftIcon, SaveIcon, Trash2Icon } from "lucide-react";
import type { CustomToolIcon, CustomToolKind, HttpConfig, PythonConfig, SecretPatch, ToolDetail, ToolWrite } from "@shared/custom-tools";
import { CUSTOM_TOOL_ICONS, CUSTOM_LIMITS, PYTHON_SAMPLE, validateToolWrite } from "@shared/custom-tools";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { useCommand } from "@/keyboard/registry";
import { useCustomTools } from "@/state/custom-tools";
import { VALIDATION_KEY } from "./custom-tool-keys";
import { HttpToolEditor } from "./HttpToolEditor";
import { InputSchemaEditor } from "./InputSchemaEditor";
import { PythonToolEditor } from "./PythonToolEditor";
import { CustomToolTestPanel } from "./CustomToolTestPanel";
import { customToolsHref } from "@/lib/custom-tool-link";

const ICON_KEY = {
  wrench: "customTools.iconWrench",
  code: "customTools.iconCode",
  globe: "customTools.iconGlobe",
  calculator: "customTools.iconCalculator",
  database: "customTools.iconDatabase",
  "file-json": "customTools.iconFileJson",
} as const;

const defaultWrite = (kind: CustomToolKind): ToolWrite => ({
  name: "",
  description: "",
  icon: kind === "python" ? "code" : "globe",
  enabled: false,
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  config: kind === "python"
    ? { kind: "python", code: PYTHON_SAMPLE, timeoutMs: 10_000 }
    : { kind: "http", origin: "", path: "/", method: "GET", query: [], headers: [], body: null, response: "json", timeoutMs: 10_000 },
});

export function CustomToolEditor({ userId, detail, newKind, onBack }: {
  userId: string;
  detail: ToolDetail | null;
  newKind: CustomToolKind | null;
  onBack: () => void;
}) {
  const kind = detail?.kind ?? newKind ?? "python";
  const [draft, setDraft] = useState<ToolWrite>(() => detail ? writeFromDetail(detail) : defaultWrite(kind));
  const [expectedRevision, setExpectedRevision] = useState(detail?.revision ?? 1);
  const [initialOrigin, setInitialOrigin] = useState(detail?.config.kind === "http" ? detail.config.origin : "");
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [removedSecrets, setRemovedSecrets] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const refresh = useCustomTools((state) => state.refresh);
  const [, navigate] = useLocation();

  const update = (next: ToolWrite) => {
    setDraft(next);
    setDirty(true);
    setSaved(false);
  };

  useEffect(() => {
    if (dirty || !detail) return;
    setDraft(writeFromDetail(detail));
    setExpectedRevision(detail.revision);
    setInitialOrigin(detail.config.kind === "http" ? detail.config.origin : "");
    setSecretValues({});
    setRemovedSecrets([]);
  }, [detail, dirty]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const validation = useMemo(() => validateToolWrite(draft), [draft]);
  const issues = validation.ok ? [] : validation.issues;
  const originChanged = draft.config.kind === "http" && initialOrigin !== "" && initialOrigin !== draft.config.origin;

  const secretsPatch = (): SecretPatch | undefined => {
    const set = Object.fromEntries(Object.entries(secretValues).filter(([, value]) => value.length > 0));
    const patch: SecretPatch = { set, remove: detail ? removedSecrets : [] };
    if (!Object.keys(set).length && !patch.remove.length) return undefined;
    return patch;
  };

  const save = async () => {
    if (!validation.ok) return;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const body = { tool: draft, ...(secretsPatch() ? { secrets: secretsPatch()! } : {}) };
      if (detail) {
        const response = await api<{ tool: ToolDetail }>(`/custom-tools/${encodeURIComponent(detail.id)}`, { method: "PUT", json: { expectedRevision, ...body } });
        setExpectedRevision(response.tool.revision);
        setDirty(false);
        setSaved(true);
        setSecretValues({});
        setRemovedSecrets([]);
        await refresh(userId, response.tool.id);
      } else {
        const response = await api<{ tool: ToolDetail }>("/custom-tools", { method: "POST", json: body });
        setDirty(false);
        setSaved(true);
        await refresh(userId, response.tool.id);
        navigate(customToolsHref({ toolId: response.tool.id }));
      }
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      if (status === 409) setConflict(true);
      setError(failure instanceof Error ? failure.message : t("common.somethingWentWrong"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/custom-tools/${encodeURIComponent(detail.id)}`, { method: "DELETE", json: { expectedRevision } });
      setDeleteOpen(false);
      setDirty(false);
      await refresh(userId, null);
      onBack();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("common.somethingWentWrong"));
    } finally {
      setBusy(false);
    }
  };

  useCommand("customTools.save", () => void save(), validation.ok && !busy);
  useCommand("customTools.delete", () => setDeleteOpen(true), !!detail && !busy);

  const copyDraft = () => {
    const { secrets: _secrets, ...safe } = draft as ToolWrite & { secrets?: unknown };
    void navigator.clipboard?.writeText(JSON.stringify(safe, null, 2)).catch(() => {});
  };

  const requestBack = () => {
    if (dirty) setDiscardOpen(true);
    else onBack();
  };

  const updateConfig = (config: ToolWrite["config"]) => update({ ...draft, config });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6 sm:px-6" data-custom-tool-editor>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={requestBack} aria-label={t("common.back")}>
          <ArrowLeftIcon className="size-4" /> {t("common.back")}
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{detail ? detail.name : t("customTools.newToolTitle", { kind: kind === "python" ? t("customTools.python") : t("customTools.http") })}</h2>
          <p className="text-muted-foreground text-xs">
            {detail ? t("customTools.revision", { revision: expectedRevision }) : t("customTools.unsaved")}
            {dirty ? ` · ${t("customTools.unsaved")}` : saved ? ` · ${t("customTools.saved")}` : ""}
          </p>
        </div>
        <span className="text-muted-foreground text-xs">{t("customTools.kind")}: {kind === "python" ? t("customTools.python") : t("customTools.http")} · {t("customTools.kindImmutable")}</span>
      </div>

      {conflict && (
        <div role="alert" className="border-warning/40 bg-warning/10 mb-3 grid gap-2 rounded-lg border p-3 text-sm">
          <p className="font-medium">{t("customTools.conflict")}</p>
          <p className="text-muted-foreground text-xs">{t("customTools.changedElsewhere")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                // Discard the draft against the stored revision, not just the local flags: saving again
                // with the stale revision would repeat the same conflict.
                setDirty(false);
                setConflict(false);
                void refresh(userId, detail?.id ?? null);
              }}
            >
              {t("customTools.reloadStored")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={copyDraft}>{t("customTools.copyDraft")}</Button>
          </div>
        </div>
      )}
      {error && !conflict && <p role="alert" className="text-destructive mb-3 text-sm">{error}</p>}
      {busy && <p role="status" className="text-muted-foreground mb-3 text-xs">{t("customTools.busy")}</p>}
      {!validation.ok && (
        <div role="alert" className="mb-3 rounded-lg border p-3 text-sm">
          <p className="font-medium">{t("customTools.validationSummary", { count: issues.length })}</p>
          <ul className="text-muted-foreground mt-1 list-disc ps-5 text-xs">
            {issues.slice(0, 5).map((issue, index) => (
              <li key={`${issue.path}-${index}`}>{t("customTools.fieldError", { path: issue.path || "/", reason: t(VALIDATION_KEY[issue.reason]) })}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-5">
        <section className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">
              <span className="text-muted-foreground">{t("customTools.name")}</span>
              <Input className="mt-1" aria-invalid={issues.some((issue) => issue.path === "/name") || undefined} value={draft.name} onChange={(event) => update({ ...draft, name: event.target.value })} maxLength={CUSTOM_LIMITS.nameChars} />
            </label>
            <label className="text-xs">
              <span className="text-muted-foreground">{t("customTools.icon")}</span>
              <Select className="mt-1" aria-label={t("customTools.icon")} value={draft.icon} onValueChange={(icon) => update({ ...draft, icon: icon as CustomToolIcon })} options={CUSTOM_TOOL_ICONS.map((icon) => ({ value: icon, label: t(ICON_KEY[icon]) }))} />
            </label>
          </div>
          <label className="text-xs">
            <span className="text-muted-foreground">{t("customTools.description")}</span>
            <Textarea rows={2} className="mt-1" value={draft.description} onChange={(event) => update({ ...draft, description: event.target.value })} />
          </label>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <span className="text-sm">{t("customTools.enabled")}</span>
            <Switch aria-label={t("customTools.enabled")} checked={draft.enabled} onCheckedChange={(enabled) => update({ ...draft, enabled })} />
          </div>
        </section>

        <InputSchemaEditor value={draft.inputSchema} onChange={(inputSchema) => update({ ...draft, inputSchema })} />

        {draft.config.kind === "python" ? (
          <PythonToolEditor config={draft.config as PythonConfig} onChange={updateConfig} />
        ) : (
          <>
            {originChanged && <p role="alert" className="text-warning text-xs">{t("customTools.originChangeWarning")}</p>}
            <HttpToolEditor
              config={draft.config as HttpConfig}
              schema={draft.inputSchema}
              onChange={updateConfig}
              storedNames={originChanged ? [] : detail?.secretNames ?? []}
              secretValues={secretValues}
              onSecretValue={(name, value) => {
                setSecretValues((current) => ({ ...current, [name]: value }));
                setDirty(true);
              }}
              removedSecrets={removedSecrets}
              onRemoveSecret={(name) => {
                setRemovedSecrets((current) => [...new Set([...current, name])]);
                setSecretValues((current) => {
                  const next = { ...current };
                  delete next[name];
                  return next;
                });
                if (draft.config.kind === "http") updateConfig({ ...draft.config, headers: draft.config.headers.filter((header) => !("secret" in header) || header.secret !== name) });
              }}
            />
          </>
        )}

        {detail && <CustomToolTestPanel key={detail.revision} detail={detail} dirty={dirty} onSaved={() => void refresh(userId, detail.id)} />}

        <p className="text-muted-foreground text-xs">{t("customTools.approvalsNote")}</p>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-[color-mix(in_oklch,var(--background),transparent_10%)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <Button type="button" onClick={() => void save()} disabled={busy || !validation.ok} data-command="customTools.save">
            <SaveIcon className="size-4" /> {t("customTools.save")}
          </Button>
          {detail && <Link href={customToolsHref({ toolId: detail.id, panel: "test" })} className="text-muted-foreground hover:text-foreground text-xs">{t("customTools.test")}</Link>}
          <div className="flex-1" />
          {detail && (
            <Button type="button" variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} disabled={busy} data-command="customTools.delete">
              <Trash2Icon className="size-4" /> {t("common.delete")}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("customTools.deleteTitle", { name: draft.name || (kind === "python" ? t("customTools.python") : t("customTools.http") ) })}</DialogTitle>
            <DialogDescription>{t("customTools.deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("customTools.discardTitle")}</DialogTitle>
            <DialogDescription>{t("customTools.discardBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="destructive" onClick={() => { setDiscardOpen(false); setDirty(false); onBack(); }}>{t("customTools.discardTitle")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function writeFromDetail(detail: ToolDetail): ToolWrite {
  return {
    name: detail.name,
    description: detail.description,
    icon: detail.icon,
    enabled: detail.enabled,
    inputSchema: detail.inputSchema,
    config: detail.config,
  };
}
