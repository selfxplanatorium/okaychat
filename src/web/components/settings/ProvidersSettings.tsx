import { CheckCircle2Icon, ExternalLinkIcon, PlusIcon, SearchIcon, TrashIcon } from "lucide-react";
import { createContext, useContext, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ProviderInfo } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { SettingsPage, SettingsSection } from "./SettingsUI";

export const OPENCODE_GO_CONSOLE = "https://opencode.ai/console";

/** Which connections the page edits: the user's own, or the server-wide ones an admin shares. */
interface ProviderScope {
  base: "/providers" | "/admin/providers";
  providers: ProviderInfo[];
  refresh: () => Promise<void>;
}

const ScopeContext = createContext<ProviderScope | null>(null);

export function ProviderScopeProvider({ children, ...scope }: ProviderScope & { children: ReactNode }) {
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

function useScope(): ProviderScope {
  const scoped = useContext(ScopeContext);
  const providers = useData((s) => s.providers);
  const refresh = useData((s) => s.refreshProviders);
  return scoped ?? { base: "/providers", providers, refresh };
}

/** Key + optional base URL form. Saving never echoes the stored key back. */
export function ProviderForm({ provider, onSaved, autoFocus }: { provider: ProviderInfo; onSaved?: () => void; autoFocus?: boolean }) {
  const { base, refresh } = useScope();
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState(provider.needsBaseURL || provider.custom ? (provider.baseURL ?? "") : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/${provider.id}`, {
        method: "PUT",
        json: { ...(apiKey ? { apiKey } : {}), ...(baseURL !== "" ? { baseURL } : {}), enabled: true },
      });
      await refresh();
      setApiKey("");
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex gap-2">
        <Input
          type="password"
          autoFocus={autoFocus}
          placeholder={provider.shared ? "Your own key, used instead of the server's" : provider.connected ? "Key saved. Paste a new one to replace it." : "API key"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
        />
        <Button type="submit" disabled={busy || (!apiKey && baseURL === (provider.baseURL ?? ""))}>
          {provider.connected && !provider.shared ? "Update" : "Connect"}
        </Button>
      </div>
      {(provider.needsBaseURL || provider.custom) && (
        <Input placeholder="Base URL, e.g. http://host.docker.internal:11434/v1" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      )}
      {error && <p className="text-error settings-error text-xs">{error}</p>}
    </form>
  );
}

function ProviderRow({ provider, index, expanded, onToggle }: { provider: ProviderInfo; index: number; expanded: boolean; onToggle: () => void }) {
  const { base, refresh } = useScope();
  return (
    <div className="stagger animate-rise-in px-4 py-3" style={{ "--i": index } as CSSProperties}>
      <div className="flex items-center gap-3">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="truncate text-sm font-medium">{provider.name}</span>
          {provider.id === "opencode-go" && <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">Recommended</span>}
          {provider.connected && <CheckCircle2Icon className="text-success animate-pop-in size-3.5 shrink-0" aria-label="Connected" />}
          {provider.shared && <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">Server key</span>}
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">{provider.modelCount ? `${provider.modelCount} models` : ""}</span>
        </button>
        {provider.connected && !provider.shared && (
          <>
            <Switch
              checked={provider.enabled}
              aria-label={`Enable ${provider.name}`}
              onCheckedChange={async (enabled) => {
                await api(`${base}/${provider.id}`, { method: "PUT", json: { enabled } });
                await refresh();
              }}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Disconnect ${provider.name}`}
              onClick={async () => {
                await api(`${base}/${provider.id}`, { method: "DELETE" });
                await refresh();
              }}
            >
              <TrashIcon />
            </Button>
          </>
        )}
      </div>
      {expanded && (
        <div className="settings-collapse mt-3">
          <div className="flex flex-col gap-2">
            <ProviderForm provider={provider} onSaved={onToggle} autoFocus />
            {provider.doc && (
              <a
                href={provider.id === "opencode-go" ? OPENCODE_GO_CONSOLE : provider.doc}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors duration-(--motion-fast)"
              >
                {provider.id === "opencode-go" ? "Get a key in the OpenCode console" : "Provider docs"} <ExternalLinkIcon className="size-3" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CustomProviderForm({ onDone }: { onDone: () => void }) {
  const { base, refresh } = useScope();
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="animate-rise-in grid gap-2 px-4 py-3 sm:grid-cols-[1fr_2fr]"
      onSubmit={async (e) => {
        e.preventDefault();
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!slug) return setError("Give it a name.");
        try {
          await api(`${base}/custom-${slug}`, { method: "PUT", json: { name, baseURL, apiKey: apiKey || undefined, enabled: true } });
          await refresh();
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <Input placeholder="Name (e.g. Ollama)" value={name} onChange={(e) => setName(e.target.value)} required />
      <Input placeholder="OpenAI-compatible base URL (…/v1)" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} required />
      <Input type="password" placeholder="API key (optional)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="sm:col-span-2" />
      {error && <p className="text-error settings-error text-xs sm:col-span-2">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Add provider</Button>
      </div>
    </form>
  );
}

export function ProvidersSettings() {
  return (
    <SettingsPage title="Providers" description="OpenCode Go is the primary connection. Add any other provider for more models. Keys are encrypted at rest.">
      <ProviderLists />
    </SettingsPage>
  );
}

/** Connected and available providers for the current scope. */
export function ProviderLists() {
  const { providers } = useScope();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);

  const { connected, primary, rest } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (p: ProviderInfo) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q);
    return {
      connected: providers.filter((p) => p.connected),
      primary: providers.filter((p) => !p.connected && p.primary && match(p)),
      rest: providers.filter((p) => !p.connected && !p.primary && match(p)),
    };
  }, [providers, query]);

  const rows = (list: ProviderInfo[]) =>
    list.map((p, index) => (
      <ProviderRow key={p.id} index={index} provider={p} expanded={expanded === p.id} onToggle={() => setExpanded(expanded === p.id ? null : p.id)} />
    ));

  return (
    <>
      {connected.length > 0 && <SettingsSection title="Connected">{rows(connected)}</SettingsSection>}
      <SettingsSection
        title="Add a provider"
        action={
          <div className="relative">
            <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input placeholder="Search providers" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 w-56 pl-8" />
          </div>
        }
      >
        {rows(primary)}
        {addingCustom ? (
          <CustomProviderForm onDone={() => setAddingCustom(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setAddingCustom(true)}
            className={cn("text-muted-foreground hover:text-foreground flex items-center gap-2 px-4 py-3 text-sm transition-colors duration-(--motion-fast)")}
          >
            <PlusIcon className="size-4" /> Custom OpenAI-compatible endpoint (Ollama, LM Studio, vLLM…)
          </button>
        )}
      </SettingsSection>
      {rest.length > 0 && <SettingsSection title={`All providers (${rest.length})`}>{rows(rest)}</SettingsSection>}
    </>
  );
}
