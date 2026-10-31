/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMessage } from "../../shared/voice.js";
import type { CallBackends, LocalSpeech } from "./backend.js";

process.env.OKAYCHAT_SECRET ??= "voice-session-test-secret-0123456789";
const { CallFailure } = await import("./backend.js");
const { callLimits, StartLimiter } = await import("./limits.js");
const { CallRegistry, CallSession } = await import("./session.js");
type CallLimits = import("./limits.js").CallLimits;
type CallDeps = import("./session.js").CallDeps;

// Deterministic local speech: no worker, no model, no audio device.
function fakeSpeech(overrides: Partial<LocalSpeech> = {}): LocalSpeech {
  return {
    voice: "en_US-lessac-medium",
    warm: async () => {},
    transcribe: async () => "hello there",
    speak: async () => ({ pcm: new Uint8Array(200), rate: 22_050 }),
    ...overrides,
  };
}

const backends = (speech: LocalSpeech | null = fakeSpeech()) => {
  const released: number[] = [];
  const value: CallBackends = {
    local: () => (speech ? { ok: true, value: speech } : { ok: false, code: "unavailable", detail: "No speech worker." }),
    realtime: () => ({ ok: false, code: "unavailable", detail: "No OpenAI key." }),
    released: () => released.push(Date.now()),
  };
  return { value, released };
};

