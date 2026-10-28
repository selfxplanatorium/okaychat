import { create } from "zustand";
import { DEFAULT_STT_ENGINE, DEFAULT_TTS_ENGINE, type SpeechSettings, type SpeechStatus, type SttEngineId, type TtsEngineId } from "@shared/speech";
import { api } from "@/lib/api";

/** Server-side speech availability plus the live state of recording and playback in this tab. */
interface SpeechStore {
  status: SpeechStatus | null;
  load: () => Promise<SpeechStatus>;
  setStatus: (status: SpeechStatus) => void;
  /** A recording is being transcribed on the server. */
  transcribing: boolean;
  /** The last speech failure, shown next to the composer until dismissed. */
  error: string | null;
  setError: (error: string | null) => void;
  /** Whether the chat on screen is temporary; its recordings must never be kept, whatever the retention. */
  temporaryChat: () => boolean;
  /** Send was pressed while dictating: the message goes out once the transcript lands. */
  sendAfterDictation: boolean;
}

let loading: Promise<SpeechStatus> | null = null;

export const useSpeech = create<SpeechStore>((set) => ({
  status: null,
  load: () =>
    (loading ??= api<SpeechStatus>("/speech")
      .then((status) => {
        set({ status });
        return status;
      })
      .finally(() => {
        loading = null;
      })),
  setStatus: (status) => set({ status }),
  transcribing: false,
  error: null,
  setError: (error) => set({ error }),
  temporaryChat: () => false,
  sendAfterDictation: false,
}));

export const sttEngineOf = (speech: SpeechSettings | undefined): SttEngineId | "off" => speech?.stt?.engine ?? DEFAULT_STT_ENGINE;
export const ttsEngineOf = (speech: SpeechSettings | undefined): TtsEngineId | "off" => speech?.tts?.engine ?? DEFAULT_TTS_ENGINE;

/** POSTs to /api with a raw body and returns the response; errors carry the server's message. */
export async function speechFetch(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`/api${path}`, { credentials: "same-origin", ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Speech request failed (${res.status}).`);
  }
  return res;
}
