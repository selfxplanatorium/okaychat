import { useEffect, useState } from "react";
import { DEFAULT_USER_SETTINGS } from "@shared/types";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useData } from "@/state/data";
import { SettingsPage, SettingsRow, SettingsSection, SettingsSlider } from "./SettingsUI";

export function GeneralSettings() {
  const settings = useData((s) => s.settings);
  const models = useData((s) => s.models);
  const update = useData((s) => s.updateSettings);
  const [prompt, setPrompt] = useState(settings?.systemPrompt ?? "");
  useEffect(() => setPrompt(settings?.systemPrompt ?? ""), [settings?.systemPrompt]);
  if (!settings) return null;

  const modelOptions = models.map((m) => ({ value: m.ref, label: `${m.name} · ${m.providerId}` }));

  return (
    <SettingsPage title="General">
      <SettingsSection title="Models">
        <SettingsRow
          label="Default model"
          description="Used for new chats until you pick another in the composer."
          control={<Select className="w-64" value={settings.defaultModel ?? null} onValueChange={(v) => update({ defaultModel: v })} options={modelOptions} placeholder="First available" />}
        />
        <SettingsRow
          label="Utility model"
          description="Writes chat titles and compaction summaries. A fast, cheap model works best."
          control={
            <Select
              className="w-64"
              value={settings.utilityModel ?? null}
              onValueChange={(v) => update({ utilityModel: v })}
              options={modelOptions}
              placeholder="Same as chat model"
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
          description="How many tool round trips the model may take in one reply."
          reset={settings.maxSteps !== DEFAULT_USER_SETTINGS.maxSteps ? () => update({ maxSteps: DEFAULT_USER_SETTINGS.maxSteps }) : null}
          control={<SettingsSlider label="Max agent steps" value={settings.maxSteps} min={1} max={50} step={1} onChange={(v) => update({ maxSteps: v })} />}
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
