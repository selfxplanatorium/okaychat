import { CheckIcon, ChevronDownIcon, ExternalLinkIcon, Loader2Icon, MicIcon, PlayIcon, SearchIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  SPEECH_KEY_SERVICES,
  STT_ENGINES,
  TTS_ENGINES,
  sttEngineDef,
  ttsEngineDef,
  type SpeechCredential,
  type SpeechEngineStatus,
  type SpeechKeyService,
  type SpeechOptionList,
  type SpeechSettings,
  type SpeechStatus,
  type SttEngineId,
  type TtsEngineId,
  type TtsSplit,
} from "@shared/speech";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { currentLocale, t } from "@/i18n";
import { ServiceAvailability } from "@/components/ServiceAvailability";
import { formatBytes, formatNumber } from "@/i18n/format";
import { Trans } from "@/i18n/react";
import { cn } from "@/lib/utils";
import { browserDictationSupported } from "@/speech/adapters";
import { canRecord, RecorderDictationAdapter } from "@/speech/recorder";
import { sttEngineOf, ttsEngineOf, useSpeech } from "@/speech/store";
import { BrowserSpeechAdapter, browserSpeechSupported, primeAudio, ServerSpeechAdapter } from "@/speech/synthesis";
import { markUsedServices } from "@/state/services";
import { useServiceDown } from "@/components/chat/ServiceNotice";
import { useData } from "@/state/data";
import { SettingsPage, SettingsRow, SettingsSection, SettingsSlider } from "./SettingsUI";

const LANGUAGE_CODES: Array<[value: string, name: string]> = [
  ["en", "en"], ["de", "de"], ["fr", "fr"], ["es", "es"], ["it", "it"], ["pt", "pt"],
  ["nl", "nl"], ["pl", "pl"], ["sv", "sv"], ["da", "da"], ["nb", "no"], ["fi", "fi"], ["cs", "cs"], ["tr", "tr"],
  ["ru", "ru"], ["uk", "uk"], ["ar", "ar"], ["hi", "hi"], ["ja", "ja"], ["ko", "ko"], ["zh", "zh"],
];

function languageOptions() {
  const names = new Intl.DisplayNames(currentLocale(), { type: "language" });
  return [
    { value: "", label: t("voice.detectAutomatically") },
    ...LANGUAGE_CODES.map(([value, name]) => ({ value, label: names.of(name) ?? value })),
  ];
}

/** Read aloud and speech to text: engines, credentials, voices, and behavior. */
export function VoiceSettings() {
  const settings = useData((s) => s.settings);
  const update = useData((s) => s.updateSettings);
  const status = useSpeech((s) => s.status);
  const setStatus = useSpeech((s) => s.setStatus);
  useEffect(() => {
    void useSpeech.getState().load();
  }, []);
  if (!settings || !status) return null;
  const speech = settings.speech ?? {};
  // `call` rides along untouched: these sections only edit the read-aloud and dictation halves.
  const save = (patch: SpeechSettings) =>
    update({ speech: { stt: { ...speech.stt, ...patch.stt }, tts: { ...speech.tts, ...patch.tts }, ...(speech.call ? { call: speech.call } : {}) } });
  const saveCall = (call: NonNullable<SpeechSettings["call"]>) =>
    update({ speech: { stt: speech.stt, tts: speech.tts, call } });

  return (
    <SettingsPage title={t("voice.title")} description={t("voice.description")}>
      {/* Server voices need the speech worker; cloud and browser engines keep working without it. */}
      <ServiceAvailability id="speech" messageKey="services.voiceLocalNote" describeId="speech-service-availability" />
      <ReadAloud speech={speech} status={status} save={save} onStatus={setStatus} />
      <SpeechToText speech={speech} status={status} save={save} onStatus={setStatus} />
      <VoiceCalls speech={speech} save={saveCall} />
      <Privacy status={status} />
    </SettingsPage>
  );
}

