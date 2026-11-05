import { HardDriveIcon, KeyRoundIcon, Loader2Icon, PencilIcon, PlusIcon, ShieldCheckIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useSearch } from "wouter";
import type { AdminPrompt, AdminUser, ProviderInfo, StorageInfo, UserGroup } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { t } from "@/i18n";
import { formatBytes, formatCost } from "@/i18n/format";
import { permissionsHref } from "@/lib/settings-link";
import { isPermissionsSearch } from "@/state/permissions-query";
import { useData } from "@/state/data";
import { Checklist, invalidateDirectory, useDirectory } from "./Audience";
import { PermissionsWorkspace } from "./permissions/PermissionsWorkspace";
import { ProviderLists, ProviderScopeProvider } from "./ProvidersSettings";
import { AdminVoiceSettings } from "./AdminVoiceSettings";
import { AgentManagement } from "@/components/agents/AgentManagement";
import { SettingsPage, SettingsRow, SettingsSection } from "./SettingsUI";

function NewUserForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="animate-rise-in grid gap-2 px-4 py-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api("/admin/users", { method: "POST", json: { email, name, password, role } });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input placeholder={t("admin.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      <Input type="email" placeholder={t("admin.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} required />
      <Input type="password" placeholder={t("admin.initialPasswordPlaceholder")} value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoComplete="new-password" />
      <Select aria-label={t("admin.role")} value={role} onValueChange={setRole} options={[{ value: "user", label: t("admin.roleUser") }, { value: "admin", label: t("admin.roleAdmin") }]} />
      {error && <p className="text-error settings-error text-xs sm:col-span-2">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />} {t("admin.addUser")}
        </Button>
      </div>
    </form>
  );
}

/** "2 GB", "500 MB", "1.5GB", a bare number in MB → bytes; "" resets to the default. */
function parseLimit(text: string): number | null | undefined {
  const value = text.trim().toUpperCase().replace(/\s+/g, "");
  if (!value) return null;
  const match = value.match(/^([\d.]+)(B|KB|MB|GB|TB)?$/);
  if (!match) return undefined;
  const multiplier = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2] ?? "MB"]!;
  const bytes = Math.round(Number(match[1]) * multiplier);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

type UserEdit = { kind: "limit" | "password"; user: AdminUser };

