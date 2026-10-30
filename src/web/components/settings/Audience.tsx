import { Loader2Icon, SearchIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AdminUser, ShareAudience, UserGroup } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import { SelectionCheck } from "@/components/ui/selection";
import { t } from "@/i18n";
import { api } from "@/lib/api";

// Who may use something an admin shares (a server-wide provider key or an MCP server): everyone, or only
// chosen groups and users. The server enforces it (src/server/groups.ts).

export const EVERYONE: ShareAudience = { mode: "all", userIds: [], groupIds: [] };

type Directory = { users: AdminUser[]; groups: UserGroup[] };
const EMPTY: Directory = { users: [], groups: [] };
// One fetch shared by every picker on the page. Editing users or groups calls invalidateDirectory().
let directory: Promise<Directory> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

export function invalidateDirectory() {
  directory = null;
  generation++;
  for (const listener of listeners) listener();
}

/** Users and groups for the pickers. Admin-only endpoints. */
export function useDirectory(): Directory {
  const [value, setValue] = useState<Directory>(EMPTY);
  const [version, setVersion] = useState(generation);
  useEffect(() => {
    const listener = () => setVersion(generation);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  useEffect(() => {
    directory ??= Promise.all([api<AdminUser[]>("/admin/users"), api<UserGroup[]>("/admin/groups")]).then(([users, groups]) => ({ users, groups }));
    let live = true;
    void directory.then((d) => live && setValue(d));
    return () => {
      live = false;
    };
  }, [version]);
  return value;
}

export function audienceLabel(audience: ShareAudience | undefined, groups: UserGroup[]): string {
  if (!audience || audience.mode === "all") return t("audience.everyone");
  const groupIds = audience.groupIds.filter((id) => groups.some((g) => g.id === id));
  if (!groupIds.length && !audience.userIds.length) return t("audience.nobody");
  if (groupIds.length === 1 && !audience.userIds.length) return groups.find((g) => g.id === groupIds[0])!.name;
  if (!audience.userIds.length) return t("audience.groupCount", { count: groupIds.length });
  if (!groupIds.length) return t("audience.userCount", { count: audience.userIds.length });
  return t("audience.groupsAndUsers", { groups: t("audience.groupCount", { count: groupIds.length }), users: t("audience.userCount", { count: audience.userIds.length }) });
}

export interface CheckItem {
  id: string;
  label: string;
  hint?: string;
}

/** A scrollable list of checkable rows with an optional filter. */
export function Checklist({ items, selected, onToggle, label, filter = false }: { items: CheckItem[]; selected: ReadonlySet<string>; onToggle: (id: string) => void; label: string; filter?: boolean }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q)) : items;
  }, [items, query]);
  return (
    <div className="flex flex-col gap-1.5">
      {filter && (
        <div className="relative">
          <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input placeholder={t("audience.filter")} aria-label={t("audience.filterLabel", { label })} value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 pl-8" />
        </div>
      )}
      <ScrollArea className="bg-muted/40 max-h-48 rounded-lg border">
        <div role="group" aria-label={label} className="flex flex-col p-1">
          {shown.length === 0 && <p className="text-muted-foreground px-2 py-1.5 text-xs">{t("common.none")}</p>}
          {shown.map((item) => {
            const checked = selected.has(item.id);
            return (
              <button
                key={item.id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => onToggle(item.id)}
                className="hover:bg-accent flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-(--motion-fast) pointer-coarse:py-2.5"
              >
                <SelectionCheck checked={checked} />
                <span className="truncate">{item.label}</span>
                {item.hint && <span className="text-muted-foreground ml-auto truncate text-xs">{item.hint}</span>}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

const toggled = (set: ReadonlySet<string>, id: string) => {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
};

/** Edits an audience. `onSave` may throw; its message is shown. */
export function AudienceDialog({
  open,
  title,
  description,
  audience,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  description: string;
  audience: ShareAudience;
  onClose: () => void;
  onSave: (audience: ShareAudience) => Promise<void> | void;
}) {
  const { users, groups } = useDirectory();
  const [mode, setMode] = useState(audience.mode);
  const [userIds, setUserIds] = useState<ReadonlySet<string>>(new Set(audience.userIds));
  const [groupIds, setGroupIds] = useState<ReadonlySet<string>>(new Set(audience.groupIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState<ShareAudience | null>(null);
  if (open && shownFor !== audience) {
    setShownFor(audience);
    setMode(audience.mode);
    setUserIds(new Set(audience.userIds));
    setGroupIds(new Set(audience.groupIds));
    setError(null);
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(mode === "all" ? EVERYONE : { mode, userIds: [...userIds], groupIds: [...groupIds] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Select
            aria-label={t("audience.whoCanUse")}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "all", label: t("audience.everyone") },
              { value: "selected", label: t("audience.specific") },
            ]}
          />
          {mode === "selected" && (
            <>
              <div className="grid gap-1.5">
                <p className="text-xs font-medium">{t("audience.groups")}</p>
                {groups.length ? (
                  <Checklist label={t("audience.groups")} items={groups.map((g) => ({ id: g.id, label: g.name, hint: t("admin.memberCount", { count: g.userIds.length }) }))} selected={groupIds} onToggle={(id) => setGroupIds((s) => toggled(s, id))} />
                ) : (
                  <p className="text-muted-foreground text-xs">{t("audience.noGroups")}</p>
                )}
              </div>
              <div className="grid gap-1.5">
                <p className="text-xs font-medium">{t("audience.users")}</p>
                <Checklist
                  label={t("audience.users")}
                  filter={users.length > 8}
                  items={users.map((u) => ({ id: u.id, label: u.name, hint: u.email }))}
                  selected={userIds}
                  onToggle={(id) => setUserIds((s) => toggled(s, id))}
                />
              </div>
              {!groupIds.size && !userIds.size && <p className="text-muted-foreground text-xs">{t("audience.nobodyHasAccess")}</p>}
            </>
          )}
          {error && <p role="alert" className="text-error settings-error text-xs">{error}</p>}
          <DialogFooter>
            <DialogClose type="button" disabled={busy} render={<Button variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2Icon className="animate-spin" />} {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A compact button showing who has access, opening the editor. */
export function AudienceButton({ audience, title, description, onSave }: { audience: ShareAudience | undefined; title: string; description: string; onSave: (audience: ShareAudience) => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const { groups } = useDirectory();
  return (
    <>
      <Button type="button" size="xs" variant="outline" onClick={() => setOpen(true)} aria-label={`${title}: ${audienceLabel(audience, groups)}`}>
        <UsersIcon /> {audienceLabel(audience, groups)}
      </Button>
      <AudienceDialog open={open} title={title} description={description} audience={audience ?? EVERYONE} onClose={() => setOpen(false)} onSave={onSave} />
    </>
  );
}
