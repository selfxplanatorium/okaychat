import { SearchIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import type { Subject } from "@shared/permissions";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { permissionsHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/state/permissions";
import type { PermissionsQuery } from "@/state/permissions-query";
import { permissionsQueryRecord } from "@/state/permissions-query";
import { BackButton, StatusLine, WorkspaceCard } from "./Shared";
import { SubjectDetail, subjectName } from "./SubjectDetail";

// People list + user policy detail. Mobile drills in: the list disappears while a user is selected.

export function PeoplePage({ query, onQuery, onNavigate }: { query: PermissionsQuery; onQuery: (patch: Partial<PermissionsQuery>) => void; onNavigate: (path: string) => void }) {
  const state = usePermissions();
  const users = state.bootstrap?.subjects.users ?? [];
  const groups = state.bootstrap?.subjects.groups ?? [];
  const q = query.q.trim().toLowerCase();
  const shown = users.filter((user) => !q || `${user.name} ${user.email}`.toLowerCase().includes(q));
  const selected = query.subject.kind === "user" ? query.subject : null;
  const detail = selected ? <SubjectDetail subject={selected} modelRef={query.modelRef} tab={query.tab} filter={query.filter} onQuery={onQuery} /> : null;

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <div className={cn("min-w-0", selected && "max-md:hidden")}>
        <WorkspaceCard title={t("permissions.navPeople")} description={t("permissions.peopleDescription")}>
          <div className="p-3">
            <div className="relative">
              <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" aria-hidden />
              <Input aria-label={t("permissions.searchPeople")} placeholder={t("permissions.searchPeople")} value={query.q} onChange={(event) => onQuery({ q: event.currentTarget.value })} className="h-8 pl-8" />
            </div>
          </div>
          <div className="flex flex-col p-1" role="listbox" aria-label={t("permissions.navPeople")}>
            {shown.map((user) => {
              const memberOf = groups.filter((group) => group.userIds.includes(user.id));
              const active = selected?.kind === "user" && selected.id === user.id;
              return (
                <button
                  key={user.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => onQuery({ subject: { kind: "user", id: user.id }, view: "people", q: "" })}
                  className={cn(
                    "hover:bg-accent flex min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors duration-(--motion-fast) pointer-coarse:min-h-11",
                    active && "depth-row-active",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <UserRoundIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{user.name}</span>
                    {user.role === "admin" && <ShieldCheckIcon className="text-primary size-3.5 shrink-0" aria-label={t("admin.roleAdmin")} />}
                  </span>
                  <span className="text-muted-foreground truncate pl-5 text-xs">{user.email}</span>
                  {memberOf.length > 0 && <span className="text-muted-foreground truncate pl-5 text-[11px]">{memberOf.map((group) => group.name).join(" · ")}</span>}
                </button>
              );
            })}
            {!shown.length && <p className="text-muted-foreground px-3 py-4 text-sm">{t("permissions.stateEmpty")}</p>}
          </div>
        </WorkspaceCard>
      </div>

      <div className={cn("min-w-0", !selected && "max-md:hidden")}>
        {selected ? (
          <>
            <div className="mb-2 flex items-center justify-between gap-2 md:hidden">
              <BackButton onClick={() => onQuery({ subject: { kind: "everyone", id: "" } })} label={t("permissions.backToList")} />
            </div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">{t("permissions.subjectDetail")}</p>
              <button
                type="button"
                className="text-primary rounded text-xs underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => onNavigate(permissionsHref({ ...permissionsQueryRecord({ ...query, view: "inspect" }), userId: selected.id }))}
              >
                {t("permissions.inspectFor", { name: subjectName(selected, users, groups) })}
              </button>
            </div>
            {detail}
          </>
        ) : (
          <WorkspaceCard title={t("permissions.selectPerson")} description={t("permissions.selectPersonHint")}>
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <UserRoundIcon className="text-muted-foreground size-8" aria-hidden />
              <p className="text-muted-foreground max-w-sm text-sm">{t("permissions.selectPersonHint")}</p>
              <StatusLine status={state.bootstrapStatus} error={state.bootstrapError} />
            </div>
          </WorkspaceCard>
        )}
      </div>
    </div>
  );
}
