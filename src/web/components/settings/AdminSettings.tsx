import { HardDriveIcon, KeyRoundIcon, Loader2Icon, PlusIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { AdminUser, ProviderInfo, StorageInfo } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, formatBytes, formatCost } from "@/lib/api";
import { useData } from "@/state/data";
import { ProviderLists, ProviderScopeProvider } from "./ProvidersSettings";
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
      <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <Input type="password" placeholder="Initial password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoComplete="new-password" />
      <Select aria-label="Role" value={role} onValueChange={setRole} options={[{ value: "user", label: "User" }, { value: "admin", label: "Admin" }]} />
      {error && <p className="text-error settings-error text-xs sm:col-span-2">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />} Add user
        </Button>
      </div>
    </form>
  );
}

/** "2 GB", "500 MB", "1.5GB", a bare number in MB → bytes; "" resets to the default. */
function parseLimit(text: string): number | null | undefined {
  const t = text.trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return null;
  const match = t.match(/^([\d.]+)(B|KB|MB|GB|TB)?$/);
  if (!match) return undefined;
  const multiplier = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2] ?? "MB"]!;
  const bytes = Math.round(Number(match[1]) * multiplier);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

function Users({ defaultLimit }: { defaultLimit: number | null }) {
  const me = useData((s) => s.me);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => api<AdminUser[]>("/admin/users").then(setUsers), []);
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
    u.storageLimit !== null ? formatBytes(u.storageLimit) : defaultLimit !== null ? `default ${formatBytes(defaultLimit)}` : "default";
  const editLimit = (u: AdminUser) => {
    const text = prompt(
      `Storage limit for ${u.email} — e.g. "2 GB" or "500 MB" (a bare number means MB). Leave empty to reset to the server default.`,
      u.storageLimit !== null ? formatBytes(u.storageLimit) : "",
    );
    if (text === null) return;
    const parsed = parseLimit(text);
    if (parsed === undefined) {
      setError(`Could not read that limit for ${u.name}. Use a size like "2 GB".`);
      return;
    }
    void act(() => api(`/admin/users/${u.id}`, { method: "PATCH", json: { storageLimit: parsed } }));
  };

  return (
    <SettingsSection
      title="Users"
      action={
        !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon /> Add user
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
              {u.name} {u.id === me?.id && <span className="text-muted-foreground font-normal">(you)</span>}
            </p>
            <p className="text-muted-foreground truncate text-xs">
              {u.email} · {u.threads} chats · {formatBytes(u.storageUsed)} of {limitLabel(u)} stored · {formatCost(u.cost30d)} in 30 days
            </p>
          </div>
          <Select
            aria-label={`Role of ${u.name}`}
            className="h-7 w-24 text-xs"
            value={u.role}
            onValueChange={(role) => void act(() => api(`/admin/users/${u.id}`, { method: "PATCH", json: { role } }))}
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
          <Button size="icon-sm" variant="ghost" aria-label={`Storage limit of ${u.name}`} onClick={() => editLimit(u)}>
            <HardDriveIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Reset password of ${u.name}`}
            onClick={() => {
              const password = prompt(`New password for ${u.email} (8+ characters). They will be signed out.`);
              if (password) void act(() => api(`/admin/users/${u.id}`, { method: "PATCH", json: { password } }));
            }}
          >
            <KeyRoundIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${u.name}`}
            disabled={u.id === me?.id}
            onClick={() => confirm(`Delete ${u.email} and all their chats, keys, and files?`) && void act(() => api(`/admin/users/${u.id}`, { method: "DELETE" }))}
          >
            <TrashIcon />
          </Button>
        </div>
      ))}
    </SettingsSection>
  );
}

export function AdminSettings() {
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

  return (
    <SettingsPage title="Admin" description="Manage who can use this server and which provider keys everyone shares.">
      <SettingsSection title="Access">
        <SettingsRow
          label="Open sign-up"
          description="Anyone who can reach this server can create an account. Off: only admins add users."
          control={
            allowSignup !== null && (
              <Switch
                checked={allowSignup}
                aria-label="Open sign-up"
                onCheckedChange={async (value) => setAllowSignup((await api<{ allowSignup: boolean }>("/admin/settings", { method: "PATCH", json: { allowSignup: value } })).allowSignup)}
              />
            )
          }
        />
      </SettingsSection>
      <Users defaultLimit={defaultLimit} />
      <h2 className="mt-2 text-sm font-medium">Server-wide providers</h2>
      <p className="text-muted-foreground -mt-2 text-xs">Every user can use these keys. A user's own key for the same provider takes precedence. Usage is still tracked per user.</p>
      <ProviderScopeProvider base="/admin/providers" providers={providers} refresh={refreshProviders}>
        <ProviderLists />
      </ProviderScopeProvider>
    </SettingsPage>
  );
}