type SectionProps = { speech: SpeechSettings; status: SpeechStatus; save: (patch: SpeechSettings) => Promise<void>; onStatus: (s: SpeechStatus) => void };

function engineLabel(def: { name: string }, s: SpeechEngineStatus | undefined) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate">{def.name}</span>
      {s && !s.ready && <span className="text-muted-foreground shrink-0 text-xs">{s.reason === "Not connected." ? t("voice.engineNotConnected") : t("voice.engineUnavailable")}</span>}
    </span>
  );
}

function ReadAloud({ speech, status, save, onStatus }: SectionProps) {
  const tts = speech.tts ?? {};
  const engine = ttsEngineOf(speech);
  const def = engine === "off" ? undefined : ttsEngineDef(engine);
  const engineStatus = status.tts.find((e) => e.id === engine);
  const options = [
    { value: "off" as const, label: t("common.off") },
    ...TTS_ENGINES.filter((d) => d.id !== "local" || status.worker).map((d) => ({ value: d.id, label: engineLabel(d, status.tts.find((e) => e.id === d.id)) })),
  ];
  const choose = (next: TtsEngineId | "off") => {
    primeAudio();
    void save({ tts: { engine: next } });
  };
  return (
    <SettingsSection title={t("voice.readAloud")} description={t("voice.readAloudDescription")}>
      <SettingsRow
        label={t("voice.voiceEngine")}
        description={def?.id === "browser" ? <span className="text-warning">{def.note}</span> : def?.note}
        control={<Select aria-label={t("voice.readAloudEngine")} className="w-full md:w-72" value={engine} onValueChange={choose} options={options} />}
      />
      {def && engineStatus && !engineStatus.ready && <Credential credential={def.credential} status={engineStatus} keys={status.keys} onStatus={onStatus} />}
      {def && engineStatus?.ready && (
        <>
          {def.credential.type === "own" && <Credential credential={def.credential} status={engineStatus} keys={status.keys} onStatus={onStatus} />}
          {def.id === "browser" ? (
            <BrowserVoiceRow value={tts.voices?.browser} onSave={(voice) => save({ tts: { voices: { ...tts.voices, browser: voice } } })} />
          ) : (
            (def.voices.length > 0 || def.freeVoice || def.id === "local") && (
              <SettingsRow
                label={t("voice.voice")}
                control={<OptionPicker kind="tts" engine={def.id} what="voices" value={tts.voices?.[def.id] ?? (def.id === "local" ? status.localVoice : def.voices[0]) ?? ""} free={!!def.freeVoice} onSave={(v) => save({ tts: { voices: { ...tts.voices, [def.id]: v } } })} />}
              />
            )
          )}
          {(def.models.length > 0 || def.freeModel) && (
            <SettingsRow
              label={t("voice.model")}
              control={<OptionPicker kind="tts" engine={def.id} what="models" value={tts.models?.[def.id] ?? def.models[0] ?? ""} free={!!def.freeModel} onSave={(v) => save({ tts: { models: { ...tts.models, [def.id]: v } } })} />}
            />
          )}
          {def.instructions && <StyleRow value={tts.instructions ?? ""} onSave={(instructions) => save({ tts: { instructions } })} />}
          <SettingsRow
            label={t("voice.speed")}
            control={<SettingsSlider label={t("voice.readAloudSpeed")} min={0.5} max={2} step={0.05} value={tts.speed ?? 1} format={(v) => t("voice.speedValue", { n: formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })} onChange={(speed) => void save({ tts: { speed } })} />}
          />
          {def.id !== "browser" && (
            <SettingsRow
              label={t("voice.pieces")}
              description={t("voice.piecesDescription")}
              control={
                <Select<TtsSplit>
                  aria-label={t("voice.readAloudPieces")}
                  className="w-full md:w-48"
                  value={tts.split ?? "sentence"}
                  onValueChange={(split) => save({ tts: { split } })}
                  options={[{ value: "sentence", label: t("voice.sentences") }, { value: "paragraph", label: t("voice.paragraphs") }, { value: "none", label: t("voice.wholeReply") }]}
                />
              }
            />
          )}
          <SettingsRow
            label={t("voice.autoRead")}
            description={t("voice.autoReadDescription")}
            control={<Switch aria-label={t("voice.autoRead")} checked={!!tts.autoPlay} onCheckedChange={(autoPlay) => save({ tts: { autoPlay } })} />}
          />
          <SettingsRow label={t("voice.preview")} control={<Preview engine={def.id} />} />
        </>
      )}
    </SettingsSection>
  );
}

