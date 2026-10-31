/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import type { useAui } from "@assistant-ui/react";
import type { CallEngine } from "@shared/voice";
import type { CallControllerDeps, VoiceLink } from "./controller";
import type { VoiceConnectionEvents } from "./connection";
import type { CallMicrophone, CallPlayer } from "./media";

// The controller pulls in the web data store, which reads localStorage at module load. Node has no DOM, so a
// tiny in-memory shim stands in before importing it.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const { CallController } = await import("./controller");
const { useThreadSyncStore } = await import("@/state/thread-sync");
const { initialCallState } = await import("./state");
const { useCall } = await import("./store");

type Aui = ReturnType<typeof useAui>;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeMessage {
  id: string;
  role: string;
  content: unknown[];
  status?: { type: string };
}

class FakeThread {
  state = {
    messages: [] as FakeMessage[],
    isRunning: false,
    isLoading: false,
    capabilities: {},
    speech: undefined as unknown,
    voice: undefined as unknown,
  };
  appends: Array<{ role?: string; content: unknown[] }> = [];
  cancels = 0;
  stopSpeakingCount = 0;
  voiceConnects = 0;
  voiceDisconnects = 0;
  private next = 0;

  getState() {
    return this.state;
  }

  append(message: { role?: string; content: unknown[] }) {
    this.appends.push(message);
    this.state.messages = [
      ...this.state.messages,
      { id: `m${++this.next}`, role: message.role ?? "user", content: message.content, status: { type: "running" } },
    ];
  }

  cancelRun() {
    this.cancels++;
    this.state.isRunning = false;
  }

  stopSpeaking() {
    this.stopSpeakingCount++;
  }

  subscribeVoiceVolume() {
    return () => {};
  }

  getVoiceVolume() {
    return 0;
  }

  connectVoice() {
    this.voiceConnects++;
  }

  disconnectVoice() {
    this.voiceDisconnects++;
  }

  muteVoice() {}
  unmuteVoice() {}
}

class FakeConnection implements VoiceLink {
  readonly events: VoiceConnectionEvents;
  readonly openGate = deferred();
  isOpen = false;
  aborted = false;
  closed = false;
  sent: unknown[] = [];
  audio: Int16Array[] = [];

  constructor(events: VoiceConnectionEvents) {
    this.events = events;
  }

  open() {
    return this.openGate.promise.then(() => {
      if (!this.closed && !this.aborted) this.isOpen = true;
    });
  }

  send(message: unknown) {
    this.sent.push(message);
  }

  sendAudio(pcm: Int16Array) {
    this.audio.push(pcm);
  }

  close() {
    this.closed = true;
    this.isOpen = false;
  }

  abort() {
    this.aborted = true;
    this.isOpen = false;
  }
}

class FakePlayer implements CallPlayer {
  onEmpty: (() => void) | null = null;
  onOverflow: (() => void) | null = null;
  readonly gate: ReturnType<typeof deferred> | null;
  pushed: Uint8Array[] = [];
  cancelled = 0;
  disposed = false;

  constructor(deferredOpen = false) {
    this.gate = deferredOpen ? deferred() : null;
  }

  ensure(_rate: number): Promise<void> {
    return this.gate ? this.gate.promise : Promise.resolve();
  }

  push(pcm: Uint8Array) {
    this.pushed.push(Uint8Array.from(pcm));
  }

  cancel() {
    this.cancelled++;
  }

  async dispose() {
    this.disposed = true;
  }

  empty() {
    this.onEmpty?.();
  }
}

class FakeMic implements CallMicrophone {
  readonly gate: ReturnType<typeof deferred> | null;
  stopped = 0;
  muted = false;
  onFrame: ((pcm: Int16Array) => void) | null = null;

  constructor(deferredOpen = false) {
    this.gate = deferredOpen ? deferred() : null;
  }

  async start(onFrame: (pcm: Int16Array) => void) {
    this.onFrame = onFrame;
    if (this.gate) await this.gate.promise;
  }

  mute(muted: boolean) {
    this.muted = muted;
  }

  async stop() {
    this.stopped++;
  }
}

