import { ChevronRightIcon, EyeIcon, EyeOffIcon, PlusIcon, Undo2Icon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { CustomAuth, CustomModelSource, ProviderInfo } from "@shared/types";
import { deploymentIdOf, normalizeCustomBaseURL, TRANSPORT_LIMITS, type ConnectionFieldReason, type CustomAuthMode } from "@shared/provider-transport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { t, type PlainMessageKey } from "@/i18n";
import { formatList } from "@/i18n/format";
import { api, ApiError } from "@/lib/api";
import { errorText } from "@/lib/error-text";
import { cn } from "@/lib/utils";
import {
  authChanged,
  formFieldOf,
  formPayload,
  formProblems,
  idListOf,
  newRow,
  originChanged,
  rowKeeps,
  settledRows,
  type FormState,
  type Kind,
  type Row,
} from "./custom-connection-state";

// One form for creating and editing custom OpenAI-compatible connections, own or admin scope. Secrets
// typed here live only in this component's memory: never storage, the URL, or an error reporter, and
// they are cleared after a successful save. Saved values are never requested; a saved row shows a
// fixed placeholder. The server is the authority; these checks only give feedback early.

const REASON_KEYS: Record<ConnectionFieldReason, PlainMessageKey> = {
  required: "providers.reasonRequired",
  too_long: "providers.reasonTooLong",
  too_many: "providers.reasonTooMany",
  control_character: "providers.reasonControl",
  invalid_unicode: "providers.reasonUnicode",
  whitespace: "providers.reasonWhitespace",
  invalid_name: "providers.reasonInvalidName",
  reserved_header: "providers.reasonReservedHeader",
  duplicate: "providers.reasonDuplicate",
  auth_header_collision: "providers.reasonAuthCollision",
  invalid_url: "providers.reasonInvalidUrl",
  secret_reentry_required: "providers.reasonReenter",
  key_not_allowed: "providers.reasonKeyNotAllowed",
  deployment_mismatch: "providers.reasonDeploymentMismatch",
  unsupported_field: "providers.reasonUnsupported",
  invalid_value: "providers.reasonInvalidValue",
  changed: "providers.reasonChanged",
};

const reasonText = (reason: string) => t(REASON_KEYS[reason as ConnectionFieldReason] ?? "providers.reasonInvalidValue");

/** Fields the form renders an inline error for; anything else needs the general alert. */
const hasInlineSlot = (field: string) =>
  field === "name" || field === "baseURL" || field === "apiKey" || field === "transport.auth.headerName" ||
  field === "transport.headers" || field === "transport.query" || field === "modelSource" || field === "modelSource.ids" ||
  /^transport\.(headers|query)\.\d+\.(name|value)$/.test(field) || /^modelSource\.ids\.\d+$/.test(field);

const fieldId = (base: string, field: string) => `${base}-${field.replace(/\./g, "-")}`;

/** Create (no provider) or edit a custom connection. */
export function CustomConnectionForm({ provider, base, onSaved, onCancel, autoFocus }: {
  provider?: ProviderInfo;
  base: string;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const uid = useId();
  // A shared connection seen by an audience member carries no configuration: an own override starts from
  // defaults and is created as a new row.
  const own = !!provider && !provider.shared;
  const summary = own ? provider.transport : undefined;
  const savedAuth: CustomAuth = summary?.auth ?? { mode: "bearer" };
  const savedSource: CustomModelSource = (own ? provider.modelSource : undefined) ?? { mode: "discover" };
  const hasSavedKey = !!summary?.hasApiKey;
  const initialAdvanced = !!summary && (savedAuth.mode !== "bearer" || summary.headers.length > 0 || summary.query.length > 0 || savedSource.mode !== "discover");

  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [removeKey, setRemoveKey] = useState(false);
  const [authMode, setAuthMode] = useState<CustomAuthMode>(savedAuth.mode);
  const [headerName, setHeaderName] = useState(savedAuth.mode === "api-key" ? savedAuth.headerName : "api-key");
  const [headers, setHeaders] = useState<Row[]>(() => (summary?.headers ?? []).map((row) => newRow(row.name)));
  const [query, setQuery] = useState<Row[]>(() => (summary?.query ?? []).map((row) => newRow(row.name)));
  const [sourceMode, setSourceMode] = useState<CustomModelSource["mode"]>(savedSource.mode);
  const [ids, setIds] = useState(savedSource.mode === "manual" ? savedSource.ids.join("\n") : "");
  const [open, setOpen] = useState(initialAdvanced);
  const [submitted, setSubmitted] = useState(false);
  const [serverField, setServerField] = useState<{ field: string; reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const state: FormState = {
    own,
    creating: !provider,
    name,
    baseURL,
    savedBaseURL: own ? provider.baseURL : undefined,
    apiKey,
    removeKey,
    hasSavedKey,
    savedAuth,
    authMode,
    headerName,
    headers,
    query,
    savedHeaderCount: summary?.headers.length ?? 0,
    savedQueryCount: summary?.query.length ?? 0,
    sourceMode,
    ids,
    savedSource,
  };
  const changedAuth = authChanged(state);
  const moved = originChanged(state);
  const idList = idListOf(ids);
  const deployment = deploymentIdOf(baseURL.trim());
  const problems = formProblems(state);

  const shownProblems = new Map<string, string>();
  for (const [field, reason] of problems) {
    // Name rules show while typing (reserved headers especially); everything else after a submit attempt.
    if (submitted || field.endsWith(".name") || field === "transport.auth.headerName" || reason === "secret_reentry_required") {
      if (!shownProblems.has(field)) shownProblems.set(field, reason);
    }
  }
  if (serverField && !shownProblems.has(serverField.field)) shownProblems.set(serverField.field, serverField.reason);
  const problemOf = (field: string) => shownProblems.get(field);

  const focusField = (field: string) => {
    if (field.startsWith("transport") || field.startsWith("modelSource")) setOpen(true);
    // After the disclosure renders its fields.
    requestAnimationFrame(() => {
      const exact = document.getElementById(fieldId(uid, field));
      const parent = exact ?? document.getElementById(fieldId(uid, field.split(".").slice(0, 2).join(".")));
      parent?.focus();
    });
  };

  const submit = async () => {
    setSubmitted(true);
    setServerField(null);
    setError(null);
    setSaved(false);
    if (problems.length) {
      focusField(problems[0]![0]);
      return;
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!provider && !slug) return setError(t("providers.nameRequired"));
    const id = provider?.id ?? `custom-${slug}`;
    setBusy(true);
    try {
      await api(`${base}/${id}`, { method: "PUT", json: formPayload(state) });
      // Typed secrets leave memory as soon as the server has them.
      setApiKey("");
      setRemoveKey(false);
      setHeaders(settledRows);
      setQuery(settledRows);
      setSubmitted(false);
      setSaved(true);
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.field && e.reason) {
        const field = formFieldOf(e.field, state);
        setServerField({ field, reason: e.reason });
        // Some server fields (a row conflict, the disclosure itself, an indexed id) have no inline slot.
        // Without this the save would fail silently; still show the safe reason text.
        if (!hasInlineSlot(field)) setError(reasonText(e.reason));
        focusField(field);
      } else setError(errorText(e, "common.somethingWentWrong"));
    } finally {
      setBusy(false);
    }
  };

  const describe = (field: string, help?: string) => {
    const ids = [problemOf(field) ? `${fieldId(uid, field)}-error` : "", help ?? ""].filter(Boolean).join(" ");
    return ids || undefined;
  };

  const fieldError = (field: string) =>
    problemOf(field) ? (
      <p id={`${fieldId(uid, field)}-error`} className="text-error settings-error text-xs">
        {reasonText(problemOf(field)!)}
      </p>
    ) : null;

  const updateRow = (kind: Kind, key: string, patch: Partial<Row>) =>
    (kind === "headers" ? setHeaders : setQuery)((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const rowEditor = (kind: Kind, rows: Row[]) =>
    rows.map((row, index) => {
      const nameField = `transport.${kind}.${index}.name`;
      const valueField = `transport.${kind}.${index}.value`;
      const label = row.name || row.savedName || t("providers.customRowUnnamed");
      const keeps = rowKeeps(kind, row);
      if (row.removed) {
        return (
          <div key={row.key} className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 break-all">{t("providers.customRowRemoved", { name: label })}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="pointer-coarse:h-9"
              aria-label={t("providers.customUndoRemove", { name: label })}
              onClick={() => updateRow(kind, row.key, { removed: false })}
            >
              <Undo2Icon /> {t("providers.customUndo")}
            </Button>
          </div>
        );
      }
      return (
        <div key={row.key} className="grid gap-1.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-start">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={fieldId(uid, nameField)} className="sr-only">
              {t("providers.customRowName")}
            </label>
            <Input
              id={fieldId(uid, nameField)}
              placeholder={t("providers.customRowName")}
              value={row.name}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!problemOf(nameField) || undefined}
              aria-describedby={describe(nameField)}
              // A rename drops the saved value: it is a delete plus a create.
              onChange={(e) => updateRow(kind, row.key, { name: e.target.value })}
            />
            {fieldError(nameField)}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={fieldId(uid, valueField)} className="sr-only">
              {t("providers.customRowValueOf", { name: label })}
            </label>
            <div className="flex gap-1">
              <Input
                id={fieldId(uid, valueField)}
                type={row.revealed ? "text" : "password"}
                placeholder={keeps && !moved ? t("providers.customSavedValue") : keeps ? t("providers.customReenter") : t("providers.customRowValue")}
                value={row.value}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!problemOf(valueField) || undefined}
                aria-describedby={describe(valueField)}
                onChange={(e) => updateRow(kind, row.key, { value: e.target.value })}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="pointer-coarse:size-10 shrink-0"
                disabled={!row.value}
                aria-pressed={row.revealed}
                aria-label={row.revealed ? t("providers.customHideValue", { name: label }) : t("providers.customShowValue", { name: label })}
                onClick={() => updateRow(kind, row.key, { revealed: !row.revealed })}
              >
                {row.revealed ? <EyeOffIcon /> : <EyeIcon />}
              </Button>
            </div>
            {fieldError(valueField)}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="pointer-coarse:h-10 justify-self-start"
            aria-label={t("providers.customRemoveRow", { name: label })}
            onClick={() => {
              if (row.savedName !== null) updateRow(kind, row.key, { removed: true });
              else (kind === "headers" ? setHeaders : setQuery)((list) => list.filter((item) => item.key !== row.key));
              // Focus the section's add button, which always remains.
              requestAnimationFrame(() => document.getElementById(fieldId(uid, `add-${kind}`))?.focus());
            }}
          >
            <XIcon /> <span className="sm:sr-only">{t("providers.customRemove")}</span>
          </Button>
        </div>
      );
    });

  const keyPlaceholder = removeKey
    ? t("providers.customKeyWillRemove")
    : hasSavedKey && authMode !== "headers"
      ? moved || changedAuth ? t("providers.customReenter") : t("providers.customSavedValue")
      : authMode === "api-key" ? t("providers.apiKey") : t("providers.apiKeyOptional");

  const preview = (() => {
    const url = normalizeCustomBaseURL(baseURL.trim());
    if ("reason" in url) return null;
    const live = (rows: Row[]) => rows.filter((row) => !row.removed && row.name).map((row) => row.name);
    const authLabel = authMode === "bearer" ? t("providers.customAuthBearer") : authMode === "api-key" ? t("providers.customPreviewApiKey", { name: headerName.toLowerCase() }) : t("providers.customAuthHeaders");
    return { address: url.url, authLabel, query: live(query), headers: live(headers).map((n) => n.toLowerCase()) };
  })();

  const summaryCount = problems.length;

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {!provider && (
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId(uid, "name")} className="text-xs font-medium">
            {t("providers.customNameLabel")}
          </label>
          <Input
            id={fieldId(uid, "name")}
            autoFocus={autoFocus}
            placeholder={t("providers.customNamePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!problemOf("name") || undefined}
            aria-describedby={describe("name")}
          />
          {fieldError("name")}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId(uid, "baseURL")} className="text-xs font-medium">
          {t("providers.customBaseUrlLabel")}
        </label>
        <Input
          id={fieldId(uid, "baseURL")}
          autoFocus={autoFocus && !!provider}
          placeholder={t("providers.customBaseUrlPlaceholder")}
          value={baseURL}
          spellCheck={false}
          onChange={(e) => setBaseURL(e.target.value)}
          aria-invalid={!!problemOf("baseURL") || undefined}
          aria-describedby={describe("baseURL", moved ? `${uid}-origin` : undefined)}
        />
        {fieldError("baseURL")}
        {moved && (
          <p id={`${uid}-origin`} className="text-warning text-xs">
            {t("providers.customOriginChanged")}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId(uid, "apiKey")} className="text-xs font-medium">
          {authMode === "api-key" ? t("providers.customKeyInHeader", { name: headerName.toLowerCase() || "api-key" }) : t("providers.apiKey")}
        </label>
        <div className="flex flex-wrap gap-1">
          <Input
            id={fieldId(uid, "apiKey")}
            className="min-w-0 flex-1"
            type={keyRevealed ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            disabled={authMode === "headers" || removeKey}
            placeholder={authMode === "headers" ? t("providers.customKeyHeadersMode") : keyPlaceholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-invalid={!!problemOf("apiKey") || undefined}
            aria-describedby={describe("apiKey", changedAuth && hasSavedKey ? `${uid}-auth-warning` : undefined)}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="pointer-coarse:size-10 shrink-0"
            disabled={!apiKey}
            aria-pressed={keyRevealed}
            aria-label={keyRevealed ? t("providers.customHideKey") : t("providers.customShowKey")}
            onClick={() => setKeyRevealed((value) => !value)}
          >
            {keyRevealed ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
          {hasSavedKey && authMode !== "headers" && (
            <Button type="button" size="sm" variant="outline" className="pointer-coarse:h-10" onClick={() => { setRemoveKey((value) => !value); setApiKey(""); }}>
              {removeKey ? t("providers.customKeepKey") : t("providers.removeKey")}
            </Button>
          )}
        </div>
        {fieldError("apiKey")}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-3">
        <button
          type="button"
          className="flex items-center gap-1.5 text-start text-sm font-medium"
          aria-expanded={open}
          aria-controls={`${uid}-advanced`}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRightIcon className={cn("size-4 transition-transform duration-(--motion-fast)", open && "rotate-90")} aria-hidden />
          {t("providers.customAdvanced")}
        </button>
        {open && (
          <div id={`${uid}-advanced`} className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-medium">{t("providers.customAuthLegend")}</legend>
              <Select<CustomAuthMode>
                aria-label={t("providers.customAuthLegend")}
                value={authMode}
                onValueChange={(mode) => {
                  setAuthMode(mode);
                  if (mode === "headers") setApiKey("");
                }}
                options={[
                  { value: "bearer", label: t("providers.customAuthBearer") },
                  { value: "api-key", label: t("providers.customAuthApiKey") },
                  { value: "headers", label: t("providers.customAuthHeaders") },
                ]}
              />
              {authMode === "api-key" && (
                <div className="flex flex-col gap-1">
                  <label htmlFor={fieldId(uid, "transport.auth.headerName")} className="text-xs">
                    {t("providers.customAuthHeaderName")}
                  </label>
                  <Input
                    id={fieldId(uid, "transport.auth.headerName")}
                    value={headerName}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setHeaderName(e.target.value)}
                    aria-invalid={!!problemOf("transport.auth.headerName") || undefined}
                    aria-describedby={describe("transport.auth.headerName", `${uid}-auth-help`)}
                  />
                  <p id={`${uid}-auth-help`} className="text-muted-foreground text-xs">
                    {t("providers.customAuthHeaderHelp")}
                  </p>
                  {fieldError("transport.auth.headerName")}
                </div>
              )}
              {changedAuth && hasSavedKey && (
                <p id={`${uid}-auth-warning`} className="text-warning text-xs">
                  {authMode === "headers" ? t("providers.customHeadersModeWarning") : t("providers.customAuthSwitchWarning")}
                </p>
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-2" aria-describedby={`${uid}-query-help`}>
              <legend className="mb-1 text-xs font-medium">{t("providers.customQueryLegend")}</legend>
              <p id={`${uid}-query-help`} className="text-muted-foreground text-xs">
                {t("providers.customQueryHelp")}
              </p>
              {rowEditor("query", query)}
              {fieldError("transport.query")}
              <Button
                id={fieldId(uid, "add-query")}
                type="button"
                size="sm"
                variant="outline"
                className="pointer-coarse:h-10 self-start"
                disabled={query.filter((row) => !row.removed).length >= TRANSPORT_LIMITS.queryRows}
                onClick={() => setQuery((rows) => [...rows, newRow()])}
              >
                <PlusIcon /> {t("providers.customAddQuery")}
              </Button>
            </fieldset>

            <fieldset className="flex flex-col gap-2" aria-describedby={`${uid}-reserved`}>
              <legend className="mb-1 text-xs font-medium">{t("providers.customHeadersLegend")}</legend>
              <p id={`${uid}-reserved`} className="text-muted-foreground text-xs">
                {t("providers.customReservedNote")}
              </p>
              {rowEditor("headers", headers)}
              {fieldError("transport.headers")}
              <Button
                id={fieldId(uid, "add-headers")}
                type="button"
                size="sm"
                variant="outline"
                className="pointer-coarse:h-10 self-start"
                disabled={headers.filter((row) => !row.removed).length >= TRANSPORT_LIMITS.headerRows}
                onClick={() => setHeaders((rows) => [...rows, newRow()])}
              >
                <PlusIcon /> {t("providers.customAddHeader")}
              </Button>
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-medium">{t("providers.customModelSource")}</legend>
              <Select<CustomModelSource["mode"]>
                aria-label={t("providers.customModelSource")}
                value={sourceMode}
                onValueChange={setSourceMode}
                options={[
                  { value: "discover", label: t("providers.customModelDiscover") },
                  { value: "manual", label: t("providers.customModelManual") },
                ]}
              />
              <span id={fieldId(uid, "modelSource")} tabIndex={-1} className="sr-only">
                {t("providers.customModelSource")}
              </span>
              {sourceMode === "discover" ? (
                <p className="text-muted-foreground text-xs">{t("providers.customDiscoverHelp")}</p>
              ) : (
                <div className="flex flex-col gap-1">
                  <label htmlFor={fieldId(uid, "modelSource.ids")} className="text-xs">
                    {t("providers.customModelIds")}
                  </label>
                  <Textarea
                    id={fieldId(uid, "modelSource.ids")}
                    value={ids}
                    spellCheck={false}
                    onChange={(e) => setIds(e.target.value)}
                    aria-invalid={!!problemOf("modelSource.ids") || undefined}
                    aria-describedby={describe("modelSource.ids", `${uid}-ids-help`)}
                  />
                  <p id={`${uid}-ids-help`} className="text-muted-foreground text-xs">
                    {t("providers.customModelIdsHelp")}
                  </p>
                  {fieldError("modelSource.ids")}
                </div>
              )}
              {deployment !== null && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-muted-foreground text-xs">{t("providers.customDeploymentHelp", { id: deployment })}</p>
                  <p className="text-muted-foreground text-xs">{t("providers.customAzureHelp")}</p>
                  {(sourceMode !== "manual" || idList.join("\n") !== deployment) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="pointer-coarse:h-10 self-start"
                      onClick={() => {
                        setSourceMode("manual");
                        setIds(deployment);
                      }}
                    >
                      {t("providers.customUseDeployment", { id: deployment })}
                    </Button>
                  )}
                </div>
              )}
              {fieldError("modelSource")}
            </fieldset>

            {preview && (
              <div className="bg-muted/40 flex flex-col gap-0.5 rounded-md p-2 text-xs break-all">
                <span className="font-medium">{t("providers.customPreview")}</span>
                <span>{t("providers.customPreviewAddress", { address: preview.address })}</span>
                <span>{t("providers.customPreviewAuth", { auth: preview.authLabel })}</span>
                {preview.query.length > 0 && <span>{t("providers.customPreviewQuery", { names: formatList(preview.query) })}</span>}
                {preview.headers.length > 0 && <span>{t("providers.customPreviewHeaders", { names: formatList(preview.headers) })}</span>}
              </div>
            )}
            <p className="text-muted-foreground text-xs">{t("providers.customMediaNote")}</p>
          </div>
        )}
      </div>

      <div role="status" aria-live="polite" className="text-xs">
        {submitted && summaryCount > 0 ? (
          <span className="text-error settings-error">{t("providers.customErrorSummary", { count: summaryCount })}</span>
        ) : saved ? (
          <span className="text-success">{t("providers.customSaved")}</span>
        ) : null}
      </div>
      {error && <p className="text-error settings-error text-xs">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {own ? t("providers.customSave") : provider ? t("common.connect") : t("providers.addProvider")}
        </Button>
      </div>
    </form>
  );
}
