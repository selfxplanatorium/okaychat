import { useEffect, useState } from "react";
import { DEFAULT_USER_SETTINGS, SIDEBAR_ITEMS } from "@shared/types";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useData } from "@/state/data";
import { CodexConnect } from "./CodexConnect";
import { SettingsPage, SettingsRow, SettingsSection, SettingsSlider } from "./SettingsUI";

const SIDEBAR_LABELS = { newChat: "New chat", scheduled: "Scheduled", library: "Library", plugins: "Plugins", projects: "Projects" };

export function GeneralSettings() {
  const settings = useData((s) => s.settings);
  const models = useData((s) => s.models);
  const update = useData((s) => s.updateSettings);
  const [prompt, setPrompt] = useState(settings?.systemPrompt ?? "");
  const [sandbox, setSandbox] = useState<{ configured: boolean; reachable: boolean } | null>(null);
  useEffect(() => setPrompt(settings?.systemPrompt ?? ""), [settings?.systemPrompt]);
  useEffect(() => {
    api<{ configured: boolean; reachable: boolean }>("/sandbox").then(setSandbox, () => setSandbox({ configured: false, reachable: false }));
  }, []);
  if (!settings) return null;

  // The provider id is secondary, so it is the part that gives way when the trigger is narrow.
  const modelLabel = (m: { name: string; providerId: string }) => (
    <span className="flex min-w-0 items-baseline">
      <span className="min-w-0 truncate">{m.name}</span>
      <span className="text-muted-foreground shrink-0 whitespace-pre">{` · ${m.providerId}`}</span>
    </span>
  );
  const modelOptions = models.map((m) => ({ value: m.ref, label: modelLabel(m) }));

  return (
    <SettingsPage title="General">
      <SettingsSection title="Sidebar" description="Choose the shortcuts shown above your chats. Search and settings are always available.">
        {SIDEBAR_ITEMS.map((item) => (
          <SettingsRow
            key={item}
            label={SIDEBAR_LABELS[item]}
            control={<Switch aria-label={`Show ${SIDEBAR_LABELS[item]} in sidebar`} checked={(settings.sidebarItems ?? SIDEBAR_ITEMS).includes(item)} onCheckedChange={(checked) => {
              const visible = settings.sidebarItems ?? SIDEBAR_ITEMS;
              void update({ sidebarItems: SIDEBAR_ITEMS.filter((id) => id === item ? checked : visible.includes(id)) });
            }} />}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Models">
        <SettingsRow
          label="Default model"
          description="Used for new chats until you pick another in the composer."
          control={<Select aria-label="Default model" className="w-full md:w-80" value={settings.defaultModel ?? ""} onValueChange={(v) => update({ defaultModel: v || null })} options={[{ value: "", label: "First available model" }, ...modelOptions]} />}
        />
        <SettingsRow
          label="Utility model"
          description="Writes chat titles and compaction summaries. A fast, cheap model works best."
          control={
            <Select
              className="w-full md:w-80"
              aria-label="Utility model"
              value={settings.utilityModel ?? ""}
              onValueChange={(v) => update({ utilityModel: v || null })}
              options={[{ value: "", label: "Same as chat model" }, ...modelOptions]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Context">
        <SettingsRow
          label="Auto-compact"
          description="Summarize older messages when the conversation fills this much of the context window. 0 turns it off."
          reset={settings.autoCompactAt !== DEFAULT_USER_SETTINGS.autoCompactAt ? () => update({ autoCompactAt: DEFAULT_USER_SETTINGS.autoCompactAt }) : null}
          control={
            <SettingsSlider
              label="Auto-compact threshold"
              value={Math.round(settings.autoCompactAt * 100)}
              min={0}
              max={95}
              step={5}
              format={(v) => (v === 0 ? "Off" : `${v}%`)}
              onChange={(v) => update({ autoCompactAt: v / 100 })}
            />
          }
        />
        <SettingsRow
          label="Max agent steps"
          description="Tool rounds per reply, followed by a final answer without tools. Web searches have a separate limit."
          reset={settings.maxSteps !== DEFAULT_USER_SETTINGS.maxSteps ? () => update({ maxSteps: DEFAULT_USER_SETTINGS.maxSteps }) : null}
          control={<SettingsSlider label="Max agent steps" value={settings.maxSteps} min={1} max={50} step={1} onChange={(v) => update({ maxSteps: v })} />}
        />
        <SettingsRow
          label="Max web searches"
          description="Search queries per reply, shared by the assistant and its sub-agents. Reading pages does not count. 0 turns searching off."
          reset={settings.maxSearches !== DEFAULT_USER_SETTINGS.maxSearches ? () => update({ maxSearches: DEFAULT_USER_SETTINGS.maxSearches }) : null}
          control={<SettingsSlider label="Max web searches" value={settings.maxSearches} min={0} max={50} step={1} onChange={(v) => update({ maxSearches: v })} />}
        />
      </SettingsSection>

      <SettingsSection title="Tools">
        <SettingsRow
          label="Web search and page reading"
          description="Free, no keys. Lets models search the web and read pages, PDFs, and sites that block bots."
          control={<Switch checked={settings.webTools} onCheckedChange={(webTools) => update({ webTools })} aria-label="Web tools" />}
        />
        <SettingsRow
          label="Artifacts"
          description="Lets models create pages, apps, diagrams, and documents that open in a side panel, with versions and download."
          control={<Switch checked={settings.artifacts} onCheckedChange={(artifacts) => update({ artifacts })} aria-label="Artifacts" />}
        />
        <SettingsRow
          label="Generative UI"
          description="Lets models answer with tables, cards, and forms in the app's style, or interactive charts and calculators in a sandboxed frame."
          control={<Switch checked={settings.generativeUI} onCheckedChange={(generativeUI) => update({ generativeUI })} aria-label="Generative UI" />}
        />
        <SettingsRow
          label="Sub-agents"
          description="Lets the chat model hand self-contained tasks to another model that works in its own context with web and read-only tools."
          control={<Switch checked={settings.subagents} onCheckedChange={(subagents) => update({ subagents })} aria-label="Sub-agents" />}
        />
        {settings.subagents && (
          <div className="settings-collapse">
            <SettingsRow
              label="Sub-agent model"
              description="Default for delegated tasks. The utility model and the chat model are offered too."
              control={
                <Select
                  className="w-full md:w-80"
                  aria-label="Sub-agent model"
                  value={settings.subagentModel ?? ""}
                  onValueChange={(v) => update({ subagentModel: v || null })}
                  options={[{ value: "", label: "Same as utility model" }, { value: "chat", label: "Same as chat model" }, ...models.filter((m) => m.toolCall).map((m) => ({ value: m.ref, label: modelLabel(m) }))]}
                />
              }
            />
          </div>
        )}
        <SettingsRow
          label="Code execution"
          description={
            sandbox && !sandbox.configured
              ? "Not set up on this server. An admin can add the sandbox container (see docker-compose.yml)."
              : sandbox && !sandbox.reachable
                ? "The sandbox container is configured but not reachable right now."
                : "Lets models run Python and Bash in a private sandbox for each chat, with files that persist between runs."
          }
          control={<Switch checked={settings.codeExecution && !!sandbox?.configured} disabled={!sandbox?.configured} onCheckedChange={(codeExecution) => update({ codeExecution })} aria-label="Code execution" />}
        />
        <SettingsRow
          label="Image generation"
          description="Create and edit images with your own ChatGPT plan through the Codex CLI. Sign in once with a one-time code."
          control={<CodexConnect />}
        />
      </SettingsSection>

      <SettingsSection title="Custom instructions" description="Added to the system prompt of every chat. Changing it resets the prompt cache once.">
        <div className="p-3">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => prompt !== settings.systemPrompt && update({ systemPrompt: prompt })}
            placeholder="e.g. Be concise. I'm a backend engineer. Prefer TypeScript examples."
            className="min-h-32"
          />
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