interface Harness {
  aui: Aui;
  threads: Map<string, FakeThread>;
  connections: FakeConnection[];
  players: FakePlayer[];
  mics: FakeMic[];
  deps: CallControllerDeps;
  mainId: string;
  remoteId: string | undefined;
  dictation: unknown;
  initGate: ReturnType<typeof deferred> | null;
}

function harness(options: { player?: FakePlayer; mic?: FakeMic } = {}): Harness {
  const threads = new Map<string, FakeThread>([
    ["a", new FakeThread()],
    ["b", new FakeThread()],
  ]);
  const connections: FakeConnection[] = [];
  const players: FakePlayer[] = [];
  const mics: FakeMic[] = [];
  const self = {
    threads,
    connections,
    players,
    mics,
    mainId: "a",
    remoteId: "r-a",
    dictation: null,
    initGate: null,
    deps: {
      createConnection: (_threadId: string, _engine: CallEngine, events: VoiceConnectionEvents) => {
        const connection = new FakeConnection(events);
        connections.push(connection);
        return connection;
      },
      createPlayer: () => {
        const player = options.player ?? new FakePlayer();
        players.push(player);
        return player;
      },
      createMicrophone: () => {
        const microphone = options.mic ?? new FakeMic();
        mics.push(microphone);
        return microphone;
      },
    },
  } as unknown as Harness;
  const current = () => threads.get(self.mainId)!;
  const aui = {
    threadListItem: {
      getState: () => ({ id: self.mainId, remoteId: self.remoteId }),
      initialize: async () => {
        if (self.initGate) await self.initGate.promise;
        return { remoteId: self.remoteId ?? "r-new" };
      },
    },
    get thread() {
      const thread = current();
      return {
        getState: () => thread.getState(),
        subscribeVoiceVolume: () => () => {},
        getVoiceVolume: () => 0,
        connectVoice: () => thread.connectVoice(),
        disconnectVoice: () => thread.disconnectVoice(),
        muteVoice: () => thread.muteVoice(),
        unmuteVoice: () => thread.unmuteVoice(),
      };
    },
    threads: {
      __internal_getAssistantRuntime: () => ({
        threads: {
          getById: (id: string) => {
            const thread = threads.get(id);
            if (!thread) throw new Error("no such thread");
            return thread;
          },
        },
      }),
    },
    composer: () => ({ getState: () => ({ dictation: self.dictation, text: "" }) }),
    subscribe: () => () => {},
  } as unknown as Aui;
  self.aui = aui;
  return self;
}

function resetStore() {
  useThreadSyncStore.setState({ byId: {} });
  useCall.setState({
    open: true,
    preferred: "local",
    call: initialCallState("local"),
    level: 0,
    notice: null,
    availability: {
      local: true,
      realtime: false,
      worker: true,
      voice: "en_US-lessac-medium",
      maxSeconds: 1800,
      maxUtteranceSeconds: 60,
    },
    availabilityError: false,
  });
}

async function startCall(h: Harness, engine: CallEngine = "local") {
  const controller = new CallController(h.aui, h.deps);
  const opening = controller.start(engine);
  const connection = h.connections.at(-1);
  if (!connection) throw new Error("no connection was created");
  connection.openGate.resolve();
  await opening;
  return { controller, connection };
}

function ready(connection: FakeConnection) {
  connection.events.onMessage({
    t: "ready",
    engine: "local",
    voice: "en-US",
    maxSeconds: 1800,
    maxUtteranceSeconds: 60,
  });
}

const pcm = (samples: number[]) => new Uint8Array(Int16Array.from(samples).buffer);

test("audio and said wait for the worklet, then flush in order without losing the first sentence", async () => {
  resetStore();
  const player = new FakePlayer(true);
  const h = harness({ player });
  const { controller, connection } = await startCall(h);
  ready(connection);
  await tick();

  connection.events.onMessage({ t: "audio", id: 1, rate: 1000 });
  connection.events.onAudio(1, pcm([1, 2, 3, 4]));
  connection.events.onMessage({ t: "said", id: 1, ok: true });
  assert.equal(player.pushed.length, 0, "nothing is pushed before the worklet exists");

  player.gate!.resolve();
  await tick();
  await tick();
  assert.equal(player.pushed.length, 1);
  assert.deepEqual([...new Int16Array(player.pushed[0]!.buffer)], [1, 2, 3, 4]);

  // The sentence was completed while waiting, so a drained worklet returns the call to listening.
  player.empty();
  assert.equal(useCall.getState().call.phase, "listening");
  controller.dispose();
});

