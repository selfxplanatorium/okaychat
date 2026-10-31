import type { EmailDraft, EmailDraftFields } from "@shared/email-draft";
import type { EmailAccount } from "@shared/email";

// Client-side autosave for the inline email draft card. The server record stays authoritative: every
// write is compare-and-set on its revision, a response never replaces newer local text, and a
// conflict keeps the user's version until they explicitly retry against the latest revision. A small
// scoped outbox keeps unsaved keystrokes across a reload, keyed by account, chat, and draft, so it
// can never surface in another account's card.

export const DRAFT_AUTOSAVE_MS = 600;

export type DraftSaveStatus = "saved" | "pending" | "saving" | "conflict" | "offline" | "error";

export interface DraftSaveSnapshot {
  draft: EmailDraft;
  fields: EmailDraftFields;
  revision: number;
  status: DraftSaveStatus;
  dirty: boolean;
  error: string | null;
}

export interface DraftOutboxEntry {
  revision: number;
  fields: EmailDraftFields;
  savedAt: number;
}

export interface DraftOutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const draftOutboxKey = (userId: string, threadId: string, draftId: string) =>
  `okaychat:email-draft:${userId}:${threadId}:${draftId}`;

const browserStorage = (): DraftOutboxStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const isFields = (value: unknown): value is EmailDraftFields => {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Partial<EmailDraftFields>;
  const list = (entry: unknown) => Array.isArray(entry) && entry.every((item) => typeof item === "string");
  return (fields.accountId === null || typeof fields.accountId === "string")
    && (fields.inReplyTo === null || typeof fields.inReplyTo === "string")
    && list(fields.to) && list(fields.cc) && list(fields.bcc)
    && typeof fields.subject === "string" && typeof fields.body === "string";
};

export function readOutbox(storage: DraftOutboxStorage | null, key: string): DraftOutboxEntry | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftOutboxEntry>;
    if (typeof parsed.revision !== "number" || !isFields(parsed.fields)) return null;
    return parsed as DraftOutboxEntry;
  } catch {
    return null;
  }
}

export function writeOutbox(storage: DraftOutboxStorage | null, key: string, entry: DraftOutboxEntry): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(entry));
  } catch {
    // A full or private-mode store must not break saving to the server.
  }
}

export function clearOutbox(storage: DraftOutboxStorage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Same as above.
  }
}

export const draftWordCount = (text: string): number => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
};

export type DraftCardState = "loading" | "discarded" | "sent" | "saving" | "account-missing" | "no-account" | "draft";

/** The visible card state, derived from the server record and the live account list. */
export function deriveDraftCardState(input: {
  loading: boolean;
  discarded: boolean;
  draft: EmailDraft | null;
  accounts: EmailAccount[];
  autosave: DraftSaveStatus;
}): DraftCardState {
  if (input.loading && !input.draft) return "loading";
  if (input.discarded) return "discarded";
  if (!input.draft) return "loading";
  if (input.draft.status === "sent") return "sent";
  if (input.draft.accountMissing) return "account-missing";
  if (!input.accounts.length) return "no-account";
  if (input.autosave === "saving" || input.autosave === "pending") return "saving";
  return "draft";
}

