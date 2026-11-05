import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { usePermissions, membershipDraftFor, groupOrderFor } from "@/state/permissions";
import type { PermissionsQuery } from "@/state/permissions-query";
import { Checklist } from "../Audience";
import { BackButton, WorkspaceCard } from "./Shared";
import { SubjectDetail } from "./SubjectDetail";

// Groups combine two drafts: membership (a `membership` change) and prompt order (a `groupOrder` change).
// Both go through the same preview/commit path, so a group edit is reviewed with the policy changes.

export function GroupsPage({ query, onQuery }: { query: PermissionsQuery; onQuery: (patch: Partial<PermissionsQuery>) => void }) {
  const state = usePermissions();
  const groups = state.bootstrap?.subjects.groups ?? [];
  const users = state.bootstrap?.subjects.users ?? [];
  const selected = query.subject.kind === "group" ? query.subject : null;
  const selectedGroup = selected ? groups.find((group) => group.id === selected.id) : undefined;
  const order = groupOrderFor(state);
  const members = selectedGroup ? new Set(membershipDraftFor(state, selectedGroup.id)) : new Set<string>();

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <div className={cn("min-w-0 flex flex-col gap-4", selected && "max-md:hidden")}>
        <WorkspaceCard title={t("permissions.navGroups")} description={t("permissions.groupsDescription")}>
          <div className="flex flex-col p-1" role="listbox" aria-label={t("permissions.navGroups")}>
            {groups.map((group) => {
              const active = selected?.kind === "group" && selected.id === group.id;
              return (
                <button
                  key={group.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => onQuery({ subject: { kind: "group", id: group.id }, view: "groups", modelRef: null })}
                  className={cn(
                    "hover:bg-accent flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-(--motion-fast) pointer-coarse:min-h-11",
                    active && "depth-row-active",
                  )}
                >
                  <UsersIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{group.name}</span>
                    <span className="text-muted-foreground block truncate text-xs">{t("admin.memberCount", { count: group.userIds.length })}</span>
                  </span>
                  <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                </button>
              );
            })}
            {!groups.length && <p className="text-muted-foreground px-3 py-4 text-sm">{t("permissions.noGroups")}</p>}
          </div>
        </WorkspaceCard>

        <WorkspaceCard title={t("permissions.promptGroupOrder")} description={t("permissions.promptGroupOrderHelp")}>
          <ol className="flex flex-col p-1">
            {order.map((groupId, index) => {
              const group = groups.find((item) => item.id === groupId);
              return (
                <li key={groupId} className="flex items-center gap-2 px-2 py-1.5">
                  <span className="text-muted-foreground w-6 shrink-0 text-right text-xs tabular-nums">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{group?.name ?? groupId}</span>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("permissions.promptMoveUp", { name: group?.name ?? groupId })}
                    disabled={index === 0}
                    onClick={() => usePermissions.getState().moveGroup(groupId, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("permissions.promptMoveDown", { name: group?.name ?? groupId })}
                    disabled={index === order.length - 1}
                    onClick={() => usePermissions.getState().moveGroup(groupId, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                </li>
              );
            })}
          </ol>
        </WorkspaceCard>
      </div>

      <div className={cn("min-w-0", !selected && "max-md:hidden")}>
        {selected && selectedGroup ? (
          <>
            <div className="mb-2 md:hidden">
              <BackButton onClick={() => onQuery({ subject: { kind: "everyone", id: "" } })} label={t("permissions.backToList")} />
            </div>
            <div className="flex flex-col gap-4">
              <WorkspaceCard title={t("permissions.groupMembers", { name: selectedGroup.name })} description={t("permissions.groupMembersHelp")}>
                <div className="p-3">
                  <Checklist
                    label={t("admin.members")}
                    filter={users.length > 8}
                    items={users.map((user) => ({ id: user.id, label: user.name, hint: user.email }))}
                    selected={members}
                    onToggle={(id) => {
                      const next = new Set(members);
                      if (!next.delete(id)) next.add(id);
                      usePermissions.getState().editMembership(selectedGroup.id, [...next]);
                    }}
                  />
                </div>
              </WorkspaceCard>
              <SubjectDetail subject={selected} modelRef={query.modelRef} tab={query.tab} filter={query.filter} onQuery={onQuery} />
            </div>
          </>
        ) : (
          <WorkspaceCard title={t("permissions.selectGroup")} description={t("permissions.selectGroupHint")}>
            <p className="text-muted-foreground px-4 py-12 text-center text-sm">{t("permissions.selectGroupHint")}</p>
          </WorkspaceCard>
        )}
      </div>
    </div>
  );
}
