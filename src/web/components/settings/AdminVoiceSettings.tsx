import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SPEECH_KEY_SERVICES, type AdminSpeechSettings, type SpeechKeyService, type SpeechOptionList } from "@shared/speech";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { t, type PlainMessageKey } from "@/i18n";
import { formatBytes, formatList } from "@/i18n/format";
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

const RETENTION_HOURS = [0, 1, 24, 168, 720, 2160];
const retentionLabel = (hours: number) => (hours === 0 ? t("admin.retentionNever") : hours < 24 ? t("admin.retentionHours", { count: hours }) : t("admin.retentionDays", { count: hours / 24 }));
const WHISPER_SIZES: Record<string, PlainMessageKey> = {
  tiny: "admin.whisperTiny", base: "admin.whisperBase", small: "admin.whisperSmall", medium: "admin.whisperMedium", "large-v3-turbo": "admin.whisperTurbo",
  "large-v3": "admin.whisperLarge",
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
  const workerState = !w.configured
    ? t("admin.workerNotConfigured")
    : !w.reachable
      ? t("admin.workerUnreachable")
      : w.sttRunning || w.ttsRunning
        ? t("admin.workerInUse", { engines: formatList([w.sttRunning && "Whisper", w.ttsRunning && "Piper"].filter((x): x is string => !!x)) })
        : t("admin.workerIdle");

  return (
    <SettingsSection title={t("admin.voice")} description={t("admin.voiceDescription")}>
      <SettingsRow label={t("admin.speechWorker")} description={workerState} control={null} />
      <SettingsRow
        label={t("admin.piperReadAloud")}
        description={t("admin.piperDescription")}
        control={<Switch aria-label={t("admin.piperReadAloud")} checked={s.local.tts} disabled={!w.configured} onCheckedChange={(tts) => save({ local: { tts } })} />}
      />
      {s.local.tts && w.configured && <SettingsRow label={t("admin.defaultVoice")} description={t("admin.defaultVoiceDescription")} control={<PiperVoice value={s.local.defaultVoice} onSave={(defaultVoice) => save({ local: { defaultVoice } })} />} />}
      <SettingsRow
        label={t("admin.whisperSpeechToText")}
        description={t("admin.whisperDescription")}
        control={<Switch aria-label={t("admin.whisperSpeechToText")} checked={s.local.stt} disabled={!w.configured} onCheckedChange={(stt) => save({ local: { stt } })} />}
      />
      {s.local.stt && w.configured && (
        <>
          <SettingsRow
            label={t("admin.whisperModel")}
            description={t("admin.whisperModelDescription")}
            control={
              <Select
                aria-label={t("admin.whisperModel")}
                className="w-full md:w-80"
                value={s.local.whisperModel}
                onValueChange={(whisperModel) => save({ local: { whisperModel } })}
                options={data.whisperModels.map((m) => ({ value: m, label: [m, WHISPER_SIZES[m] && t(WHISPER_SIZES[m]), data.worker.downloaded.includes(m) && t("admin.whisperDownloaded")].filter(Boolean).join(" · ") }))}
              />
            }
          />
          <SettingsRow
            label={t("admin.skipSilence")}
            description={t("admin.skipSilenceDescription")}
            control={<Switch aria-label={t("admin.skipSilence")} checked={s.local.vad} onCheckedChange={(vad) => save({ local: { vad } })} />}
          />
        </>
      )}
      <SettingsRow
        label={t("admin.longestRecording")}
        description={t("admin.longestRecordingDescription")}
        control={
          <Select
            aria-label={t("admin.longestRecording")}
            className="w-full md:w-40"
            value={String(s.maxRecordingSeconds)}
            onValueChange={(v) => save({ maxRecordingSeconds: Number(v) })}
            options={[60, 300, 600, 1800, 3600].map((n) => ({ value: String(n), label: t("admin.minutes", { count: n / 60 }) }))}
          />
        }
      />
      <SettingsRow
        label={t("admin.keepRecordings")}
        description={t("admin.keepRecordingsDescription", { count: data.recordings.count, size: formatBytes(data.recordings.bytes) })}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {data.recordings.count > 0 && (
              <Button size="sm" variant="outline" onClick={() => api("/admin/speech/recordings", { method: "DELETE" }).then(refresh)}>
                {t("admin.deleteAll")}
              </Button>
            )}
            <Select aria-label={t("admin.keepRecordings")} className="w-40" value={String(s.retentionHours)} onValueChange={(v) => save({ retentionHours: Number(v) })} options={RETENTION_HOURS.map((h) => ({ value: String(h), label: retentionLabel(h) }))} />
          </div>
        }
      />
      {error && <p className="text-error px-4 pb-3 text-xs">{error}</p>}
      {(Object.keys(SPEECH_KEY_SERVICES) as SpeechKeyService[]).map((service) => (
        <div key={service}>
          <SettingsRow label={t("admin.sharedKey", { service: SPEECH_KEY_SERVICES[service].name })} description={t("admin.sharedKeyDescription")} control={null} className="pb-1" />
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
  return <Select aria-label={t("admin.defaultPiperVoice")} className="w-full md:w-80" value={value} onValueChange={onSave} options={options.map((o) => ({ value: o.id, label: o.name ?? o.id }))} />;
}