/** Edits one user's storage limit or password. Stays open with the error when the save fails. */
function UserEditDialog({ edit, onClose, onSaved }: { edit: UserEdit | null; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Keep the last edit while the dialog animates out.
  const [shown, setShown] = useState(edit);
  if (edit && edit !== shown) {
    setShown(edit);
    setText(edit.kind === "limit" && edit.user.storageLimit !== null ? formatBytes(edit.user.storageLimit) : "");
    setError(null);
  }
  const user = shown?.user;
  const isLimit = shown?.kind === "limit";

  const save = async () => {
    if (!user) return;
    let json: Record<string, unknown>;
    if (isLimit) {
      // An untouched prefill keeps the exact stored bytes, which formatBytes rounds.
      const parsed = user.storageLimit !== null && text === formatBytes(user.storageLimit) ? user.storageLimit : parseLimit(text);
      if (parsed === undefined) return setError(t("admin.limitFormatError"));
      json = { storageLimit: parsed };
    } else {
      if (text.length < 8) return setError(t("admin.passwordTooShort"));
      json = { password: text };
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/users/${user.id}`, { method: "PATCH", json });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={edit !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base">{isLimit ? t("admin.storageLimit") : t("admin.resetPassword")}</DialogTitle>
            <DialogDescription>
              {isLimit
                ? t("admin.limitDescription", { email: user?.email ?? "" })
                : t("admin.passwordDescription", { email: user?.email ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={isLimit ? t("admin.storageLimit") : t("admin.newPassword")}
            type={isLimit ? "text" : "password"}
            autoComplete={isLimit ? "off" : "new-password"}
            placeholder={isLimit ? t("admin.serverDefault") : t("admin.passwordHint")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          {error && <p role="alert" className="text-error settings-error text-xs">{error}</p>}
          <DialogFooter>
            <DialogClose type="button" disabled={busy} render={<Button variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button type="submit" disabled={busy || (!isLimit && !text)}>
              {busy && <Loader2Icon className="animate-spin" />} {isLimit ? t("common.save") : t("admin.resetPassword")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Users({ defaultLimit }: { defaultLimit: number | null }) {
  const me = useData((s) => s.me);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<UserEdit | null>(null);
  const refresh = useCallback(() => {
    invalidateDirectory();
    return api<AdminUser[]>("/admin/users").then(setUsers);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const limitLabel = (u: AdminUser) =>
    u.storageLimit !== null ? formatBytes(u.storageLimit) : defaultLimit !== null ? t("admin.limitDefaultSized", { size: formatBytes(defaultLimit) }) : t("admin.limitDefault");
  return (
    <SettingsSection
      title={t("admin.users")}
      action={
        !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon /> {t("admin.addUser")}
          </Button>
        )
      }
    >
      {adding && (
        <NewUserForm
          onDone={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}
      {error && <p className="text-error settings-error px-4 pt-2 text-xs">{error}</p>}
      {users.map((u, index) => (
        <div key={u.id} className="stagger animate-rise-in flex items-center gap-3 px-4 py-3" style={{ "--i": index } as CSSProperties}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {u.name} {u.id === me?.id && <span className="text-muted-foreground font-normal">{t("admin.you")}</span>}
            </p>
            <p className="text-muted-foreground truncate text-xs">
              {t("admin.userStats", { email: u.email, chats: u.threads, used: formatBytes(u.storageUsed), limit: limitLabel(u), cost: formatCost(u.cost30d) })}
            </p>
          </div>
          <Select
            aria-label={t("admin.roleOf", { name: u.name })}
            className="h-7 w-24 text-xs"
            value={u.role}
            disabled={u.id === me?.id}
            onValueChange={(role) => void act(() => api(`/admin/users/${u.id}`, { method: "PATCH", json: { role } }))}
            options={[
              { value: "user", label: t("admin.roleUser") },
              { value: "admin", label: t("admin.roleAdmin") },
            ]}
          />
          <Button size="icon-sm" variant="ghost" aria-label={t("admin.storageLimitOf", { name: u.name })} onClick={() => setEdit({ kind: "limit", user: u })}>
            <HardDriveIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("admin.resetPasswordOf", { name: u.name })}
            onClick={() => setEdit({ kind: "password", user: u })}
          >
            <KeyRoundIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("admin.deleteUser", { name: u.name })}
            disabled={u.id === me?.id}
            onClick={() => confirm(t("admin.deleteUserConfirm", { email: u.email })) && void act(() => api(`/admin/users/${u.id}`, { method: "DELETE" }))}
          >
            <TrashIcon />
          </Button>
        </div>
      ))}
      <UserEditDialog edit={edit} onClose={() => setEdit(null)} onSaved={() => void refresh()} />
    </SettingsSection>
  );
}

function GroupDialog({ group, onClose }: { group: UserGroup | "new" | null; onClose: () => void }) {
  const { users } = useDirectory();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Keep the last group while the dialog animates out.
  const [shown, setShown] = useState(group);
  if (group && group !== shown) {
    setShown(group);
    setName(group === "new" ? "" : group.name);
    setMembers(new Set(group === "new" ? [] : group.userIds));
    setError(null);
  }
  const isNew = shown === "new";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const json = { name, userIds: [...members] };
      if (isNew) await api("/admin/groups", { method: "POST", json });
      else if (shown) await api(`/admin/groups/${shown.id}`, { method: "PATCH", json });
      invalidateDirectory();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={group !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base">{isNew ? t("admin.newGroup") : t("admin.editGroup")}</DialogTitle>
            <DialogDescription>{t("admin.groupDescription")}</DialogDescription>
          </DialogHeader>
          <Input aria-label={t("admin.groupName")} placeholder={t("admin.groupNamePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          <Checklist
            label={t("admin.members")}
            filter={users.length > 8}
            items={users.map((u) => ({ id: u.id, label: u.name, hint: u.email }))}
            selected={members}
            onToggle={(id) =>
              setMembers((s) => {
                const next = new Set(s);
                if (!next.delete(id)) next.add(id);
                return next;
              })
            }
          />
          {error && <p role="alert" className="text-error settings-error text-xs">{error}</p>}
          <DialogFooter>
            <DialogClose type="button" disabled={busy} render={<Button variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2Icon className="animate-spin" />} {isNew ? t("admin.createGroup") : t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Groups() {
  const { groups } = useDirectory();
  const [editing, setEditing] = useState<UserGroup | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection
      title={t("admin.groups")}
      description={t("admin.groupsDescription")}
      action={
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <PlusIcon /> {t("admin.newGroup")}
        </Button>
      }
    >
      {error && <p className="text-error settings-error px-4 pt-2 text-xs">{error}</p>}
      {groups.length === 0 && <p className="text-muted-foreground px-4 py-3 text-sm">{t("admin.noGroups")}</p>}
      {groups.map((g, index) => (
        <div key={g.id} className="stagger animate-rise-in flex items-center gap-3 px-4 py-3" style={{ "--i": index } as CSSProperties}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{g.name}</p>
            <p className="text-muted-foreground truncate text-xs">
              {t("admin.memberCount", { count: g.userIds.length })}
            </p>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={t("admin.editNamed", { name: g.name })} onClick={() => setEditing(g)}>
            <PencilIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("admin.deleteNamed", { name: g.name })}
            onClick={async () => {
              if (!confirm(t("admin.deleteGroupConfirm", { name: g.name }))) return;
              setError(null);
              try {
                await api(`/admin/groups/${g.id}`, { method: "DELETE" });
                invalidateDirectory();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <TrashIcon />
          </Button>
        </div>
      ))}
      <GroupDialog group={editing} onClose={() => setEditing(null)} />
    </SettingsSection>
  );
}

function PromptEditor({ item, onSaved, onClose }: { item: AdminPrompt; onSaved: (next: AdminPrompt) => void; onClose: () => void }) {
  const [text, setText] = useState(item.value ?? item.defaultValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<AdminPrompt>(`/admin/prompts/${item.key}`, { method: "PUT", json: { value } }));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="animate-rise-in flex flex-col gap-2 px-4 pb-3">
      <Textarea aria-label={item.label} className="max-h-[60vh] font-mono text-xs md:text-xs" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      {item.placeholders.length > 0 && (
        <p className="text-muted-foreground text-xs">{t("admin.placeholders", { list: item.placeholders.map((name) => `{${name}}`).join(", ") })}</p>
      )}
      {error && <p className="text-error settings-error text-xs">{error}</p>}
      <div className="flex justify-end gap-2">
        {item.value !== null && (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void save(null)}>
            {t("settings.resetToDefault")}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        {/* Saving the unchanged default keeps the default, so later default updates still apply. */}
        <Button type="button" disabled={busy} onClick={() => void save(text === item.defaultValue ? null : text)}>
          {busy && <Loader2Icon className="animate-spin" />} {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function SystemPrompts() {
  const [prompts, setPrompts] = useState<AdminPrompt[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    void api<AdminPrompt[]>("/admin/prompts").then(setPrompts);
  }, []);
  return (
    <SettingsSection title={t("admin.systemPrompts")} description={t("admin.systemPromptsDescription")}>
      {prompts.map((item) => (
        <div key={item.key} className="flex flex-col">
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {item.label} {item.value !== null && <span className="text-muted-foreground font-normal">{t("admin.customized")}</span>}
              </p>
              <p className="text-muted-foreground text-xs">{item.description}</p>
            </div>
            {editing !== item.key && (
              <Button size="icon-sm" variant="ghost" aria-label={t("admin.editNamed", { name: item.label })} onClick={() => setEditing(item.key)}>
                <PencilIcon />
              </Button>
            )}
          </div>
          {editing === item.key && (
            <PromptEditor
              item={item}
              onSaved={(next) => setPrompts((list) => list.map((p) => (p.key === next.key ? next : p)))}
              onClose={() => setEditing(null)}
            />
          )}
        </div>
      ))}
    </SettingsSection>
  );
}

function PermissionsEntry() {
  const linkClass = "bg-muted/70 hover:bg-muted focus-visible:outline-ring inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-transparent px-3 text-sm transition-colors duration-(--motion-fast)";
  return (
    <SettingsSection title={t("permissions.title")} description={t("permissions.entryDescription")}>
      <div className="flex flex-wrap gap-2 px-4 py-3">
        <Link href={permissionsHref({ view: "people" })} className={linkClass}>
          <ShieldCheckIcon className="size-4" aria-hidden /> {t("permissions.openWorkspace")}
        </Link>
        <Link href={permissionsHref({ view: "inspect" })} className={linkClass}>
          {t("permissions.navInspect")}
        </Link>
        <Link href={permissionsHref({ view: "audit" })} className={linkClass}>
          {t("permissions.navAudit")}
        </Link>
      </div>
    </SettingsSection>
  );
}

export function AdminSettings() {
  const search = useSearch();
  const [allowSignup, setAllowSignup] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [defaultLimit, setDefaultLimit] = useState<number | null>(null);
  const refreshUserProviders = useData((s) => s.refreshProviders);
  const refreshProviders = useCallback(async () => {
    setProviders(await api<ProviderInfo[]>("/admin/providers"));
    // The admin is a user too: their model list includes shared keys.
    await refreshUserProviders();
  }, [refreshUserProviders]);

  useEffect(() => {
    void api<{ allowSignup: boolean }>("/admin/settings").then((s) => setAllowSignup(s.allowSignup));
    void api<ProviderInfo[]>("/admin/providers").then(setProviders);
    // The signed-in admin's /storage reply carries the server-wide default.
    void api<StorageInfo>("/storage").then((s) => setDefaultLimit(s.defaultLimit));
  }, []);

  if (isPermissionsSearch(search)) return <PermissionsWorkspace />;

  return (
    <SettingsPage title={t("settings.sectionAdmin")} description={t("admin.pageDescription")}>
      <PermissionsEntry />
      <SettingsSection title={t("admin.access")}>
        <SettingsRow
          label={t("admin.openSignup")}
          description={t("admin.openSignupDescription")}
          control={
            allowSignup !== null && (
              <Switch
                checked={allowSignup}
                aria-label={t("admin.openSignup")}
                onCheckedChange={async (value) => setAllowSignup((await api<{ allowSignup: boolean }>("/admin/settings", { method: "PATCH", json: { allowSignup: value } })).allowSignup)}
              />
            )
          }
        />
      </SettingsSection>
      <Users defaultLimit={defaultLimit} />
      <Groups />
      <SystemPrompts />
      <AgentManagement scope="shared" />
      <AdminVoiceSettings />
      <h2 className="mt-2 text-sm font-medium">{t("admin.serverProviders")}</h2>
      <p className="text-muted-foreground -mt-2 text-xs">
        {t("admin.serverProvidersDescription")}
      </p>
      <ProviderScopeProvider base="/admin/providers" providers={providers} refresh={refreshProviders}>
        <ProviderLists />
      </ProviderScopeProvider>
    </SettingsPage>
  );
}