function Preview({ engine }: { engine: TtsEngineId }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const current = useRef<{ cancel: () => void } | null>(null);
  // The server voice is the only preview that needs the speech worker. Disabled, never hidden, with the
  // reason and fix reachable by keyboard through the note's own controls.
  const speechDown = useServiceDown("speech");
  const unavailable = engine === "local" && speechDown;
  useEffect(() => () => current.current?.cancel(), []);
  const play = () => {
    if (state !== "idle") {
      current.current?.cancel();
      return setState("idle");
    }
    setError(null);
    setState("loading");
    if (engine === "local") markUsedServices(["speech"]);
    const settings = () => useData.getState().settings?.speech?.tts ?? {};
    const adapter =
      engine === "browser"
        ? new BrowserSpeechAdapter(() => ({ voice: settings().voices?.browser, speed: settings().speed ?? 1 }))
        : new ServerSpeechAdapter(() => ({ engine, split: "none", speed: settings().speed ?? 1 }));
    primeAudio();
    const u = adapter.speak(t("voice.sample"));
    current.current = u;
    u.subscribe(() => {
      if (u.status.type === "running") setState("playing");
      if (u.status.type === "ended") {
        setState("idle");
        if (u.status.reason === "error") {
          setError(useSpeech.getState().error ?? t("voice.playbackFailed"));
          useSpeech.getState().setError(null);
        }
      }
    });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={play} disabled={unavailable} aria-describedby={unavailable ? "speech-service-availability" : undefined}>
        {state === "loading" ? <Loader2Icon className="animate-spin" /> : state === "playing" ? <SquareIcon /> : <PlayIcon />}
        {state === "idle" ? t("voice.playSample") : t("common.stop")}
      </Button>
      {error && <span className="text-error max-w-72 text-right text-xs">{error}</span>}
    </div>
  );
}

function StyleRow({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <SettingsRow
      label={t("voice.speakingStyle")}
      description={t("voice.speakingStyleDescription")}
      control={<Textarea aria-label={t("voice.speakingStyle")} rows={2} maxLength={1000} className="w-full md:w-72" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)} />}
    />
  );
}

function BrowserVoiceRow({ value, onSave }: { value?: string; onSave: (voice: string) => void }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (browserSpeechSupported() ? window.speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!browserSpeechSupported()) return;
    const refresh = () => setVoices(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);
  if (!browserSpeechSupported()) return <SettingsRow label={t("voice.voice")} description={<span className="text-warning">{t("voice.browserCannotSpeak")}</span>} control={null} />;
  return (
    <SettingsRow
      label={t("voice.voice")}
      description={voices.length === 0 ? <span className="text-warning">{t("voice.browserNoVoices")}</span> : undefined}
      control={
        <Select
          aria-label={t("voice.browserVoice")}
          className="w-full md:w-72"
          value={value ?? ""}
          onValueChange={onSave}
          options={[{ value: "", label: t("voice.systemDefault") }, ...voices.map((v) => ({ value: v.voiceURI, label: t(v.localService ? "voice.browserVoiceLocal" : "voice.browserVoiceOnline", { name: v.name, lang: v.lang }) }))]}
        />
      }
    />
  );
}

