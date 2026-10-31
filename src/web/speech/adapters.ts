import { WebSpeechDictationAdapter } from "@assistant-ui/react";
import { useEffect, useMemo } from "react";
import { useData } from "@/state/data";
import { availabilityOf } from "@/state/services-derive";
import { useServices } from "@/state/services";
import { RecorderDictationAdapter } from "./recorder";
import { sttEngineOf, ttsEngineOf, useSpeech } from "./store";
import { BrowserSpeechAdapter, browserSpeechSupported, ServerSpeechAdapter, speechPrefs } from "./synthesis";

// The adapters read the account's current choices when they start, so they are created once.
const speechSettings = () => useData.getState().settings?.speech;
const serverSpeech = new ServerSpeechAdapter(() => {
  const engine = ttsEngineOf(speechSettings());
  return { engine: engine === "off" || engine === "browser" ? "local" : engine, ...speechPrefs(speechSettings()) };
});
const browserSpeech = new BrowserSpeechAdapter(() => speechPrefs(speechSettings()));
const recorder = new RecorderDictationAdapter(() => {
  const stt = speechSettings()?.stt ?? {};
  return { silenceSeconds: stt.silenceSeconds ?? 0, maxSeconds: useSpeech.getState().status?.maxRecordingSeconds ?? 600, language: stt.language || undefined };
});

export const browserDictationSupported = () => WebSpeechDictationAdapter.isSupported() && window.isSecureContext;

/** True when the chosen engine is the local one and the registry knows the speech worker is down. */
export function useLocalSpeechUnavailable(kind: "stt" | "tts"): boolean {
  const speech = useData((s) => s.settings?.speech);
  const down = useServices((s) => availabilityOf(s, "speech") === "down");
  return down && (kind === "stt" ? sttEngineOf(speech) : ttsEngineOf(speech)) === "local";
}

/**
 * Read aloud and dictation for the chat runtime. Read aloud is off until chosen in Settings → Voice. An adapter is
 * left out when its engine cannot work in this browser (for example no Web Speech support), not when a worker is
 * merely unreachable.
 */
export function useVoiceAdapters() {
  const speech = useData((s) => s.settings?.speech);
  const loaded = useData((s) => s.settings !== null);
  const status = useSpeech((s) => s.status);
  useEffect(() => {
    if (loaded && !status) void useSpeech.getState().load().catch(() => {});
  }, [loaded, status]);

  const tts = ttsEngineOf(speech);
  const stt = sttEngineOf(speech);
  // Readiness is configuration, never reachability: a registry `down` disables the visible control with an
  // explanation, but must not remove it or stop an active recording/playback. Cloud and browser engines are
  // unaffected; a CPU fallback is still up.
  const ttsReady = tts === "browser" ? browserSpeechSupported() : tts !== "off" && !!status?.tts.find((e) => e.id === tts)?.ready;
  const sttReady = stt === "browser" ? browserDictationSupported() : stt !== "off" && !!status?.stt.find((e) => e.id === stt)?.ready;
  const language = speech?.stt?.language || navigator.language;

  return useMemo(
    () => ({
      ...(ttsReady ? { speech: tts === "browser" ? browserSpeech : serverSpeech } : {}),
      ...(sttReady ? { dictation: stt === "browser" ? new WebSpeechDictationAdapter({ language }) : recorder } : {}),
    }),
    [tts, stt, ttsReady, sttReady, language],
  );
}