test("a player that cannot start ends the call with a visible error", async () => {
  resetStore();
  const player = new FakePlayer(true);
  const h = harness({ player });
  const { controller, connection } = await startCall(h);
  ready(connection);
  await tick();
  connection.events.onMessage({ t: "audio", id: 1, rate: 1000 });
  connection.events.onAudio(1, pcm([1, 2]));
  player.gate!.reject(new Error("no worklet"));
  await tick();
  await tick();
  assert.equal(useCall.getState().call.phase, "error");
  assert.equal(useCall.getState().call.failure?.code, "failed");
  assert.equal(connection.closed, true);
});

test("cancelling before the worklet opens cannot resurrect the queued audio", async () => {
  resetStore();
  const player = new FakePlayer(true);
  const h = harness({ player });
  const { controller, connection } = await startCall(h);
  ready(connection);
  await tick();
  connection.events.onMessage({ t: "audio", id: 1, rate: 1000 });
  connection.events.onAudio(1, pcm([1, 2, 3]));
  (controller as unknown as { cancelSpeech: () => void }).cancelSpeech();
  player.gate!.resolve();
  await tick();
  await tick();
  assert.equal(player.pushed.length, 0);
  controller.dispose();
});

test("a late initialize from an ended call cannot create or close the new call", async () => {
  resetStore();
  const h = harness();
  h.remoteId = undefined;
  h.initGate = deferred();
  const controller = new CallController(h.aui, h.deps);
  const first = controller.start("local");
  await tick();
  assert.equal(h.connections.length, 0);

  controller.end();
  h.remoteId = "r-a";
  h.initGate.resolve();
  await first;
  assert.equal(h.connections.length, 0, "the stale start must not connect");
  assert.equal(useCall.getState().call.phase, "ended");

  const second = controller.start("local");
  const connection = h.connections.at(-1)!;
  connection.openGate.resolve();
  await second;
  assert.equal(h.connections.length, 1);
  assert.equal(connection.aborted, false);
  controller.dispose();
});

test("an old socket that opens after end and retry is aborted, not adopted", async () => {
  resetStore();
  const h = harness();
  const controller = new CallController(h.aui, h.deps);
  const first = controller.start("local");
  const firstConnection = h.connections.at(-1)!;
  controller.end();
  const second = controller.start("local");
  const secondConnection = h.connections.at(-1)!;
  assert.notEqual(firstConnection, secondConnection);

  firstConnection.openGate.resolve();
  await first;
  assert.equal(firstConnection.aborted, true);
  assert.equal(secondConnection.aborted, false);
  assert.equal(secondConnection.closed, false);

  secondConnection.openGate.resolve();
  await second;
  assert.equal(useCall.getState().call.phase, "starting");
  controller.dispose();
});

test("an old socket that fails after a retry does not fail the new call", async () => {
  resetStore();
  const h = harness();
  const controller = new CallController(h.aui, h.deps);
  const first = controller.start("local");
  const firstConnection = h.connections.at(-1)!;
  controller.end();
  const second = controller.start("local");
  const secondConnection = h.connections.at(-1)!;
  secondConnection.openGate.resolve();
  await second;
  firstConnection.openGate.reject(new Error("old socket failed"));
  await first;
  await tick();
  assert.notEqual(useCall.getState().call.phase, "error");
  assert.equal(useCall.getState().call.phase, "starting");
  controller.dispose();
});

test("a microphone that arrives after end and retry is stopped and never becomes the live one", async () => {
  resetStore();
  const firstMic = new FakeMic(true);
  const secondMic = new FakeMic(true);
  let used = 0;
  const h = harness();
  h.deps.createMicrophone = () => (used++ === 0 ? firstMic : secondMic);
  const controller = new CallController(h.aui, h.deps);

  const first = controller.start("local");
  h.connections[0]!.openGate.resolve();
  await first;
  ready(h.connections[0]!);
  await tick();
  assert.equal(firstMic.stopped, 0);

  controller.end();
  const second = controller.start("local");
  h.connections[1]!.openGate.resolve();
  await second;
  ready(h.connections[1]!);
  await tick();

  firstMic.gate!.resolve();
  await tick();
  await tick();
  assert.equal(firstMic.stopped >= 1, true);
  assert.equal(secondMic.stopped, 0);

  secondMic.gate!.resolve();
  await tick();
  await tick();
  assert.equal(useCall.getState().call.phase, "listening");
  assert.equal(secondMic.muted, false);
  controller.dispose();
});