function SpeechToText({ speech, status, save, onStatus }: SectionProps) {
  const stt = speech.stt ?? {};
  const engine = sttEngineOf(speech);
  const def = engine === "off" ? undefined : sttEngineDef(engine);
  const engineStatus = status.stt.find((e) => e.id === engine);
  const browserWorks = browserDictationSupported();
  const options = [
    { value: "off" as const, label: t("common.off") },
    ...STT_ENGINES.filter((d) => d.id !== "local" || status.worker).map((d) => ({ value: d.id, label: engineLabel(d, status.stt.find((e) => e.id === d.id)) })),
  ];
  const note =
    def?.id === "browser" && !browserWorks ? (
      <span className="text-warning">{t(window.isSecureContext ? "voice.noRecognitionHttps" : "voice.noRecognitionNeedsHttps")}</span>
    ) : (
      def?.note
    );
  return (
    <SettingsSection title={t("voice.speechToText")} description={t("voice.speechToTextDescription")}>
      <SettingsRow
        label={t("voice.recognitionEngine")}
        description={note}
        control={<Select<SttEngineId | "off"> aria-label={t("voice.speechRecognitionEngine")} className="w-full md:w-72" value={engine} onValueChange={(v) => save({ stt: { engine: v } })} options={options} />}
      />
      {def && engineStatus && (!engineStatus.ready || def.credential.type === "own") && <Credential credential={def.credential} status={engineStatus} keys={status.keys} onStatus={onStatus} />}
      {def && def.id !== "browser" && engineStatus?.ready && !canRecord() && (
        <div className="text-warning px-4 pb-3 text-xs">
          <Trans k="voice.notHttps" params={{ command: <code>tailscale serve</code> }} />
        </div>
      )}
      {def && engineStatus?.ready && (
        <>
          {(def.models.length > 0 || def.freeModel) && (
            <SettingsRow
              label={t("voice.model")}
              control={<OptionPicker kind="stt" engine={def.id} what="models" value={stt.models?.[def.id] ?? def.models[0] ?? ""} free={!!def.freeModel} onSave={(v) => save({ stt: { models: { ...stt.models, [def.id]: v } } })} />}
            />
          )}
          <SettingsRow
            label={t("voice.language")}
            description={t("voice.languageDescription")}
            control={<Select aria-label={t("voice.speechLanguage")} className="w-full md:w-56" value={stt.language ?? ""} onValueChange={(language) => save({ stt: { language } })} options={languageOptions()} />}
          />
          {def.id !== "browser" && (
            <SettingsRow
              label={t("voice.stopAfterSilence")}
              description={t("voice.stopAfterSilenceDescription")}
              control={<SettingsSlider label={t("voice.stopAfterSilence")} min={0} max={5} step={0.5} value={stt.silenceSeconds ?? 0} format={(v) => (v === 0 ? t("common.off") : t("voice.silenceValue", { n: formatNumber(v) }))} onChange={(silenceSeconds) => void save({ stt: { silenceSeconds } })} />}
            />
          )}
          {def.id !== "browser" && <SettingsRow label={t("voice.tryIt")} description={t("voice.tryItDescription")} control={<TryDictation />} />}
        </>
      )}
    </SettingsSection>
  );
}

function TryDictation() {
  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const [result, setResult] = useState<string | null>(null);
  const session = useRef<ReturnType<RecorderDictationAdapter["listen"]> | null>(null);
  useEffect(() => () => session.current?.cancel(), []);
  const start = () => {
    setResult(null);
    useSpeech.getState().setError(null);
    const stt = () => useData.getState().settings?.speech?.stt ?? {};
    const adapter = new RecorderDictationAdapter(() => ({ silenceSeconds: stt().silenceSeconds || 3, maxSeconds: 30, language: stt().language || undefined }));
    const s = adapter.listen();
    session.current = s;
    setState("recording");
    s.onSpeech((r) => setResult(r.transcript || t("voice.nothingHeard")));
    s.onSpeechEnd(() => {
      setState("idle");
      const error = useSpeech.getState().error;
      if (error) {
        setResult(error);
        useSpeech.getState().setError(null);
      }
    });
    const unsub = useSpeech.subscribe((st) => st.transcribing && setState("working"));
    s.onSpeechEnd(() => unsub());
  };
  return (
    <div className="flex max-w-72 flex-col items-end gap-1">
      {state === "idle" ? (
        <Button size="sm" variant="outline" onClick={start}>
          <MicIcon /> {canRecord() ? t("voice.record") : t("voice.chooseAudioFile")}
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={state === "working"} onClick={() => void session.current?.stop()}>
          {state === "working" ? <Loader2Icon className="animate-spin" /> : <SquareIcon className="text-destructive fill-current" />}
          {state === "working" ? t("voice.transcribing") : t("common.stop")}
        </Button>
      )}
      {result && <span className="text-muted-foreground text-right text-xs">{result}</span>}
    </div>
  );
}

