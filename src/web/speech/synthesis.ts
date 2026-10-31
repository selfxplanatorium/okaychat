import type { SpeechSynthesisAdapter } from "@assistant-ui/react";
import type { SpeechSettings, TtsEngineId, TtsSplit } from "@shared/speech";
import { t } from "@/i18n";
import { useServices } from "@/state/services";
import { speechFetch, useSpeech } from "./store";
import { splitForSpeech, spokenText } from "./text";

type Utterance = SpeechSynthesisAdapter.Utterance;
type Status = SpeechSynthesisAdapter.Status;

/** The shared shape of an utterance: status, subscribers, and a cancel hook. */
function utterance(onCancel: () => void) {
  const subscribers = new Set<() => void>();
  const res: Utterance & { set: (status: Status) => void } = {
    status: { type: "starting" },
    set(status) {
      if (res.status.type === "ended") return;
      res.status = status;
      for (const cb of subscribers) cb();
    },
    cancel() {
      if (res.status.type === "ended") return;
      onCancel();
      res.set({ type: "ended", reason: "cancelled" });
    },
    subscribe(cb) {
      if (res.status.type === "ended") {
        queueMicrotask(cb);
        return () => {};
      }
      subscribers.add(cb);
      return () => void subscribers.delete(cb);
    },
  };
  return res;
}

// One element for every reply, unlocked on the first click so later automatic playback is allowed (WebKit).
let element: HTMLAudioElement | null = null;
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
function audioElement(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preservesPitch = true;
    element.src = SILENCE;
    void element.play().catch(() => {});
  }
  return element;
}

/**
 * Read aloud through the server: the reply is cut into pieces, each synthesized by the chosen engine while
 * the previous one plays. Speed is the element's playback rate, so it works the same for every engine.
 */
export class ServerSpeechAdapter implements SpeechSynthesisAdapter {
  constructor(private readonly prefs: () => { engine: TtsEngineId; split: TtsSplit; speed: number }) {}

  speak(text: string): Utterance {
    const { engine, split, speed } = this.prefs();
    // Server voices depend on the speech worker; a failure here is what the service notice explains.
    if (engine === "local") useServices.getState().markUsed("speech");
    const pieces = splitForSpeech(spokenText(text), split);
    const controller = new AbortController();
    const audio = audioElement();
    const urls: string[] = [];
    const stop = () => {
      controller.abort();
      audio.pause();
      audio.removeAttribute("src");
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
    const res = utterance(stop);
    const fetchPiece = async (piece: string) => {
      const blob = await (
        await speechFetch("/speech/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: piece, engine }), signal: controller.signal })
      ).blob();
      const url = URL.createObjectURL(blob);
      urls.push(url);
      return url;
    };
    const play = (url: string) =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          audio.removeEventListener("ended", done);
          audio.removeEventListener("error", fail);
          controller.signal.removeEventListener("abort", done);
          resolve();
        };
        const fail = () => {
          audio.removeEventListener("ended", done);
          audio.removeEventListener("error", fail);
          reject(new Error(t("speech.playFailed")));
        };
        audio.addEventListener("ended", done);
        audio.addEventListener("error", fail);
        controller.signal.addEventListener("abort", done);
        audio.src = url;
        audio.playbackRate = speed;
        audio.play().catch(fail);
      });

    void (async () => {
      try {
        if (!pieces.length) return res.set({ type: "ended", reason: "finished" });
        let next = fetchPiece(pieces[0]!);
        for (let i = 0; i < pieces.length; i++) {
          const url = await next;
          // Fetch the following piece while this one plays.
          if (i + 1 < pieces.length) {
            next = fetchPiece(pieces[i + 1]!);
            next.catch(() => {});
          }
          if (controller.signal.aborted) return;
          res.set({ type: "running" });
          await play(url);
          URL.revokeObjectURL(url);
          if (controller.signal.aborted) return;
        }
        res.set({ type: "ended", reason: "finished" });
      } catch (error) {
        if (controller.signal.aborted) return;
        useSpeech.getState().setError((error as Error).message);
        res.set({ type: "ended", reason: "error", error });
      } finally {
        if (res.status.type === "ended") urls.forEach((u) => URL.revokeObjectURL(u));
      }
    })();
    return res;
  }
}

/** Unlocks the shared audio element during a user gesture, so a reply can start playing on its own later. */
export const primeAudio = () => void audioElement();

/** The browser's own voices, with the chosen voice and speed. May be silent where the system has no voices. */
export class BrowserSpeechAdapter implements SpeechSynthesisAdapter {
  constructor(private readonly prefs: () => { voice?: string; speed: number }) {}

  speak(text: string): Utterance {
    const { voice, speed } = this.prefs();
    const res = utterance(() => window.speechSynthesis.cancel());
    const u = new SpeechSynthesisUtterance(spokenText(text));
    const chosen = voice ? window.speechSynthesis.getVoices().find((v) => v.voiceURI === voice || v.name === voice) : undefined;
    if (chosen) {
      u.voice = chosen;
      u.lang = chosen.lang;
    }
    u.rate = speed;
    u.addEventListener("start", () => res.set({ type: "running" }));
    u.addEventListener("end", () => res.set({ type: "ended", reason: "finished" }));
    u.addEventListener("error", (e) => {
      if (e.error === "canceled" || e.error === "interrupted") return;
      useSpeech.getState().setError(t("speech.browserCouldNotSpeak", { reason: e.error }));
      res.set({ type: "ended", reason: "error", error: e.error });
    });
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return res;
  }
}

export const browserSpeechSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function speechPrefs(speech: SpeechSettings | undefined) {
  const tts = speech?.tts ?? {};
  return { split: tts.split ?? "sentence", speed: tts.speed ?? 1, voice: tts.voices?.browser };
}