class Socket {
  messages: ServerMessage[] = [];
  frames: Uint8Array[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;
  send(data: string | Uint8Array) {
    if (typeof data === "string") this.messages.push(JSON.parse(data) as ServerMessage);
    else this.frames.push(data);
  }
  close(code: number, reason: string) {
    this.closes.push({ code, reason });
  }
  of<T extends ServerMessage["t"]>(type: T) {
    return this.messages.filter((message): message is Extract<ServerMessage, { t: T }> => message.t === type);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function make(overrides: { speech?: LocalSpeech | null; limits?: Partial<CallLimits>; threadOwned?: boolean; now?: () => number; signedIn?: () => boolean } = {}) {
  const socket = new Socket();
  const b = backends(overrides.speech);
  const registry = new CallRegistry();
  const usage: Array<{ engine: string; sttSeconds: number; ttsChars: number }> = [];
  const deps: CallDeps = {
    backends: b.value,
    limits: { ...callLimits(), startSeconds: 5, ...overrides.limits },
    registry,
    starts: new StartLimiter(10, 60_000),
    threadOwned: () => overrides.threadOwned ?? true,
    stillSignedIn: overrides.signedIn ?? (() => true),
    maxRecordingSeconds: () => 600,
    onUsage: (entry) => usage.push(entry),
    ...(overrides.now ? { now: overrides.now } : {}),
  };
  const session = new CallSession("alice", socket, deps);
  return { session, socket, deps, registry, usage, released: b.released };
}

test("local start prepares, warms, and becomes ready with the voice", async () => {
  const { session, socket } = make();
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  assert.deepEqual(socket.of("preparing").length, 1);
  const ready = socket.of("ready").at(-1)!;
  assert.equal(ready.engine, "local");
  assert.equal(ready.voice, "en_US-lessac-medium");
  session.onClose();
});

test("a foreign or missing chat is refused before anything is registered", async () => {
  const { session, socket, registry } = make({ threadOwned: false });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_other", engine: "local" }));
  assert.equal(socket.of("error").at(-1)?.code, "thread");
  assert.equal(session.ended, true);
  assert.equal(registry.size, 0);
});

test("one call per account is enforced, and takeover replaces the older call", async () => {
  const first = make();
  first.session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();

  const second = make();
  second.deps.registry = first.deps.registry;
  const blocked = new CallSession("alice", second.socket, { ...second.deps, registry: first.deps.registry });
  blocked.onMessage(JSON.stringify({ t: "start", threadId: "thr_2", engine: "local" }));
  assert.equal(second.socket.of("error").at(-1)?.code, "busy");
  assert.equal(blocked.ended, true);
  assert.equal(first.session.ended, false);

  const third = make();
  const takeover = new CallSession("alice", third.socket, { ...third.deps, registry: first.deps.registry });
  takeover.onMessage(JSON.stringify({ t: "start", threadId: "thr_3", engine: "local", takeover: true }));
  assert.equal(first.session.ended, true);
  assert.equal(first.socket.of("ended").at(-1)?.reason, "replaced");
  await tick();
  await tick();
  assert.equal(third.socket.of("ready").at(-1)?.engine, "local");
  takeover.onClose();
  // These two helpers only supplied deps; close their waiting sessions so their start timers do not linger.
  second.session.onClose();
  third.session.onClose();
});

test("utterance audio becomes a partial and then a final transcript", async () => {
  const transcribe: LocalSpeech["transcribe"] = async (_pcm, partial) => (partial ? "hello" : "hello there");
  const { session, socket } = make({ speech: fakeSpeech({ transcribe }) });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();

  session.onMessage(JSON.stringify({ t: "utt.start", id: 3 }));
  session.onMessage(new Uint8Array(16_000));
  session.onMessage(new Uint8Array(16_000));
  await tick();
  assert.equal(socket.of("partial").at(-1)?.text, "hello");
  session.onMessage(JSON.stringify({ t: "utt.end", id: 3 }));
  await tick();
  assert.equal(socket.of("final").at(-1)?.text, "hello there");
  session.onClose();
});

test("a short noise is not sent to speech recognition", async () => {
  let calls = 0;
  const { session, socket } = make({ speech: fakeSpeech({ transcribe: async () => (calls++, "never") }) });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage(JSON.stringify({ t: "utt.start", id: 1 }));
  session.onMessage(new Uint8Array(100));
  session.onMessage(JSON.stringify({ t: "utt.end", id: 1 }));
  await tick();
  assert.equal(calls, 0);
  assert.equal(socket.of("final").at(-1)?.text, "");
  session.onClose();
});

test("speech synthesis streams one sentence at a time, then reports it", async () => {
  const { session, socket } = make();
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage(JSON.stringify({ t: "say", id: 7, text: "Hello." }));
  await tick();
  assert.equal(socket.of("audio").at(-1)?.id, 7);
  assert.equal(socket.frames.length > 0, true);
  assert.deepEqual(socket.of("said").at(-1), { t: "said", id: 7, ok: true });
  // Every binary frame carries the sentence id in its first four bytes.
  assert.equal(new DataView(socket.frames[0]!.buffer, socket.frames[0]!.byteOffset).getUint32(0, true), 7);
  session.onClose();
});

test("a full speech queue answers every sentence id instead of leaving the client waiting", async () => {
  const { session, socket } = make({ limits: { maxQueue: 0 } });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage(JSON.stringify({ t: "say", id: 9, text: "Hello." }));
  await tick();
  assert.equal(socket.of("error").at(-1)?.code, "limit");
  assert.deepEqual(socket.of("said").at(-1), { t: "said", id: 9, ok: false });
  assert.equal(session.ended, false);
  session.onClose();
});

test("barge-in drops queued and running sentences without reporting them as spoken", async () => {
  const pending: AbortSignal[] = [];
  const speak: LocalSpeech["speak"] = (text, signal) => {
    pending.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  const { session, socket } = make({ speech: fakeSpeech({ speak }) });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage(JSON.stringify({ t: "say", id: 1, text: "First." }));
  session.onMessage(JSON.stringify({ t: "say", id: 2, text: "Second." }));
  await tick();
  session.onMessage(JSON.stringify({ t: "say.cancel" }));
  await tick();
  assert.equal(pending[0]?.aborted, true);
  assert.equal(socket.of("said").length, 0);
  session.onClose();
});

test("a voice failure ends the sentence and reports a non-fatal error", async () => {
  const { session, socket } = make({ speech: fakeSpeech({ speak: async () => { throw new CallFailure("voice", "Piper is gone."); } }) });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage(JSON.stringify({ t: "say", id: 4, text: "Hello." }));
  await tick();
  assert.deepEqual(socket.of("said").at(-1), { t: "said", id: 4, ok: false });
  assert.equal(socket.of("error").at(-1)?.code, "voice");
  assert.equal(socket.of("error").at(-1)?.fatal, false);
  session.onClose();
});

test("malformed messages are rejected without ending the call, and binary audio is ignored before an utterance", async () => {
  const { session, socket } = make();
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage("not json");
  session.onMessage(JSON.stringify({ t: "nope" }));
  session.onMessage(new Uint8Array(128));
  assert.equal(socket.of("error").filter((error) => error.code === "protocol").length, 2);
  assert.equal(session.ended, false);
  session.onClose();
});

test("the input byte cap and the per-utterance cap both end safely", async () => {
  const capped = make({ limits: { maxInputBytes: 1000 } });
  capped.session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  capped.session.onMessage(JSON.stringify({ t: "utt.start", id: 1 }));
  capped.session.onMessage(new Uint8Array(2000));
  assert.equal(capped.socket.of("error").at(-1)?.code, "limit");
  assert.equal(capped.session.ended, true);

  const long = make({ limits: { maxUtteranceSeconds: 1 }, });
  long.session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  long.session.onMessage(JSON.stringify({ t: "utt.start", id: 2 }));
  // The hard floor is five seconds, whatever the admin's recording limit says.
  long.session.onMessage(new Uint8Array(5 * 32_000));
  await tick();
  assert.equal(long.socket.of("error").at(-1)?.code, "limit");
  assert.equal(long.socket.of("final").at(-1)?.id, 2);
  long.session.onClose();
});

test("the duration cap ends the call with a reason the client can show", async () => {
  const { session, socket } = make({ limits: { maxSeconds: 0.02 } });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(socket.of("ended").at(-1)?.reason, "duration");
  assert.equal(session.ended, true);
});

test("closing frees the registry, records counters once, and releases idle engines", async () => {
  const { session, socket, registry, usage, released } = make();
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage(JSON.stringify({ t: "say", id: 1, text: "Hello there." }));
  await tick();
  session.onClose();
  session.onClose();
  assert.equal(registry.size, 0);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.ttsChars, 12);
  assert.equal(usage[0]?.engine, "local");
  assert.equal(released.length, 1);
  assert.equal(socket.of("ended").length, 0);
});

test("ending by the user sends ended before closing, and a second end is a no-op", async () => {
  const { session, socket } = make();
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage(JSON.stringify({ t: "end" }));
  assert.equal(socket.of("ended").at(-1)?.reason, "user");
  session.end("user");
  assert.equal(socket.of("ended").length, 1);
});

test("no local engine is an error, never a silent call", async () => {
  const { session, socket } = make({ speech: null });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  assert.equal(socket.of("error").at(-1)?.code, "unavailable");
  assert.equal(socket.of("error").at(-1)?.fatal, true);
});

test("start is required first and cannot be repeated", async () => {
  const { session, socket } = make();
  session.onMessage(JSON.stringify({ t: "ping" }));
  assert.equal(socket.of("error").at(-1)?.code, "protocol");
  assert.equal(session.ended, true);

  const other = make();
  other.session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  other.session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  assert.equal(other.socket.of("error").at(-1)?.code, "protocol");
  other.session.onClose();
});

test("only one final transcription runs per call and refused starts are acknowledged", async () => {
  let finals = 0;
  let release: ((text: string) => void) | null = null;
  const transcribe: LocalSpeech["transcribe"] = (_pcm, partial) => {
    if (partial) return Promise.resolve(null);
    finals++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const { session, socket } = make({ speech: fakeSpeech({ transcribe }) });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();

  session.onMessage(JSON.stringify({ t: "utt.start", id: 1 }));
  session.onMessage(new Uint8Array(10_000));
  session.onMessage(JSON.stringify({ t: "utt.end", id: 1 }));
  await tick();
  assert.equal(finals, 1);

  // The client cannot start another utterance until the transcript answers; it must not hang waiting.
  for (const id of [2, 3]) {
    session.onMessage(JSON.stringify({ t: "utt.start", id }));
    session.onMessage(new Uint8Array(10_000));
    session.onMessage(JSON.stringify({ t: "utt.end", id }));
  }
  await tick();
  assert.equal(finals, 1);
  assert.deepEqual(socket.of("final").map((final) => [final.id, final.text]), [
    [2, ""],
    [3, ""],
  ]);
  assert.equal(socket.of("error").filter((error) => error.code === "protocol" && !error.fatal).length, 2);

  release?.("first answer");
  await tick();
  assert.deepEqual(socket.of("final").at(-1), { t: "final", id: 1, text: "first answer" });
  session.onClose();
});

test("replacing an utterance does not start a second partial job or keep the old buffer", async () => {
  let partialCalls = 0;
  const transcribe: LocalSpeech["transcribe"] = (_pcm, partial) => {
    if (!partial) return Promise.resolve("");
    partialCalls++;
    // A worker that never answers must not allow a second partial to pile up.
    return new Promise(() => {});
  };
  const { session, socket } = make({ speech: fakeSpeech({ transcribe }) });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();

  session.onMessage(JSON.stringify({ t: "utt.start", id: 1 }));
  session.onMessage(new Uint8Array(32_000));
  await tick();
  assert.equal(partialCalls, 1);

  session.onMessage(JSON.stringify({ t: "utt.start", id: 2 }));
  assert.deepEqual(socket.of("final").at(-1), { t: "final", id: 1, text: "" });
  session.onMessage(new Uint8Array(32_000));
  await tick();
  assert.equal(partialCalls, 1);
  assert.equal(socket.of("error").at(-1)?.code, "protocol");
  assert.equal(session.ended, false);
  session.onClose();
});

test("odd-sized audio frames are refused before buffering", async () => {
  const { session, socket } = make();
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage(JSON.stringify({ t: "utt.start", id: 4 }));
  session.onMessage(new Uint8Array(3));
  assert.equal(socket.of("error").at(-1)?.code, "protocol");
  assert.equal(socket.of("error").at(-1)?.fatal, false);
  session.onMessage(JSON.stringify({ t: "utt.end", id: 4 }));
  await tick();
  assert.deepEqual(socket.of("final").at(-1), { t: "final", id: 4, text: "" });
  session.onClose();
});

test("the watchdog ends a revoked session without any client ping", async () => {
  let now = 1_000_000;
  let signedIn = true;
  const { session, socket } = make({ now: () => now, signedIn: () => signedIn });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  assert.equal(socket.of("ready").length, 1);
  signedIn = false;
  now += 20_000;
  session.checkLimits();
  assert.equal(session.ended, true);
  assert.equal(socket.of("ended").at(-1)?.reason, "unauthorized");
});

test("the watchdog also covers preparing, revocation, and the preparation ceiling", async () => {
  const never = new Promise<void>(() => {});
  let now = 5_000_000;
  let signedIn = true;
  const stuck = make({ speech: fakeSpeech({ warm: () => never }), now: () => now, signedIn: () => signedIn });
  stuck.session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  assert.equal(stuck.socket.of("preparing").length, 1);
  // No ping and no message for the silent window: an abandoned warm must not hold the call.
  now += 46_000;
  stuck.session.checkLimits();
  assert.equal(stuck.session.ended, true);
  assert.equal(stuck.socket.of("ended").at(-1)?.reason, "failed");

  now = 6_000_000;
  signedIn = true;
  const revoked = make({ speech: fakeSpeech({ warm: () => never }), now: () => now, signedIn: () => signedIn });
  revoked.session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  signedIn = false;
  revoked.session.checkLimits();
  assert.equal(revoked.session.ended, true);
  assert.equal(revoked.socket.of("ended").at(-1)?.reason, "unauthorized");

  now = 7_000_000;
  const tooLong = make({ speech: fakeSpeech({ warm: () => never }), now: () => now, limits: { prepareSeconds: 10 } });
  tooLong.session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  now += 11_000;
  tooLong.session.checkLimits();
  assert.equal(tooLong.session.ended, true);
  assert.equal(tooLong.socket.of("error").at(-1)?.code, "worker");
});

test("a final that answers after the call ended is never sent", async () => {
  let release: ((text: string) => void) | null = null;
  const transcribe: LocalSpeech["transcribe"] = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const { session, socket } = make({ speech: fakeSpeech({ transcribe }) });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  session.onMessage(JSON.stringify({ t: "utt.start", id: 7 }));
  session.onMessage(new Uint8Array(10_000));
  session.onMessage(JSON.stringify({ t: "utt.end", id: 7 }));
  await tick();
  session.onClose();
  release?.("late answer");
  await tick();
  assert.equal(socket.of("final").length, 0);
});

test("the duration cap still applies with the constructor watchdog", async () => {
  let now = 9_000_000;
  const { session, socket } = make({ now: () => now, limits: { maxSeconds: 30 } });
  session.onMessage(JSON.stringify({ t: "start", threadId: "thr_1", engine: "local" }));
  await tick();
  await tick();
  now += 31_000;
  session.checkLimits();
  assert.equal(session.ended, true);
  assert.equal(socket.of("ended").at(-1)?.reason, "duration");
});
