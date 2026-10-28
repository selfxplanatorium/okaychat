import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SPEECH_KEY_SERVICES, type AdminSpeechSettings, type SpeechKeyService, type SpeechOptionList } from "@shared/speech";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, formatBytes } from "@/lib/api";
import { useSpeech } from "@/speech/store";
import { SettingsRow, SettingsSection } from "./SettingsUI";
import { SpeechKeyForm } from "./VoiceSettings";

interface AdminSpeech {
  settings: AdminSpeechSettings;
  worker: { configured: boolean; reachable: boolean; sttRunning: boolean; ttsRunning: boolean; downloaded: string[] };
  whisperModels: string[];
  recordings: { count: number; bytes: number };
  keys: Record<SpeechKeyService, { connected: boolean; region?: string; baseURL?: string }>;
}

const RETENTION: Array<[number, string]> = [[0, "Never store"], [1, "1 hour"], [24, "1 day"], [168, "7 days"], [720, "30 days"], [2160, "90 days"]];
const WHISPER_SIZES: Record<string, string> = {
  tiny: "fastest, ~75 MB", base: "fast, ~150 MB", small: "better, ~480 MB", medium: "accurate, ~1.5 GB", "large-v3-turbo": "most accurate for its speed, ~1.6 GB",
  "large-v3": "most accurate, slow on CPU, ~3 GB",
};

/** Server-wide speech: the local worker, recording retention, and speech keys shared with everyone. */
export function AdminVoiceSettings() {
  const [data, setData] = useState<AdminSpeech | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => api<AdminSpeech>("/admin/speech").then(setData), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!data) return null;
  const s = data.settings;
  const save = async (patch: Partial<Omit<AdminSpeechSettings, "local">> & { local?: Partial<AdminSpeechSettings["local"]> }) => {
    setError(null);
    try {
      const next = await api<AdminSpeechSettings>("/admin/speech", { method: "PUT", json: { ...s, ...patch, local: { ...s.local, ...patch.local } } });
      setData({ ...data, settings: next });
      // The admin's own Voice page reads availability from the same status.
      void useSpeech.getState().load();
      if (patch.retentionHours !== undefined) void refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const w = data.worker;
  const workerState = !w.configured ? "Not configured (OKAYCHAT_SPEECH_URL is empty)." : !w.reachable ? "Configured but not reachable." : `Running. ${w.sttRunning || w.ttsRunning ? `In use: ${[w.sttRunning && "Whisper", w.ttsRunning && "Piper"].filter(Boolean).join(", ")}.` : "Idle, holding no model memory."}`;

  return (
    <SettingsSection title="Voice" description="Local speech engines run in the speech worker container. Each loads its model on first use and frees the memory after a few idle minutes.">
      <SettingsRow label="Speech worker" description={workerState} control={null} />
      <SettingsRow
        label="Piper read aloud"
        description="Natural voices generated on this server. The default read-aloud engine."
        control={<Switch aria-label="Piper read aloud" checked={s.local.tts} disabled={!w.configured} onCheckedChange={(tts) => save({ local: { tts } })} />}
      />
      {s.local.tts && w.configured && <SettingsRow label="Default voice" description="Used until a user picks their own." control={<PiperVoice value={s.local.defaultVoice} onSave={(defaultVoice) => save({ local: { defaultVoice } })} />} />}
      <SettingsRow
        label="Whisper speech to text"
        description="Users opt in by choosing Whisper in their Voice settings."
        control={<Switch aria-label="Whisper speech to text" checked={s.local.stt} disabled={!w.configured} onCheckedChange={(stt) => save({ local: { stt } })} />}
      />
      {s.local.stt && w.configured && (
        <>
          <SettingsRow
            label="Whisper model"
            description="Larger models recognize speech better but take longer and use more memory. A new model downloads right away."
            control={
              <Select
                aria-label="Whisper model"
                className="w-full md:w-80"
                value={s.local.whisperModel}
                onValueChange={(whisperModel) => save({ local: { whisperModel } })}
                options={data.whisperModels.map((m) => ({ value: m, label: `${m}${WHISPER_SIZES[m] ? ` · ${WHISPER_SIZES[m]}` : ""}${data.worker.downloaded.includes(m) ? " · downloaded" : ""}` }))}
              />
            }
          />
          <SettingsRow
            label="Skip silence"
            description="Removes pauses before transcribing (voice activity detection). Faster and avoids invented words in silent parts."
            control={<Switch aria-label="Skip silence" checked={s.local.vad} onCheckedChange={(vad) => save({ local: { vad } })} />}
          />
        </>
      )}
      <SettingsRow
        label="Longest recording"
        description="Recordings above this length are rejected by Whisper on this server."
        control={
          <Select
            aria-label="Longest recording"
            className="w-full md:w-40"
            value={String(s.maxRecordingSeconds)}
            onValueChange={(v) => save({ maxRecordingSeconds: Number(v) })}
            options={[60, 300, 600, 1800, 3600].map((n) => ({ value: String(n), label: `${n / 60} min` }))}
          />
        }
      />
      <SettingsRow
        label="Keep recordings"
        description={`Off: audio exists only while it is transcribed. Otherwise recordings are stored encrypted and deleted after this time. Stored now: ${data.recordings.count} (${formatBytes(data.recordings.bytes)}).`}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {data.recordings.count > 0 && (
              <Button size="sm" variant="outline" onClick={() => api("/admin/speech/recordings", { method: "DELETE" }).then(refresh)}>
                Delete all
              </Button>
            )}
            <Select aria-label="Keep recordings" className="w-40" value={String(s.retentionHours)} onValueChange={(v) => save({ retentionHours: Number(v) })} options={RETENTION.map(([h, label]) => ({ value: String(h), label }))} />
          </div>
        }
      />
      {error && <p className="text-error px-4 pb-3 text-xs">{error}</p>}
      {(Object.keys(SPEECH_KEY_SERVICES) as SpeechKeyService[]).map((service) => (
        <div key={service}>
          <SettingsRow label={`Shared ${SPEECH_KEY_SERVICES[service].name} key`} description="Every user can use it unless they save their own." control={null} className="pb-1" />
          <SpeechKeyForm service={service} state={data.keys[service]} scope="admin" onSaved={refresh} />
        </div>
      ))}
    </SettingsSection>
  );
}

function PiperVoice({ value, onSave }: { value: string; onSave: (voice: string) => void }) {
  const [list, setList] = useState<SpeechOptionList | null>(null);
  useEffect(() => {
    void api<SpeechOptionList>("/speech/options?kind=tts&engine=local&what=voices").then(setList);
  }, []);
  if (!list) return <Loader2Icon className="text-muted-foreground size-4 animate-spin" />;
  const options = list.options.some((o) => o.id === value) ? list.options : [{ id: value }, ...list.options];
  return <Select aria-label="Default Piper voice" className="w-full md:w-80" value={value} onValueChange={onSave} options={options.map((o) => ({ value: o.id, label: o.name ?? o.id }))} />;
}
