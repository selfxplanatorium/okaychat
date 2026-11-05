import { BoxesIcon, HistoryIcon, Loader2Icon, MessageSquareTextIcon, ScanSearchIcon, Settings2Icon, ShieldCheckIcon, SlidersHorizontalIcon, UsersIcon, UsersRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { settingsHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { usePermissions } from "@/state/permissions";
import {
  isPermissionsSearch,
  parsePermissionsQuery,
  permissionsQueryRecord,
  subjectKey,
  type PermissionsQuery,
  type PermissionsView,
} from "@/state/permissions-query";
import { AuditPage } from "./AuditPage";
import { FeaturesPage } from "./FeaturesPage";
import { GroupsPage } from "./GroupsPage";
import { InspectPage } from "./InspectPage";
import { ModelsPage } from "./ModelsPage";
import { PeoplePage } from "./PeoplePage";
import { PromptsPage } from "./PromptsPage";
import { ReviewPanel } from "./ReviewPanel";
import { StatusLine } from "./Shared";
import { VIEW_LABELS } from "./labels";

const SECTIONS: Array<{ view: PermissionsView; icon: typeof UsersIcon }> = [
  { view: "people", icon: UsersIcon },
  { view: "groups", icon: UsersRoundIcon },
  { view: "models", icon: BoxesIcon },
  { view: "features", icon: SlidersHorizontalIcon },
  { view: "prompts", icon: MessageSquareTextIcon },
  { view: "inspect", icon: ScanSearchIcon },
  { view: "audit", icon: HistoryIcon },
];

const EVERYONE = { kind: "everyone", id: "" } as const;

/** Admin shell for the granular permissions workspace. Query state is the navigation state. */
export function PermissionsWorkspace() {
  const me = useData((state) => state.me);
  const [location, navigate] = useLocation();
  const search = useSearch();
  const query = parsePermissionsQuery(search);
  const extraUserId = new URLSearchParams(search).get("userId");
  const state = usePermissions();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<{ kind: "view"; view: PermissionsView | "server" } | { kind: "query"; patch: Partial<PermissionsQuery> } | null>(null);
  const dirty = state.changes();

  useEffect(() => {
    if (!me) return;
    usePermissions.getState().begin(me.id);
    void usePermissions.getState().loadBootstrap();
  }, [me?.id]);

  const subject = query.view === "models" ? EVERYONE : query.subject;
  useEffect(() => {
    if (query.view === "inspect" || query.view === "audit") return;
    if (!state.bootstrap) return;
    void usePermissions.getState().selectSubject(subject);
    // The subject key is the identity; view/revision changes alone must not refetch.
  }, [subjectKey(subject), query.view, state.bootstrap?.revision]);

  const write = (next: PermissionsQuery, extra?: Record<string, string | null>) => {
    const params = new URLSearchParams(search);
    for (const key of ["view", "subjectKind", "subjectId", "modelRef", "tab", "q", "filter"]) params.delete(key);
    for (const [key, value] of Object.entries(permissionsQueryRecord(next))) params.set(key, value);
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    navigate(`${location}?${params.toString()}`, { replace: true });
  };

  const onQuery = (patch: Partial<PermissionsQuery>) => write({ ...query, ...patch });

  /** A subject or model change replaces the draft's destination, so a dirty draft asks before discarding. */
  const requestQuery = (patch: Partial<PermissionsQuery>) => {
    const subjectChanged = !!patch.subject && subjectKey(patch.subject) !== subjectKey(query.subject);
    const modelChanged = "modelRef" in patch && patch.modelRef !== query.modelRef;
    if (dirty.length && (subjectChanged || modelChanged)) setPendingLeave({ kind: "query", patch });
    else onQuery(patch);
  };

  const go = (view: PermissionsView | "server") => {
    if (view === "server") {
      navigate(settingsHref("admin"));
      return;
    }
    if (view === query.view) return;
    const defaults: Partial<PermissionsQuery> =
      view === "features" || view === "prompts"
        ? { tab: view }
        : { subject: EVERYONE, modelRef: null, tab: "access", q: "" };
    write({ ...query, view, ...defaults }, { userId: view === "inspect" ? extraUserId : null });
  };

  const requestView = (view: PermissionsView | "server") => {
    if (dirty.length) setPendingLeave({ kind: "view", view });
    else go(view);
  };

  const openReview = () => {
    setReviewOpen(true);
    void usePermissions.getState().review();
  };

  if (!isPermissionsSearch(search)) return null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 pt-6 pb-[max(6rem,env(safe-area-inset-bottom))] sm:px-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ShieldCheckIcon className="text-primary size-5" aria-hidden /> {t("permissions.title")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">{t("permissions.description")}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => requestView("server")}>
          <Settings2Icon /> {t("permissions.serverSettings")}
        </Button>
      </header>

      <div className="flex min-w-0 flex-col gap-4 lg:flex-row">
        <nav aria-label={t("permissions.title")} className="shrink-0 lg:w-52">
          <div className="bg-card flex gap-1 overflow-x-auto rounded-xl p-1 shadow-[var(--depth-highlight),var(--shadow-raised)] lg:flex-col">
            {SECTIONS.map(({ view, icon: Icon }) => (
              <button
                key={view}
                type="button"
                aria-current={query.view === view ? "page" : undefined}
                onClick={() => requestView(view)}
                className={cn(
                  "focus-visible:outline-ring flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm whitespace-nowrap transition-colors duration-(--motion-fast) pointer-coarse:min-h-11",
                  query.view === view ? "depth-row-active text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden /> {t(VIEW_LABELS[view])}
              </button>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
          {state.bootstrapStatus === "loading" && !state.bootstrap ? (
            <div className="bg-card rounded-xl px-4 py-12 text-center shadow-[var(--depth-highlight),var(--shadow-raised)]">
              <StatusLine status="loading" />
            </div>
          ) : state.bootstrapStatus === "error" ? (
            <div className="bg-card flex flex-col items-start gap-2 rounded-xl px-4 py-8 shadow-[var(--depth-highlight),var(--shadow-raised)]">
              <StatusLine status="error" error={state.bootstrapError} />
              <Button type="button" size="sm" variant="outline" onClick={() => void usePermissions.getState().loadBootstrap(true)}>
                {t("common.tryAgain")}
              </Button>
            </div>
          ) : (
            <>
              {query.view === "people" && <PeoplePage query={query} onQuery={requestQuery} onNavigate={navigate} />}
              {query.view === "groups" && <GroupsPage query={query} onQuery={requestQuery} />}
              {query.view === "models" && <ModelsPage query={query} onQuery={requestQuery} />}
              {query.view === "features" && <FeaturesPage query={query} onQuery={requestQuery} />}
              {query.view === "prompts" && <PromptsPage query={query} onQuery={requestQuery} />}
              {query.view === "inspect" && <InspectPage query={query} userId={extraUserId} onNavigate={navigate} />}
              {query.view === "audit" && <AuditPage />}
            </>
          )}
        </div>
      </div>

      {dirty.length > 0 && (
        <div className="bg-card/95 supports-[backdrop-filter]:bg-card/80 sticky bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5 shadow-[var(--depth-highlight),var(--shadow-raised)] backdrop-blur">
          <p className="min-w-0 flex-1 truncate text-xs" aria-live="polite">
            {t("permissions.stateDirty")} · {t("permissions.stateDraftCount", { count: dirty.length })}
          </p>
          <Button type="button" size="sm" variant="ghost" onClick={() => usePermissions.getState().discardDrafts()}>
            {t("permissions.stateDiscard")}
          </Button>
          <Button type="button" size="sm" disabled={state.previewStatus === "loading"} onClick={openReview}>
            {state.previewStatus === "loading" && <Loader2Icon className="animate-spin" />} {t("permissions.reviewTitle")}
          </Button>
        </div>
      )}
      {state.commitStatus === "ready" && dirty.length === 0 && (
        <p className="text-success text-sm" role="status" aria-live="polite">
          {t("permissions.stateSaved")}
          {state.lastSavedRevision !== null ? ` · ${t("permissions.stateRevision", { revision: state.lastSavedRevision })}` : ""}
        </p>
      )}

      <ReviewPanel open={reviewOpen} onOpenChange={setReviewOpen} />

      <Dialog open={pendingLeave !== null} onOpenChange={(open) => !open && setPendingLeave(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{t("permissions.stateLeave")}</DialogTitle>
            <DialogDescription>{t("permissions.stateLeaveDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingLeave(null)}>
              {t("permissions.stateKeepEditing")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const target = pendingLeave;
                setPendingLeave(null);
                usePermissions.getState().discardDrafts();
                if (!target) return;
                if (target.kind === "view") go(target.view);
                else onQuery(target.patch);
              }}
            >
              {t("permissions.stateDiscard")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
