import { CheckIcon, ChevronDownIcon, ExternalLinkIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import type { ImageModelList, ImageServiceSettings, ImageServiceStatus } from "@shared/image-services";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useData } from "@/state/data";
import { CodexConnect } from "./CodexConnect";
import { SettingsRow, SettingsSection } from "./SettingsUI";

/** Image generation services: credentials, on/off, and the image model per service. */
export function ImageServicesSettings() {
  const settings = useData((s) => s.settings);
  const update = useData((s) => s.updateSettings);
  const [services, setServices] = useState<ImageServiceStatus[] | null>(null);
  const refresh = useCallback(() => api<ImageServiceStatus[]>("/image-services").then(setServices), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!settings || !services) return null;

  const choose = (id: ImageServiceStatus["id"], patch: { enabled?: boolean; model?: string }) => {
    const current: ImageServiceSettings = settings.imageServices ?? {};
    const next = { ...current, [id]: { ...current[id], ...patch } };
    setServices(services.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    void update({ imageServices: next });
  };
  const ready = services.filter((s) => s.connected && s.enabled).length;

  return (
    <SettingsSection
      title="Image generation"
      description={ready > 1 ? "Several services are on, so the assistant asks which one to use before the first image in a chat." : "The assistant can create and edit images with the services you turn on."}
    >
      {services.map((s) => (
        <div key={s.id}>
          <SettingsRow
            label={s.name}
            description={<Credential service={s} />}
            control={<Switch aria-label={`Use ${s.name} for images`} checked={s.connected && s.enabled} disabled={!s.connected} onCheckedChange={(enabled) => choose(s.id, { enabled })} />}
          />
          <div className="flex flex-col gap-2 px-4 pb-3 empty:hidden">
            {s.credential === "codex" && <CodexConnect onChange={refresh} />}
            {s.credential === "own" && <OwnKey service={s} onChange={setServices} />}
            {s.connected && s.enabled && s.model !== null && <ModelField service={s} onSave={(model) => choose(s.id, { model })} />}
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}

function Credential({ service: s }: { service: ImageServiceStatus }) {
  if (s.credential === "codex") return <>Uses your own ChatGPT plan through the Codex CLI. Sign in once with a one-time code.</>;
  if (s.shared) return <>Uses the key your admin shared.</>;
  if (s.credential === "own") return <>{s.connected ? "Uses the key saved for images." : "Needs an API key for image generation."}</>;
  return s.connected ? (
    <>Uses your {s.name} key from <Link href="/settings/providers" className="text-primary hover:underline">Providers</Link>.</>
  ) : (
    <>Connect {s.name} in <Link href="/settings/providers" className="text-primary hover:underline">Providers</Link>. The same key works for chat and images.</>
  );
}

function OwnKey({ service: s, onChange }: { service: ImageServiceStatus; onChange: (services: ImageServiceStatus[]) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (s.shared) return null;
  const send = async (method: "PUT" | "DELETE") => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api<ImageServiceStatus[]>(`/image-services/${s.id}/key`, method === "PUT" ? { method, json: { apiKey } } : { method }));
      setApiKey("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (s.connected) {
    return (
      <div>
        <Button size="sm" variant="outline" onClick={() => send("DELETE")} disabled={busy}>
          Remove key
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send("PUT");
      }}
    >
      <Input type="password" aria-label={`${s.name} API key`} placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="h-8 w-full sm:w-72" />
      <Button size="sm" type="submit" disabled={busy || !apiKey.trim()}>
        {busy && <Loader2Icon className="animate-spin" />}
        Save
      </Button>
      {s.keyUrl && (
        <a href={s.keyUrl} target="_blank" rel="noreferrer" className="text-primary flex items-center gap-1 text-xs hover:underline">
          Get a key <ExternalLinkIcon className="size-3" />
        </a>
      )}
      {error && <span className="text-error w-full text-xs">{error}</span>}
    </form>
  );
}

/** Lists the models the provider offers to this key, fetched when the picker first opens. */
function ModelField({ service: s, onSave }: { service: ImageServiceStatus; onSave: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ImageModelList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!open || list) return;
    api<ImageModelList>(`/image-services/${s.id}/models`).then(setList, (e: Error) => setFailed(e.message));
  }, [open, list, s.id]);

  const q = query.trim().toLowerCase();
  const models = (list?.models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q));
  const pick = (id: string) => {
    if (id !== s.model) onSave(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground w-12">Model</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={`${s.name} image model`}
          className="group bg-muted/60 hover:bg-muted aria-expanded:bg-muted flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg px-3 font-mono text-xs transition-colors duration-(--motion-fast) ease-out-quart sm:w-72"
        >
          <span className="truncate">{s.model}</span>
          <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-(--motion-base) ease-out-expo group-aria-expanded:rotate-180" />
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="flex max-h-[min(24rem,60dvh)] w-[min(24rem,calc(100vw-1rem))] flex-col p-0">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <SearchIcon className="text-muted-foreground size-4" />
            <input
              autoFocus={window.matchMedia("(pointer: fine)").matches}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${s.name} models`}
              className="placeholder:text-muted-foreground h-7 pointer-coarse:h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <ScrollArea className="flex-1" viewportClassName="p-1">
            <div role="listbox">
              {!list && !failed && (
                <p className="text-muted-foreground flex items-center justify-center gap-2 px-3 py-6 text-sm">
                  <Loader2Icon className="size-4 animate-spin" /> Loading models from {s.name}…
                </p>
              )}
              {failed && <p className="text-error px-3 py-6 text-center text-sm">{failed}</p>}
              {list && !list.live && (
                <p className="text-muted-foreground px-2 pt-1 pb-2 text-[11px]">{list.error ?? `${s.name} has no model list API. Showing models known to work.`}</p>
              )}
              {models.map((m) => (
                <div
                  key={m.id}
                  role="option"
                  aria-selected={m.id === s.model}
                  tabIndex={0}
                  onClick={() => pick(m.id)}
                  onKeyDown={(e) => e.key === "Enter" && pick(m.id)}
                  className="hover:bg-accent focus-visible:bg-accent active:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 pointer-coarse:py-2.5 outline-none transition-colors duration-(--motion-fast) ease-out-quart"
                >
                  <CheckIcon className={cn("size-3.5 shrink-0 transition-opacity duration-(--motion-fast) ease-out-quart", m.id === s.model ? "opacity-100" : "opacity-0")} />
                  <div className="min-w-0 flex-1">
                    {m.name && m.name !== m.id && <div className="truncate text-sm">{m.name}</div>}
                    <div className={cn("truncate font-mono", m.name && m.name !== m.id ? "text-muted-foreground text-[11px]" : "text-xs")}>{m.id}</div>
                  </div>
                </div>
              ))}
              {list && models.length === 0 && <p className="text-muted-foreground px-3 py-6 text-center text-sm">No models match.</p>}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}