function VoiceCalls({ speech, save }: { speech: SpeechSettings; save: (call: NonNullable<SpeechSettings["call"]>) => Promise<void> }) {
  const call = speech.call ?? {};
  return (
    <SettingsSection title={t("voice.callSettingsTitle")}>
      <SettingsRow
        label={t("voice.callDefaultEngine")}
        description={t("voice.callDefaultEngineDescription")}
        control={
          <Select<"local" | "realtime">
            aria-label={t("voice.callDefaultEngine")}
            className="w-full md:w-56"
            value={call.engine ?? "local"}
            onValueChange={(engine) => void save({ ...call, engine })}
            options={[
              { value: "local", label: t("voice.callEngineLocal") },
              { value: "realtime", label: t("voice.callEngineRealtime") },
            ]}
          />
        }
      />
      <SettingsRow
        label={t("voice.callDing")}
        description={t("voice.callDingDescription")}
        control={<Switch checked={!!call.ding} onCheckedChange={(ding) => void save({ ...call, ding })} aria-label={t("voice.callDing")} />}
      />
      <p className="text-muted-foreground px-4 pb-3 text-xs">{t("voice.callSettingsDescription")}</p>
    </SettingsSection>
  );
}

function Privacy({ status }: { status: SpeechStatus }) {
  const [stats, setStats] = useState<{ count: number; bytes: number } | null>(null);
  useEffect(() => {
    api<{ count: number; bytes: number }>("/speech/recordings").then(setStats, () => {});
  }, []);
  const hours = status.retentionHours;
  return (
    <SettingsSection title={t("voice.recordings")}>
      <SettingsRow
        label={hours === 0 ? t("voice.notStored") : hours >= 48 ? t("voice.keptForDays", { count: Math.round(hours / 24) }) : t("voice.keptForHours", { count: hours })}
        description={
          hours === 0
            ? t("voice.notStoredDescription")
            : t("voice.keptDescription")
        }
        control={
          stats && stats.count > 0 ? (
            <Button size="sm" variant="outline" onClick={() => api<{ deleted: number }>("/speech/recordings", { method: "DELETE" }).then(() => setStats({ count: 0, bytes: 0 }))}>
              {t("voice.deleteRecordings", { count: formatNumber(stats.count), size: formatBytes(stats.bytes) })}
            </Button>
          ) : null
        }
      />
    </SettingsSection>
  );
}

function connectedText(name: string, shared: boolean, region?: string, url?: string) {
  if (shared) {
    if (region && url) return t("voice.keySharedRegionAt", { name, region, url });
    if (region) return t("voice.keySharedRegion", { name, region });
    if (url) return t("voice.keySharedAt", { name, url });
    return t("voice.keyShared", { name });
  }
  if (region && url) return t("voice.keyConnectedRegionAt", { name, region, url });
  if (region) return t("voice.keyConnectedRegion", { name, region });
  if (url) return t("voice.keyConnectedAt", { name, url });
  return t("voice.keyConnected", { name });
}

