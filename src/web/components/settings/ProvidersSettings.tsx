import { CheckCircle2Icon, ExternalLinkIcon, PlusIcon, SearchIcon, SlidersHorizontalIcon, TrashIcon } from "lucide-react";
import { createContext, useContext, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ProviderInfo } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { formatNumber } from "@/i18n/format";
import { useCommand } from "@/keyboard/registry";
import { api } from "@/lib/api";
import { errorText } from "@/lib/error-text";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { AudienceButton } from "./Audience";
import { ChatGPTConnect } from "./ChatGPTConnect";
import { CustomConnectionForm } from "./CustomProviderFields";
import { ModelEntitlementsDialog } from "./ModelEntitlements";
import { OllamaSettings } from "./OllamaSettings";
import { SettingsPage, SettingsSection } from "./SettingsUI";

export const OPENCODE_GO_CONSOLE = "https://opencode.ai/console";
/** Personal Sign in with ChatGPT connection; never shared, and independent of the image login. */
const CHATGPT = "chatgpt";

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
      setError(errorText(e, "common.somethingWentWrong"));
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
          placeholder={provider.shared ? t("providers.ownKeyPlaceholder") : provider.connected ? t("providers.keySavedPlaceholder") : t("providers.apiKey")}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
        />
        <Button type="submit" disabled={busy || (!apiKey && baseURL === (provider.baseURL ?? ""))}>
          {provider.connected && !provider.shared ? t("providers.update") : t("common.connect")}
        </Button>
      </div>
      {(provider.needsBaseURL || provider.custom) && (
        <Input placeholder={t("providers.baseUrlPlaceholder")} value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      )}
      {error && <p className="text-error settings-error text-xs">{error}</p>}
    </form>
  );
}

function ProviderRow({ provider, index, expanded, onToggle, onModels }: { provider: ProviderInfo; index: number; expanded: boolean; onToggle: () => void; onModels?: () => void }) {
  const { base, refresh } = useScope();
  const chatgpt = provider.id === CHATGPT;
  return (
    <div className="stagger animate-rise-in px-4 py-3" style={{ "--i": index } as CSSProperties}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onToggle} className="flex min-w-24 flex-1 items-center gap-2 text-left">
          <span className="truncate text-sm font-medium">{provider.name}</span>
          {provider.id === "opencode-go" && <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">{t("providers.recommended")}</span>}
          {provider.connected && <CheckCircle2Icon className="text-success animate-pop-in size-3.5 shrink-0" aria-label={t("providers.connected")} />}
          {provider.shared && <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">{t("providers.serverKey")}</span>}
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">{provider.modelCount ? t("providers.modelCount", { count: provider.modelCount }) : ""}</span>
        </button>
        {provider.connected && !provider.shared && (
          <>
            {base === "/admin/providers" && (
              <AudienceButton
                audience={provider.audience}
                title={t("providers.whoCanUse", { name: provider.name })}
                description={t("providers.audienceDescription")}
                onSave={async (audience) => {
                  await api(`${base}/${provider.id}/access`, { method: "PUT", json: audience });
                  await refresh();
                }}
              />
            )}
            {base === "/admin/providers" && !chatgpt && onModels && (
              <Button size="xs" variant="outline" onClick={onModels} data-command="settings.providerModels" aria-label={t("entitlements.title", { name: provider.name })}>
                <SlidersHorizontalIcon /> {t("entitlements.modelsButton")}
              </Button>
            )}
            <Switch
              checked={provider.enabled}
              aria-label={t("providers.enable", { name: provider.name })}
              onCheckedChange={async (enabled) => {
                await api(`${base}/${provider.id}`, { method: "PUT", json: { enabled } });
                await refresh();
              }}
            />
            {!chatgpt && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("providers.disconnect", { name: provider.name })}
                onClick={async () => {
                  await api(`${base}/${provider.id}`, { method: "DELETE" });
                  await refresh();
                }}
              >
                <TrashIcon />
              </Button>
            )}
          </>
        )}
      </div>
      {expanded && (
        <div className="settings-collapse mt-3">
          {provider.id === "ollama" ? (
            <OllamaSettings provider={provider} base={base} onChanged={refresh} />
          ) : chatgpt ? (
            <ChatGPTConnect />
          ) : provider.custom ? (
            <CustomConnectionForm
              provider={provider}
              base={base}
              autoFocus
              onCancel={onToggle}
              onSaved={async () => {
                await refresh();
                onToggle();
              }}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <ProviderForm provider={provider} onSaved={onToggle} autoFocus />
              {provider.doc && (
                <a
                  href={provider.id === "opencode-go" ? OPENCODE_GO_CONSOLE : provider.doc}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors duration-(--motion-fast)"
                >
                  {provider.id === "opencode-go" ? t("providers.getKeyOpencode") : t("providers.providerDocs")} <ExternalLinkIcon className="size-3" />
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CustomProviderForm({ onDone }: { onDone: () => void }) {
  const { base, refresh } = useScope();
  return (
    <div className="animate-rise-in px-4 py-3">
      <CustomConnectionForm
        base={base}
        autoFocus
        onCancel={onDone}
        onSaved={async () => {
          await refresh();
          onDone();
        }}
      />
    </div>
  );
}

export function ProvidersSettings() {
  return (
    <SettingsPage title={t("settings.sectionProviders")} description={t("providers.description")}>
      <ProviderLists />
    </SettingsPage>
  );
}

/** Connected and available providers for the current scope. */
export function ProviderLists() {
  const { base, providers, refresh } = useScope();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);
  const [modelsFor, setModelsFor] = useState<ProviderInfo | null>(null);

  const { connected, primary, rest } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (p: ProviderInfo) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q);
    return {
      connected: providers.filter((p) => p.connected),
      primary: providers.filter((p) => !p.connected && p.primary && match(p)),
      rest: providers.filter((p) => !p.connected && !p.primary && match(p)),
    };
  }, [providers, query]);

  // The command opens the row the admin expanded, else the first connected server key. The per-row
  // Models… button remains the direct target.
  useCommand(
    "settings.providerModels",
    () => {
      const openable = connected.filter((p) => p.id !== CHATGPT);
      const target = openable.find((p) => p.id === expanded) ?? openable[0];
      if (!target) return false;
      setModelsFor(target);
      return true;
    },
    base === "/admin/providers",
  );

  const rows = (list: ProviderInfo[]) =>
    list.map((p, index) => (
      <ProviderRow
        key={p.id}
        index={index}
        provider={p}
        expanded={expanded === p.id}
        onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
        onModels={base === "/admin/providers" && p.id !== CHATGPT ? () => setModelsFor(p) : undefined}
      />
    ));

  return (
    <div className="flex flex-col gap-8">
      {modelsFor && <ModelEntitlementsDialog provider={modelsFor} onClose={() => setModelsFor(null)} onSaved={refresh} />}
      {connected.length > 0 && <SettingsSection title={t("providers.connected")}>{rows(connected)}</SettingsSection>}
      <SettingsSection
        title={t("providers.addAProvider")}
        action={
          <div className="relative">
            <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input placeholder={t("providers.searchProviders")} value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 w-56 pl-8" />
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
            <PlusIcon className="size-4" /> {t("providers.customEndpoint")}
          </button>
        )}
      </SettingsSection>
      {rest.length > 0 && <SettingsSection title={t("providers.allProviders", { count: formatNumber(rest.length) })}>{rows(rest)}</SettingsSection>}
    </div>
  );
}