test("a mute chosen before the microphone opens is applied when it is ready", async () => {
  resetStore();
  const mic = new FakeMic(true);
  const h = harness({ mic });
  const { controller, connection } = await startCall(h);
  ready(connection);
  await tick();
  controller.setMuted(true);
  mic.gate!.resolve();
  await tick();
  await tick();
  assert.equal(mic.muted, true);
  controller.dispose();
});

test("ending a call cancels only its own run in the chat it started in", async () => {
  resetStore();
  const h = harness();
  const { controller, connection } = await startCall(h);
  ready(connection);
  await tick();

  const first = h.threads.get("a")!;
  (controller as unknown as { awaitingFinal: Set<number> }).awaitingFinal.add(1);
  (controller as unknown as { onFinal: (id: number, text: string) => void }).onFinal(1, "hello");
  first.state.isRunning = true;

  // Switching the open chat must not move the transcript or cancel the new chat's run.
  h.mainId = "b";
  const second = h.threads.get("b")!;
  second.state.isRunning = true;
  (controller as unknown as { awaitingFinal: Set<number> }).awaitingFinal.add(2);
  (controller as unknown as { onFinal: (id: number, text: string) => void }).onFinal(2, "still A");
  assert.equal(first.appends.length, 2);
  assert.equal(second.appends.length, 0);

  controller.end();
  assert.equal(first.cancels, 1);
  assert.equal(second.cancels, 0);
});

test("a call refuses to start while the chat runs, loads cached history, or dictates", async () => {
  resetStore();
  const h = harness();
  h.threads.get("a")!.state.isRunning = true;
  const busy = new CallController(h.aui, h.deps);
  await busy.start("local");
  assert.equal(h.connections.length, 0);
  assert.equal(useCall.getState().call.failure?.code, "chatBusy");
  busy.dispose();

  resetStore();
  useThreadSyncStore.setState({ byId: { "r-a": "pending" } });
  const loading = new CallController(h.aui, h.deps);
  await loading.start("local");
  assert.equal(h.connections.length, 0);
  assert.equal(useCall.getState().call.failure?.code, "chatLoading");
  loading.dispose();

  resetStore();
  h.threads.get("a")!.state.isRunning = false;
  h.dictation = { active: true };
  const dictating = new CallController(h.aui, h.deps);
  await dictating.start("local");
  assert.equal(h.connections.length, 0);
  assert.equal(useCall.getState().call.failure?.code, "chatBusy");
  dictating.dispose();
});


test("Realtime cleanup after a chat switch disconnects only the owning thread", async () => {
  resetStore();
  const h = harness();
  const { controller, connection } = await startCall(h, "realtime");
  connection.events.onMessage({ t: "ready", engine: "realtime", voice: "marin", maxSeconds: 1800, maxUtteranceSeconds: 60 });
  assert.equal(h.threads.get("a")!.voiceConnects, 1);
  h.mainId = "b";
  controller.end();
  assert.equal(h.threads.get("a")!.voiceDisconnects, 1);
  assert.equal(h.threads.get("b")!.voiceDisconnects, 0);
  controller.dispose();
});


test("several sentences received before playback opens drain without blocking each other", async () => {
  resetStore();
  const player = new FakePlayer(true);
  const h = harness({ player });
  const { controller, connection } = await startCall(h);
  ready(connection);
  await tick();
  for (const id of [1, 2, 3]) {
    connection.events.onMessage({ t: "audio", id, rate: 22050 });
    connection.events.onAudio(id, pcm([id, id]));
    connection.events.onMessage({ t: "said", id, ok: true });
  }
  player.gate!.resolve();
  await tick();
  assert.deepEqual(player.pushed.map((bytes) => [...new Int16Array(bytes.buffer)]), [[1, 1], [2, 2], [3, 3]]);
  controller.dispose();
});