/** How an engine connects: provider link, speech-only key form, or nothing to do. */
export function Credential({
  credential,
  status,
  keys,
  onStatus,
  scope = "user",
}: {
  credential: SpeechCredential;
  status?: SpeechEngineStatus;
  keys: SpeechStatus["keys"];
  onStatus?: (s: SpeechStatus) => void;
  scope?: "user" | "admin";
}) {
  if (credential.type === "browser") return null;
  if (credential.type === "local") return status?.ready ? null : <p className="text-muted-foreground px-4 pb-3 text-xs">{status?.reason}</p>;
  if (credential.type === "provider") {
    return (
      <p className="text-muted-foreground px-4 pb-3 text-xs">
        {status?.ready ? (status.shared ? t("voice.usesSharedKey") : t("voice.usesProviderKey")) : `${t("voice.usesChatKey")} `}
        {!status?.ready && <Link href="/settings/providers" className="text-primary hover:underline">{t("voice.connectProvider", { provider: credential.providerId === "openai" ? "OpenAI" : credential.providerId === "groq" ? "Groq" : "Mistral" })}</Link>}
      </p>
    );
  }
  return <SpeechKeyForm service={credential.service} state={keys[credential.service]} onStatus={onStatus} scope={scope} />;
}

export function SpeechKeyForm({
  service,
  state,
  onStatus,
  scope = "user",
  onSaved,
}: {
  service: SpeechKeyService;
  state?: { connected: boolean; shared?: boolean; region?: string; baseURL?: string };
  onStatus?: (s: SpeechStatus) => void;
  scope?: "user" | "admin";
  onSaved?: () => void;
}) {
  const def = SPEECH_KEY_SERVICES[service];
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState(state?.region ?? "");
  const [baseURL, setBaseURL] = useState(state?.baseURL ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = scope === "admin" ? `/admin/speech/keys/${service}` : `/speech/keys/${service}`;
  if (state?.shared && scope === "user") return <p className="text-muted-foreground px-4 pb-3 text-xs">{t("voice.usesNamedSharedKey", { name: def.name })}</p>;
  const send = async (method: "PUT" | "DELETE") => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...(apiKey ? { apiKey } : {}), ...(def.fields.includes("region") ? { region: region.trim() } : {}), ...(def.fields.includes("baseURL") ? { baseURL: baseURL.trim() } : {}) };
      const next = await api<SpeechStatus | { ok: true }>(path, method === "PUT" ? { method, json: body } : { method });
      if ("stt" in next) onStatus?.(next);
      onSaved?.();
      setApiKey("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (state?.connected) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs">
        <span className="text-muted-foreground">
          {connectedText(def.name, scope === "admin", state.region, state.baseURL)}
        </span>
        <Button size="sm" variant="outline" onClick={() => send("DELETE")} disabled={busy}>
          {t("common.remove")}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-4 pb-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send("PUT");
      }}
    >
      {def.fields.includes("baseURL") && (
        <Input aria-label={t("voice.serviceAddress", { name: def.name })} placeholder="https://host:port/v1" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} className="h-8 w-full sm:w-72" />
      )}
      {def.fields.includes("region") && <Input aria-label={t("voice.azureRegion")} placeholder={t("voice.regionPlaceholder")} value={region} onChange={(e) => setRegion(e.target.value)} className="h-8 w-full sm:w-44" />}
      <Input
        type="password"
        aria-label={t("voice.serviceApiKey", { name: def.name })}
        placeholder={def.fields.includes("baseURL") ? t("voice.apiKeyOptionalPlaceholder") : t("voice.apiKeyPlaceholder")}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        className="h-8 w-full sm:w-64"
      />
      <Button size="sm" type="submit" disabled={busy || (!def.fields.includes("baseURL") && !apiKey.trim())}>
        {busy && <Loader2Icon className="animate-spin" />}
        {t("common.save")}
      </Button>
      {def.keyUrl && (
        <a href={def.keyUrl} target="_blank" rel="noreferrer" className="text-primary flex items-center gap-1 text-xs hover:underline">
          {t("voice.getKey")} <ExternalLinkIcon className="size-3" />
        </a>
      )}
      {error && <span className="text-error w-full text-xs">{error}</span>}
    </form>
  );
}

