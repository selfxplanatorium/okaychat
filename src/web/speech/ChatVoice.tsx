import { useAui, useAuiState } from "@assistant-ui/react";
import { Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, type FC } from "react";
import { chatPrivacyFor } from "@/state/chat-privacy";
import { useData } from "@/state/data";
import { useThreadSyncStore } from "@/state/thread-sync";
import { canRecord } from "./recorder";
import { sttEngineOf, ttsEngineOf, useSpeech } from "./store";
import { primeAudio } from "./synthesis";

/** Sends the message once a dictation stopped by the send button has its transcript, and tells dictation whether this chat is temporary. */
export const DictationSend: FC = () => {
  const aui = useAui();
  const dictating = useAuiState((s) => s.composer.dictation != null);
  const pending = useSpeech((s) => s.sendAfterDictation);
  useEffect(() => {
    useSpeech.setState({ temporaryChat: () => chatPrivacyFor(aui.threadListItem.getState()).temporary });
    // A pending send belongs to this chat's composer only.
    return () => useSpeech.setState({ sendAfterDictation: false });
  }, [aui]);
  useEffect(() => {
    if (dictating || !pending) return;
    useSpeech.setState({ sendAfterDictation: false });
    // The transcript is in the composer before dictation ends. A failed transcription keeps the text for review.
    // A cached paint not yet replaced by the server's rows blocks sending; the transcript stays in the composer.
    const blocked = useThreadSyncStore.getState().byId[aui.threadListItem.getState().remoteId ?? ""];
    if (!blocked && !useSpeech.getState().error && aui.composer().getState().text.trim()) aui.composer().send();
  }, [dictating, pending, aui]);
  return null;
};

/** Stops dictation and sends the message as soon as its transcript arrives. */
export function useSendDictation(): () => void {
  const aui = useAui();
  return () => {
    useSpeech.setState({ sendAfterDictation: true, error: null });
    aui.composer().stopDictation();
  };
}

/** Reads each reply aloud when it finishes, if the account turned automatic playback on. */
export const ReadAloudAutoPlay: FC = () => {
  const threadId = useAuiState((s) => s.threadListItem.id);
  return <AutoPlay key={threadId} />;
};

const AutoPlay: FC = () => {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const canSpeak = useAuiState((s) => s.thread.capabilities.speech);
  const autoPlay = useData((s) => ttsEngineOf(s.settings?.speech) !== "off" && !!s.settings?.speech?.tts?.autoPlay);
  const wasRunning = useRef(running);
  useEffect(() => {
    // A click on send counts as the gesture that lets the reply play later.
    if (autoPlay && running) primeAudio();
    if (wasRunning.current && !running && autoPlay && canSpeak) {
      const last = aui.thread().getState().messages.at(-1);
      if (last?.role === "assistant" && last.status?.type === "complete") aui.thread().message({ id: last.id }).speak();
    }
    wasRunning.current = running;
  }, [running, autoPlay, canSpeak, aui]);
  return null;
};

/** "Transcribing…" while a recording is on the server, and the last speech error. */
export const VoiceNotice: FC = () => {
  const transcribing = useSpeech((s) => s.transcribing);
  const error = useSpeech((s) => s.error);
  const setError = useSpeech((s) => s.setError);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 10_000);
    return () => clearTimeout(timer);
  }, [error, setError]);
  if (!transcribing && !error) return null;
  return (
    <div role="status" className="flex items-center gap-2 px-2.5 text-xs">
      {transcribing ? (
        <span className="text-muted-foreground flex items-center gap-1.5">
          <Loader2Icon className="size-3.5 animate-spin" /> Transcribing…
        </span>
      ) : (
        <span className="text-error flex min-w-0 items-center gap-1.5">
          <span className="truncate">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)} className="hover:text-foreground shrink-0 rounded p-0.5">
            <XIcon className="size-3" />
          </button>
        </span>
      )}
    </div>
  );
};

/** The dictation button's label: server engines on plain HTTP transcribe an audio file instead of the microphone. */
export function useDictateLabel(): string {
  const engine = useData((s) => sttEngineOf(s.settings?.speech));
  return engine !== "browser" && engine !== "off" && !canRecord() ? "Transcribe an audio file (the microphone needs HTTPS)" : "Voice input";
}