const errorStatus = (error: unknown): number => {
  if (typeof error !== "object" || !error) return -1;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : -1;
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export interface DraftAutosaveOptions {
  save: (input: { revision: number; fields: EmailDraftFields; signal: AbortSignal }) => Promise<EmailDraft>;
  fetchLatest: (input: { signal: AbortSignal }) => Promise<EmailDraft>;
  storage?: DraftOutboxStorage | null;
  key: string;
  delay?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * Debounced, revision-checked saves for one card. Callers subscribe for re-renders; `flush()` awaits
 * the newest acknowledged revision and is what Send calls before asking the server to review.
 */
export class DraftAutosave {
  private draft: EmailDraft;
  private fields: EmailDraftFields;
  private revision: number;
  private status: DraftSaveStatus = "saved";
  private dirty = false;
  private error: string | null = null;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private flushAgain = false;
  private controller: AbortController | null = null;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly storage: DraftOutboxStorage | null;
  private readonly delay: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(initial: EmailDraft, private readonly options: DraftAutosaveOptions) {
    this.draft = initial;
    this.fields = fieldsOf(initial);
    this.revision = initial.revision;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.delay = options.delay ?? DRAFT_AUTOSAVE_MS;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): DraftSaveSnapshot => ({
    draft: this.draft,
    fields: this.fields,
    revision: this.revision,
    status: this.status,
    dirty: this.dirty,
    error: this.error,
  });

  /**
   * Applies the server record. A reload keeps unsaved text and flags a conflict if its base
   * revision differs; `preserveLocal` is for a model write that lands while the user is typing, where the
   * newer revision must not destroy the local text (the card settles it as a pending save).
   */
  applyServer(draft: EmailDraft, options: { preserveLocal?: boolean } = {}): void {
    if (this.disposed) return;
    if (draft.status !== "draft") {
      // A sent or in-flight record is read-only; never resurrect local text over it.
      this.draft = draft;
      this.revision = draft.revision;
      this.fields = fieldsOf(draft);
      this.dirty = false;
      this.error = null;
      this.status = "saved";
      clearOutbox(this.storage, this.options.key);
      this.emit();
      return;
    }
    if (options.preserveLocal && this.dirty) {
      this.draft = draft;
      this.revision = draft.revision;
      this.error = null;
      this.status = "pending";
      writeOutbox(this.storage, this.options.key, { revision: this.revision, fields: this.fields, savedAt: this.now() });
      this.schedule();
      this.emit();
      return;
    }
    const outbox = readOutbox(this.storage, this.options.key);
    this.draft = draft;
    this.error = null;
    if (outbox && JSON.stringify(outbox.fields) !== JSON.stringify(fieldsOf(draft))) {
      this.fields = outbox.fields;
      this.dirty = true;
      if (outbox.revision === draft.revision) {
        this.revision = draft.revision;
        this.status = "pending";
        this.schedule();
      } else {
        // The text was written against outbox.revision. Keep that as the compare-and-set base so no
        // save can overwrite the other writer until retry() or reload() resolves the conflict.
        this.revision = outbox.revision;
        this.status = "conflict";
        this.clearPendingTimer();
      }
    } else {
      this.revision = draft.revision;
      this.fields = fieldsOf(draft);
      this.dirty = false;
      this.status = "saved";
      clearOutbox(this.storage, this.options.key);
    }
    this.emit();
  }

  /** Adopts a newer server revision after an explicit "reload latest", discarding local text. */
  adoptLatest(draft: EmailDraft): void {
    this.clearPendingTimer();
    clearOutbox(this.storage, this.options.key);
    this.draft = draft;
    this.revision = draft.revision;
    this.fields = fieldsOf(draft);
    this.dirty = false;
    this.error = null;
    this.status = "saved";
    this.emit();
  }

  update(patch: Partial<EmailDraftFields>): void {
    if (this.disposed) return;
    this.fields = { ...this.fields, ...patch };
    this.dirty = true;
    this.error = null;
    writeOutbox(this.storage, this.options.key, { revision: this.revision, fields: this.fields, savedAt: this.now() });
    // A conflict stays until retry() or reload() decides; keystrokes only extend the local text.
    if (this.status !== "conflict") {
      this.status = "pending";
      this.schedule();
    }
    this.emit();
  }

  markSent(draft: EmailDraft): void {
    this.draft = draft;
    this.revision = draft.revision;
    this.fields = fieldsOf(draft);
    this.dirty = false;
    this.error = null;
    this.status = "saved";
    clearOutbox(this.storage, this.options.key);
    this.emit();
  }

  setFailure(message: string): void {
    this.error = message;
    this.emit();
  }

  /** Sends the newest text now. Resolves after every queued edit at least started its save. */
  async flush(): Promise<void> {
    this.clearPendingTimer();
    if (this.disposed) return;
    if (this.inFlight) {
      this.flushAgain = true;
      return this.inFlight;
    }
    if (!this.dirty || this.status === "conflict") return;
    this.dirty = false;
    this.status = "saving";
    this.error = null;
    this.emit();
    const fields = this.fields;
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    const run = (async () => {
      try {
        const saved = await this.options.save({ revision, fields, signal: controller.signal });
        if (this.disposed) return;
        if (saved.revision < this.revision) {
          // A newer model write won the race after this request left. Keep it instead of moving back.
          this.status = this.dirty ? "pending" : "saved";
          if (this.dirty) writeOutbox(this.storage, this.options.key, { revision: this.revision, fields: this.fields, savedAt: this.now() });
          return;
        }
        this.draft = saved;
        this.revision = saved.revision;
        if (this.dirty) {
          // Text typed while this request was in flight is newer than the acknowledgement.
          this.status = "pending";
          writeOutbox(this.storage, this.options.key, { revision: this.revision, fields: this.fields, savedAt: this.now() });
        } else {
          this.fields = fieldsOf(saved);
          this.status = "saved";
          clearOutbox(this.storage, this.options.key);
        }
      } catch (error) {
        if (this.disposed || controller.signal.aborted) return;
        this.dirty = true;
        const status = errorStatus(error);
        this.status = status === 409 ? "conflict" : status === 0 ? "offline" : "error";
        this.error = errorMessage(error, "The draft could not be saved.");
        writeOutbox(this.storage, this.options.key, { revision: this.revision, fields: this.fields, savedAt: this.now() });
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    })();
    this.inFlight = run;
    await run;
    this.inFlight = null;
    if (this.disposed) return;
    this.emit();
    if (this.flushAgain) {
      this.flushAgain = false;
      if (this.dirty) await this.flush();
    } else if (this.dirty && (this.status as DraftSaveStatus) === "pending") {
      this.schedule();
    }
  }

  /** Manual retry: a conflict first adopts the latest revision, keeping the user's text. */
  async retry(): Promise<void> {
    if (this.disposed) return;
    if (this.status === "conflict") {
      const controller = new AbortController();
      this.controller?.abort();
      this.controller = controller;
      try {
        const latest = await this.options.fetchLatest({ signal: controller.signal });
        if (this.disposed) return;
        this.draft = latest;
        this.revision = latest.revision;
        this.dirty = true;
        this.status = "pending";
      } catch (error) {
        if (this.disposed) return;
        const status = errorStatus(error);
        this.status = status === 0 ? "offline" : "error";
        this.error = errorMessage(error, "The latest draft could not be loaded.");
        this.emit();
        return;
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    }
    this.dirty = true;
    await this.flush();
  }

  /** Explicit "reload latest": adopts the server revision and discards local text. */
  async reload(): Promise<void> {
    const controller = new AbortController();
    this.controller?.abort();
    this.controller = controller;
    try {
      const latest = await this.options.fetchLatest({ signal: controller.signal });
      if (!this.disposed) this.adoptLatest(latest);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /** A deleted card must not leave text that a future mount could restore. */
  forget(): void {
    clearOutbox(this.storage, this.options.key);
    this.dirty = false;
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.clearPendingTimer();
    this.controller?.abort();
    this.controller = null;
    this.listeners.clear();
  }

  private schedule(): void {
    this.clearPendingTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  private clearPendingTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const fieldsOf = (draft: EmailDraft): EmailDraftFields => ({
  accountId: draft.accountId,
  to: [...draft.to],
  cc: [...draft.cc],
  bcc: [...draft.bcc],
  subject: draft.subject,
  body: draft.body,
  inReplyTo: draft.inReplyTo,
});