/** Voice or model picker. Loads the provider's list when opened; free engines also accept a typed value. */
function OptionPicker({ kind, engine, what, value, free, onSave }: { kind: "stt" | "tts"; engine: string; what: "models" | "voices"; value: string; free: boolean; onSave: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<SpeechOptionList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    setList(null);
    setFailed(null);
  }, [engine]);
  useEffect(() => {
    if (!open || list) return;
    api<SpeechOptionList>(`/speech/options?${new URLSearchParams({ kind, engine, what })}`).then(setList, (e: Error) => setFailed(e.message));
  }, [open, list, kind, engine, what]);
  const q = query.trim().toLowerCase();
  const options = (list?.options ?? []).filter((o) => !q || o.id.toLowerCase().includes(q) || o.name?.toLowerCase().includes(q) || o.language?.toLowerCase().includes(q));
  const current = list?.options.find((o) => o.id === value);
  const pick = (id: string) => {
    if (id && id !== value) onSave(id);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={what === "voices" ? t("voice.voice") : t("voice.model")}
        className="group bg-muted/60 hover:bg-muted aria-expanded:bg-muted flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg px-3 text-xs transition-colors duration-(--motion-fast) ease-out-quart md:w-72"
      >
        <span className="truncate">{current?.name ?? value}</span>
        <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-(--motion-base) ease-out-expo group-aria-expanded:rotate-180" />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="flex max-h-[min(24rem,60dvh)] w-[min(24rem,calc(100vw-1rem))] flex-col p-0">
        <form
          className="flex items-center gap-2 border-b px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (free && query.trim()) pick(query.trim());
          }}
        >
          <SearchIcon className="text-muted-foreground size-4" />
          <input
            autoFocus={window.matchMedia("(pointer: fine)").matches}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={free ? t(what === "voices" ? "voice.searchOrTypeVoice" : "voice.searchOrTypeModel") : t(what === "voices" ? "voice.searchVoices" : "voice.searchModels")}
            className="placeholder:text-muted-foreground h-7 pointer-coarse:h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </form>
        <ScrollArea className="flex-1" viewportClassName="p-1">
          <div role="listbox">
            {!list && !failed && (
              <p className="text-muted-foreground flex items-center justify-center gap-2 px-3 py-6 text-sm">
                <Loader2Icon className="size-4 animate-spin" /> {t(what === "voices" ? "voice.loadingVoices" : "voice.loadingModels")}
              </p>
            )}
            {failed && <p className="text-error px-3 py-6 text-center text-sm">{failed}</p>}
            {list && !list.live && list.error && <p className="text-muted-foreground px-2 pt-1 pb-2 text-[11px]">{list.error}</p>}
            {options.map((o) => (
              <div
                key={o.id}
                role="option"
                aria-selected={o.id === value}
                tabIndex={0}
                onClick={() => pick(o.id)}
                onKeyDown={(e) => e.key === "Enter" && pick(o.id)}
                className="hover:bg-accent focus-visible:bg-accent active:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 pointer-coarse:py-2.5 outline-none transition-colors duration-(--motion-fast) ease-out-quart"
              >
                <CheckIcon className={cn("size-3.5 shrink-0 transition-opacity duration-(--motion-fast) ease-out-quart", o.id === value ? "opacity-100" : "opacity-0")} />
                <div className="min-w-0 flex-1">
                  {o.name && o.name !== o.id && <div className="truncate text-sm">{o.name}</div>}
                  <div className={cn("truncate font-mono", o.name && o.name !== o.id ? "text-muted-foreground text-[11px]" : "text-xs")}>{o.id}</div>
                </div>
              </div>
            ))}
            {list && options.length === 0 && <p className="text-muted-foreground px-3 py-6 text-center text-sm">{free && q ? t("voice.pressEnter") : t(what === "voices" ? "voice.noVoicesMatch" : "voice.noModelsMatch")}</p>}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
