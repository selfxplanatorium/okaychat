import { createVoiceSession, type RealtimeVoiceAdapter } from "@assistant-ui/core";

// OpenAI Realtime over WebRTC. The browser gets only an SDP answer: the OpenAI key and the session
// configuration stay on the server (`src/server/voice/backend.ts`). assistant-ui's voice session records the
// final transcripts as voice messages in the starting chat, so the call reads like a normal exchange, while the
// Realtime model answers directly (it does not use this chat's tools, RAG, memory, or compaction).

export interface RealtimeAdapterOptions {
  /** Sends the offer over the call socket and resolves with OpenAI's answer. */
  exchangeSdp: (sdp: string, signal: AbortSignal) => Promise<string>;
  /** The session could not start or lost its connection; the controller falls back to the local pipeline. */
  onFailure?: (reason: string) => void;
}

interface EventRecord {
  type?: unknown;
  [key: string]: unknown;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** Turns an OpenAI data-channel event into transcript or mode information. Pure, so the shapes are testable. */
export function readRealtimeEvent(event: EventRecord, assistant: { text: string }): {
  transcript?: { role: "user" | "assistant"; text: string; isFinal?: boolean };
  mode?: "listening" | "speaking";
} | null {
  const type = textOf(event.type);
  switch (type) {
    case "conversation.item.input_audio_transcription.completed": {
      const text = textOf(event.transcript).trim();
      return text ? { transcript: { role: "user", text, isFinal: true } } : null;
    }
    case "conversation.item.input_audio_transcription.delta": {
      const text = textOf(event.delta).trim();
      return text ? { transcript: { role: "user", text, isFinal: false } } : null;
    }
    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta": {
      const delta = textOf(event.delta);
      if (!delta) return null;
      assistant.text += delta;
      return { transcript: { role: "assistant", text: assistant.text, isFinal: false } };
    }
    case "response.audio_transcript.done":
    case "response.output_audio_transcript.done": {
      const text = (textOf(event.transcript) || assistant.text).trim();
      assistant.text = "";
      return text ? { transcript: { role: "assistant", text, isFinal: true } } : null;
    }
    case "input_audio_buffer.speech_started":
      return { mode: "listening" };
    case "response.created":
      assistant.text = "";
      return { mode: "speaking" };
    case "output_audio_buffer.started":
      return { mode: "speaking" };
    case "response.done":
    case "output_audio_buffer.stopped":
    case "input_audio_buffer.speech_stopped":
      return { mode: "listening" };
    default:
      return null;
  }
}

export function createRealtimeAdapter(options: RealtimeAdapterOptions): RealtimeVoiceAdapter {
  return {
    connect(connectOptions) {
      return createVoiceSession(connectOptions, async (session) => {
        if (typeof RTCPeerConnection === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser has no WebRTC or microphone support.");
        }
        const abort = new AbortController();
        let closed = false;
        let assistant = { text: "" };
        let stream: MediaStream | undefined;
        let audio: HTMLAudioElement | undefined;
        let meterContext: AudioContext | undefined;
        let volumeTimer: ReturnType<typeof setInterval> | undefined;
        let setupTimer: ReturnType<typeof setTimeout> | undefined;

        const peer = new RTCPeerConnection();
        const channel = peer.createDataChannel("oai-events");
        const cleanup = () => {
          if (closed) return;
          closed = true;
          abort.abort();
          if (volumeTimer) clearInterval(volumeTimer);
          if (setupTimer) clearTimeout(setupTimer);
          void meterContext?.close().catch(() => {});
          channel.onopen = channel.onmessage = channel.onclose = channel.onerror = null;
          peer.ontrack = peer.onconnectionstatechange = null;
          stream?.getTracks().forEach((track) => track.stop());
          audio?.pause();
          if (audio) {
            audio.srcObject = null;
            audio.remove();
          }
          try {
            channel.close();
          } catch {}
          peer.close();
        };
        const fail = (reason: string) => {
          if (closed) return;
          session.end("error", new Error(reason));
          options.onFailure?.(reason);
          cleanup();
        };

        // A permission prompt that never resolves must not leave a "Listening" screen with no audio.
        setupTimer = setTimeout(() => fail("The Realtime session did not start in time."), 30_000);

        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          if (session.isDisposed()) {
            stream.getTracks().forEach((track) => track.stop());
            throw new Error("The call ended while the microphone opened.");
          }
          for (const track of stream.getAudioTracks()) peer.addTrack(track, stream!);

          audio = document.createElement("audio");
          audio.autoplay = true;
          audio.setAttribute("playsinline", "");
          audio.style.display = "none";
          document.body.append(audio);
          peer.ontrack = (event) => {
            const remote = event.streams[0] ?? new MediaStream([event.track]);
            audio!.srcObject = remote;
            void audio!.play().catch(() => {});
            // A compact meter from the assistant's own audio.
            try {
              const context = new AudioContext();
              meterContext = context;
              const analyser = context.createAnalyser();
              analyser.fftSize = 512;
              context.createMediaStreamSource(remote).connect(analyser);
              const samples = new Float32Array(analyser.fftSize);
              volumeTimer = setInterval(() => {
                analyser.getFloatTimeDomainData(samples);
                let sum = 0;
                for (const value of samples) sum += value * value;
                const db = 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8);
                session.emitVolume(Math.min(1, Math.max(0, (db + 60) / 45)));
              }, 120);
            } catch {
              // An analyser is decoration; the call works without it.
            }
          };
          peer.onconnectionstatechange = () => {
            if (peer.connectionState === "failed" || peer.connectionState === "closed") fail("The WebRTC connection was lost.");
            else if (peer.connectionState === "disconnected" && !session.isDisposed()) fail("The WebRTC connection dropped.");
          };

          channel.onmessage = (event) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(String(event.data));
            } catch {
              return;
            }
            if (!parsed || typeof parsed !== "object") return;
            const read = readRealtimeEvent(parsed as EventRecord, assistant);
            if (read?.transcript) session.emitTranscript(read.transcript);
            if (read?.mode) session.emitMode(read.mode);
          };
          channel.onclose = () => {
            if (!session.isDisposed()) fail("The Realtime data channel closed.");
          };

          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          const sdp = await options.exchangeSdp(peer.localDescription?.sdp ?? offer.sdp ?? "", abort.signal);
          if (closed || session.isDisposed()) return { disconnect: cleanup, mute: () => {}, unmute: () => {} };
          await peer.setRemoteDescription({ type: "answer", sdp });
          if (setupTimer) clearTimeout(setupTimer);
          session.setStatus({ type: "running" });
          session.emitMode("listening");
        } catch (error) {
          const reason = error instanceof Error ? error.message : "The Realtime session could not start.";
          fail(reason);
          throw error;
        }

        return {
          disconnect: cleanup,
          mute: () => stream?.getAudioTracks().forEach((track) => (track.enabled = false)),
          unmute: () => stream?.getAudioTracks().forEach((track) => (track.enabled = true)),
        };
      });
    },
  };
}
