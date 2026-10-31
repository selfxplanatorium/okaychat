import { AlertTriangleIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ModelAccessPolicy, ModelAccessTarget, ProviderInfo, ProviderModelAccess } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import { SelectionCheck } from "@/components/ui/selection";
import { t } from "@/i18n";
import { formatTokens } from "@/i18n/format";
import { api } from "@/lib/api";
import { Capabilities, modelPrice } from "@/components/chat/ModelPicker";
import { useDirectory } from "./Audience";

// Per-audience model policies for an admin's shared provider key. One draft per audience target, so
// switching audiences never copies a selection onto another. See docs/implementation/entitlements.md.

type Draft = { mode: "all" | "selected"; ids: ReadonlySet<string> };
const keyOf = (target: ModelAccessTarget) => `${target.kind}:${target.id}`;

function draftOf(policy: ModelAccessPolicy): Draft {
  return { mode: policy.mode, ids: new Set(policy.mode === "selected" ? policy.modelIds : []) };
}

/** Opens from the Models… button on an admin server key row. */
export function ModelEntitlementsDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: ProviderInfo | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { users, groups } = useDirectory();
  const [data, setData] = useState<ProviderModelAccess | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const providerId = provider?.id;

  useEffect(() => {
    if (!providerId) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setQuery("");
    setData(null);
    api<ProviderModelAccess>(`/admin/providers/${providerId}/entitlements`)
      .then((next) => {
        if (!live) return;
        setData(next);
        setDrafts(Object.fromEntries(next.policies.map((policy) => [keyOf(policy.target), draftOf(policy)])));
        setCurrent(next.policies[0] ? keyOf(next.policies[0].target) : null);
      })
      .catch((error: unknown) => {
        if (live) setLoadError((error as Error).message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [providerId, attempt]);

  const label = (target: ModelAccessTarget) => {
    if (target.kind === "everyone") return t("audience.everyone");
    if (target.kind === "group") return t("entitlements.targetGroup", { name: groups.find((group) => group.id === target.id)?.name ?? target.id });
    return t("entitlements.targetUser", { name: users.find((user) => user.id === target.id)?.name ?? target.id });
  };

  const policies = data?.policies ?? [];
  const target = current ?? (policies[0] ? keyOf(policies[0].target) : null);
  const draft = target ? drafts[target] : undefined;
  const models = data?.models ?? [];
  const catalogIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const missing = draft?.mode === "selected" ? [...draft.ids].filter((id) => !catalogIds.has(id)) : [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(q)) : models;
  }, [models, query]);

  const update = (change: (draft: Draft) => Draft) => {
    if (!target) return;
    setDrafts((all) => ({ ...all, [target]: change(all[target] ?? { mode: "all", ids: new Set() }) }));
  };
  const toggle = (id: string) =>
    update((draft) => {
      const ids = new Set(draft.ids);
      if (!ids.delete(id)) ids.add(id);
      return { ...draft, ids };
    });
  const selectAll = () => update((draft) => ({ ...draft, ids: new Set([...models.map((model) => model.id), ...missing]) }));

  const save = async () => {
    if (!data || !provider) return;
    setBusy(true);
    setSaveError(null);
    try {
      const next = data.policies.map((policy) => {
        const value = drafts[keyOf(policy.target)] ?? draftOf(policy);
        return { target: policy.target, mode: value.mode, modelIds: value.mode === "selected" ? [...value.ids] : [] };
      });
      await api(`/admin/providers/${provider.id}/entitlements`, { method: "PUT", json: { policies: next } });
      await onSaved();
      onClose();
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rowClass =
    "hover:bg-accent focus-visible:bg-accent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors duration-(--motion-fast) pointer-coarse:py-2.5";

  return (
    <Dialog open={provider !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent showCloseButton={false} className="flex max-h-[min(90dvh,46rem)] flex-col gap-4 overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">{t("entitlements.title", { name: provider?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("entitlements.description")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
            <Loader2Icon className="animate-spin" /> {t("entitlements.loading")}
          </p>
        ) : loadError ? (
          <div className="flex flex-col items-start gap-2 py-4">
            <p role="alert" className="text-error text-sm">{t("entitlements.loadFailed")}</p>
            <p className="text-muted-foreground text-xs">{loadError}</p>
            <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              {t("common.tryAgain")}
            </Button>
          </div>
        ) : data && policies.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("entitlements.noAudiences")}</p>
        ) : data && draft && target ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {policies.length > 1 ? (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground shrink-0 text-xs">{t("entitlements.audience")}</span>
                <Select
                  aria-label={t("entitlements.audience")}
                  value={target}
                  onValueChange={setCurrent}
                  options={policies.map((policy) => ({ value: keyOf(policy.target), label: label(policy.target) }))}
                />
              </div>
            ) : (
              <p className="text-sm font-medium">{label(policies[0]!.target)}</p>
            )}

            <Select
              aria-label={draft.mode === "all" ? t("entitlements.policyAll") : t("entitlements.policySelected")}
              value={draft.mode}
              onValueChange={(mode) => update((value) => ({ ...value, mode }))}
              options={[
                { value: "all", label: t("entitlements.policyAll") },
                { value: "selected", label: t("entitlements.policySelected") },
              ]}
            />

            {draft.mode === "all" ? (
              <p className="text-muted-foreground text-xs">{t("entitlements.allHint")}</p>
            ) : (
              <>
                <p className="text-muted-foreground text-xs">{t("entitlements.selectedHint")}</p>
                <div className="relative">
                  <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                  <Input
                    aria-label={t("entitlements.searchModels")}
                    placeholder={t("entitlements.searchModels")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-8 pl-8"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="xs" variant="outline" onClick={selectAll} disabled={!models.length && !missing.length} className="pointer-coarse:h-9">
                    {t("entitlements.all")}
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => update((value) => ({ ...value, ids: new Set() }))} disabled={!draft.ids.size} className="pointer-coarse:h-9">
                    {t("entitlements.none")}
                  </Button>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {t("entitlements.selectedCount", { selected: draft.ids.size, total: models.length })}
                  </span>
                </div>
                <ScrollArea className="bg-muted/40 max-h-[min(24rem,40dvh)] min-h-24 rounded-lg border">
                  <div role="group" aria-label={t("entitlements.searchModels")} className="flex flex-col p-1">
                    {missing.length > 0 && (
                      <div className="border-warning/40 bg-warning/5 mb-1 rounded-md border p-1.5">
                        <p className="text-warning flex items-center gap-1.5 px-1 py-0.5 text-xs font-medium">
                          <AlertTriangleIcon className="size-3.5" aria-hidden /> {t("entitlements.missingTitle")}
                        </p>
                        <p className="text-muted-foreground px-1 pb-1 text-[11px]">{t("entitlements.missingHint")}</p>
                        {missing.map((id) => (
                          <button
                            key={id}
                            type="button"
                            role="checkbox"
                            aria-checked
                            aria-label={t("entitlements.removeMissing", { id })}
                            onClick={() => toggle(id)}
                            className={rowClass}
                          >
                            <SelectionCheck checked />
                            <AlertTriangleIcon className="text-warning size-3.5 shrink-0" aria-hidden />
                            <span className="truncate">{t("entitlements.missingModel", { id })}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {shown.map((model) => {
                      const checked = draft.ids.has(model.id);
                      const price = modelPrice(model);
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          onClick={() => toggle(model.id)}
                          className={rowClass}
                        >
                          <SelectionCheck checked={checked} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate">{model.name}</span>
                              <Capabilities model={model} />
                            </span>
                            <span className="text-muted-foreground flex gap-2 text-[11px] tabular-nums">
                              <span>{t("composer.contextWindow", { tokens: formatTokens(model.context) })}</span>
                              {price && <span>{price}</span>}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                    {shown.length === 0 && (
                      <p className="text-muted-foreground px-3 py-6 text-center text-sm">
                        {models.length === 0 ? t("entitlements.noModels") : t("common.none")}
                      </p>
                    )}
                  </div>
                </ScrollArea>
                {models.length === 0 && <p className="text-muted-foreground text-xs">{t("entitlements.noModelsHint")}</p>}
              </>
            )}
          </div>
        ) : null}

        {saveError && <p role="alert" className="text-error text-xs">{saveError}</p>}
        <DialogFooter>
          <DialogClose type="button" disabled={busy} render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button type="button" disabled={busy || loading || !data || !data.policies.length} onClick={() => void save()}>
            {busy && <Loader2Icon className="animate-spin" />} {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
