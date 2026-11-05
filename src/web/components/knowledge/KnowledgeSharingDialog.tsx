import { CheckIcon, Loader2Icon, SearchIcon, UsersIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { KnowledgeAudienceTarget, KnowledgeOwnedCollection } from "@shared/knowledge";
import type { ShareAudience } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type Mode = "private" | "all" | "selected";

interface SharingState {
  visibility: "private" | "shared";
  audience: ShareAudience;
  revision: number;
}

/**
 * Owner-only publication dialog. Audience choices are never saved as they are toggled: the server compares
 * `expectedRevision`, so two tabs cannot silently widen an audience. A conflict keeps the dialog open and
 * requires an explicit reload rather than merging stale selections.
 */
export function KnowledgeSharingDialog({
  open,
  onOpenChange,
  collection,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collection: KnowledgeOwnedCollection;
  onSaved: (state: SharingState) => void;
}) {
  const [mode, setMode] = useState<Mode>("private");
  const [users, setUsers] = useState<KnowledgeAudienceTarget[]>([]);
  const [groups, setGroups] = useState<KnowledgeAudienceTarget[]>([]);
  const [revision, setRevision] = useState(collection.accessRevision);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"users" | "groups">("users");
  const [results, setResults] = useState<KnowledgeAudienceTarget[]>([]);
  const [knownId, setKnownId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const hydrate = (state: SharingState) => {
    setMode(state.visibility === "private" ? "private" : state.audience.mode === "all" ? "all" : "selected");
    setUsers(state.audience.userIds.map((id) => ({ id, label: id })));
    setGroups(state.audience.groupIds.map((id) => ({ id, label: id })));
    setRevision(state.revision);
    setError(null);
    setConflict(false);
    setNotice(null);
  };

  const reload = async () => {
    setBusy(true);
    try {
      hydrate(await api<SharingState>(`/knowledge/collections/${encodeURIComponent(collection.id)}/sharing`));
    } catch {
      setError(t("knowledge.sharingFailed"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setMode(collection.visibility === "private" ? "private" : collection.audience?.mode === "all" ? "all" : "selected");
    setUsers((collection.audience?.userIds ?? []).map((id) => ({ id, label: id })));
    setGroups((collection.audience?.groupIds ?? []).map((id) => ({ id, label: id })));
    setRevision(collection.accessRevision);
    setQuery("");
    setKnownId("");
    setResults([]);
    setError(null);
    setConflict(false);
    setNotice(null);
    void reload();
    // Only a new open or a different collection resets the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, collection.id]);

  useEffect(() => {
    if (!open || mode !== "selected" || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      const path = `/knowledge/audience-targets?kind=${kind}&q=${encodeURIComponent(query.trim())}`;
      void api<{ items: KnowledgeAudienceTarget[] }>(path)
        .then(({ items }) => { if (live) setResults(items); })
        .catch(() => { if (live) setResults([]); });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [open, mode, query, kind]);

  const selected = kind === "users" ? users : groups;
  const add = (target: KnowledgeAudienceTarget) => {
    if ((kind === "users" ? users : groups).some((entry) => entry.id === target.id)) return;
    if (kind === "users") setUsers((list) => [...list, target]);
    else setGroups((list) => [...list, target]);
    setQuery("");
    setResults([]);
  };
  const remove = (id: string) => {
    if (kind === "users") setUsers((list) => list.filter((entry) => entry.id !== id));
    else setGroups((list) => list.filter((entry) => entry.id !== id));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const body = mode === "private"
        ? { visibility: "private" as const, expectedRevision: revision }
        : {
            visibility: "shared" as const,
            expectedRevision: revision,
            audience: mode === "all"
              ? { mode: "all" as const, userIds: [], groupIds: [] }
              : { mode: "selected" as const, userIds: users.map((entry) => entry.id), groupIds: groups.map((entry) => entry.id) },
          };
      const state = await api<SharingState>(`/knowledge/collections/${encodeURIComponent(collection.id)}/sharing`, { method: "PUT", json: body });
      hydrate(state);
      setNotice(t("knowledge.sharingSaved"));
      onSaved(state);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (/Reload the current audience|409/.test(message)) setConflict(true);
      setError(t("knowledge.sharingFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogTitle className="text-base">{t("knowledge.sharingTitle")}</DialogTitle>
        <DialogDescription className="text-xs">{t("knowledge.sharingHelp")}</DialogDescription>
        {collection.projectId && (
          <p role="alert" className="text-warning text-xs">{t("knowledge.sharingProjectConflict")}</p>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t("knowledge.manageSharing")}</legend>
          {([
            ["private", t("knowledge.sharingPrivate")],
            ["all", t("knowledge.sharingEveryone")],
            ["selected", t("knowledge.sharingSelected")],
          ] as Array<[Mode, string]>).map(([value, label]) => (
            <label key={value} className={cn("flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm pointer-coarse:min-h-12")}>
              <input
                type="radio"
                name="knowledge-sharing"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                className="size-4"
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {mode === "selected" && (
          <div className="flex flex-col gap-2 rounded-lg border px-3 py-2">
            <div className="flex gap-1.5" role="tablist" aria-label={t("knowledge.sharingSelected")}>
              {(["users", "groups"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={kind === value}
                  className={cn("min-h-9 rounded-md px-2.5 text-xs", kind === value ? "bg-primary text-primary-foreground" : "bg-muted")}
                  onClick={() => { setKind(value); setQuery(""); setResults([]); }}
                >
                  {value === "users" ? t("knowledge.audienceUsers") : t("knowledge.audienceGroups")}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {selected.map((entry) => (
                <span key={entry.id} className="bg-muted flex items-center gap-1 rounded-full px-2 py-0.5 text-xs">
                  <UsersIcon aria-hidden className="size-3" />
                  <span className="max-w-40 truncate">{entry.label}</span>
                  <button type="button" aria-label={t("common.remove")} className="hover:bg-muted-foreground/20 rounded-full p-0.5" onClick={() => remove(entry.id)}>
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
              {selected.length === 0 && <span className="text-muted-foreground text-xs">{t("knowledge.audienceNobody")}</span>}
            </div>
            <div className="flex gap-1.5">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("knowledge.audienceSearch")}
                aria-label={t("knowledge.audienceSearch")}
                maxLength={80}
              />
              <span className="text-muted-foreground grid place-items-center"><SearchIcon className="size-4" /></span>
            </div>
            {results.length > 0 && (
              <ul className="flex max-h-40 flex-col overflow-y-auto">
                {results.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => add(item)} className="hover:bg-muted flex min-h-9 w-full items-center justify-between gap-2 rounded px-2 text-start text-xs">
                      <span className="truncate">{item.label}</span>
                      <CheckIcon className="size-3.5 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {query.trim().length >= 2 && results.length === 0 && <p className="text-muted-foreground text-xs">{t("knowledge.audienceEmpty")}</p>}
            <div className="flex gap-1.5">
              <Input value={knownId} onChange={(event) => setKnownId(event.target.value)} placeholder={t("knowledge.audienceKnownId")} aria-label={t("knowledge.audienceKnownId")} maxLength={200} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!knownId.trim()}
                onClick={async () => {
                  try {
                    const { items } = await api<{ items: KnowledgeAudienceTarget[] }>(`/knowledge/audience-targets?kind=${kind}&userId=${encodeURIComponent(knownId.trim())}`);
                    if (items[0]) add(items[0]);
                    setKnownId("");
                  } catch {
                    setError(t("knowledge.audienceEmpty"));
                  }
                }}
              >
                {t("knowledge.audienceAdd")}
              </Button>
            </div>
          </div>
        )}
        {conflict && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="text-destructive text-xs">{t("knowledge.sharingConflict")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>{t("common.retry")}</Button>
          </div>
        )}
        {error && !conflict && <p role="alert" className="text-destructive text-xs">{error}</p>}
        {notice && <p role="status" className="text-muted-foreground text-xs">{notice}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button type="button" disabled={busy || (!!collection.projectId && mode !== "private")} onClick={() => void save()}>
            {busy && <Loader2Icon className="animate-spin motion-reduce:animate-none" />} {t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
