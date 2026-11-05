import type { Note, NoteWrite } from "@shared/notes";

/**
 * Autosave controller for one note. Edits debounce, coalesce, and write one captured payload at a time;
 * only the acknowledgement for the newest edit clears dirty state. A conflict stops automatic writes and
 * keeps the local text. The controller is pure apart from injected `save`/scheduler callbacks, so the
 * race rules are testable without a browser.
 */

export type NoteSaveStatus = "loading" | "saved" | "dirty" | "saving" | "offline" | "conflict" | "error" | "forbidden" | "deleted";

export interface NoteAutosaveState {
  status: NoteSaveStatus;
  note: Note | null;
  value: NoteWrite;
  revision: number;
  /** The server version kept for a conflict comparison. */
  server: Note | null;
  localOnly: boolean;
}

export interface NoteAutosaveDeps {
  save: (value: NoteWrite, revision: number) => Promise<Note>;
  onChange?: (state: NoteAutosaveState) => void;
  schedule?: (run: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  online?: () => boolean;
}

export const AUTOSAVE_DEBOUNCE_MS = 600;

const writeOf = (note: Note): NoteWrite => ({
  title: note.title,
  body: note.body,
  favorite: note.favorite,
  pinned: note.pinned,
  tags: [...note.tags],
  projectId: note.projectId,
});

export class NoteAutosave {
  private value: NoteWrite;
  private revision: number;
  private server: Note;
  private sequence = 0;
  private ackedSequence = 0;
  private timer: unknown = null;
  private inFlight = false;
  private pendingFlush = false;
  private disposed = false;
  private status: NoteSaveStatus = "saved";

  constructor(
    initial: Note,
    private readonly deps: NoteAutosaveDeps,
  ) {
    this.server = initial;
    this.revision = initial.revision;
    this.value = writeOf(initial);
    this.sequence = 0;
  }

  state(): NoteAutosaveState {
    return {
      status: this.status,
      note: this.server,
      value: { ...this.value, tags: [...this.value.tags] },
      revision: this.revision,
      server: this.server,
      localOnly: false,
    };
  }

  private emit(): void {
    this.deps.onChange?.(this.state());
  }

  private setStatus(status: NoteSaveStatus): void {
    this.status = status;
    this.emit();
  }

  /** Applies a local edit. Every editable field shares one debounce and one CAS write. */
  edit(next: NoteWrite): void {
    if (this.disposed || this.status === "conflict" || this.status === "forbidden" || this.status === "deleted") return;
    this.value = { ...next, tags: [...next.tags] };
    this.sequence++;
    this.setStatus("dirty");
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) this.deps.cancel?.(this.timer);
    const schedule = this.deps.schedule ?? ((run, ms) => setTimeout(run, ms));
    this.timer = schedule(() => {
      this.timer = null;
      void this.flush();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Starts a write now. A second call while one is in flight is remembered, not parallel. */
  async flush(): Promise<void> {
    if (this.disposed || this.status === "conflict" || this.status === "forbidden" || this.status === "deleted") return;
    if (this.inFlight) {
      this.pendingFlush = true;
      return;
    }
    if (this.sequence === this.ackedSequence && this.status === "saved") return;
    if (this.timer !== null) {
      this.deps.cancel?.(this.timer);
      this.timer = null;
    }
    const capturedSequence = this.sequence;
    const capturedValue = { ...this.value, tags: [...this.value.tags] };
    const capturedRevision = this.revision;
    this.inFlight = true;
    this.setStatus("saving");
    try {
      const saved = await this.deps.save(capturedValue, capturedRevision);
      if (this.disposed) return;
      this.server = saved;
      this.revision = saved.revision;
      if (capturedSequence === this.sequence) {
        this.ackedSequence = capturedSequence;
        this.value = writeOf(saved);
        this.setStatus("saved");
      } else {
        // A newer keystroke arrived while saving; it stays dirty and is written next.
        this.setStatus("dirty");
        this.schedule();
      }
    } catch (error) {
      if (this.disposed) return;
      const status = (error as { status?: number }).status;
      if (status === 409) this.setStatus("conflict");
      else if (status === 404) this.setStatus("deleted");
      else if (status === 403) this.setStatus("forbidden");
      else if (this.deps.online?.() === false) this.setStatus("offline");
      else this.setStatus("error");
    } finally {
      this.inFlight = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        if (this.status === "dirty" || this.status === "offline" || this.status === "error") void this.flush();
      }
    }
  }

  /** Recover the actual local payload before comparing its base revision. */
  restore(value: NoteWrite, baseRevision: number): void {
    this.value = { ...value, tags: [...value.tags] };
    this.sequence++;
    if (baseRevision !== this.revision) this.setStatus("conflict");
    else {
      this.setStatus("dirty");
      this.schedule();
    }
  }

  /** Retry after an offline or server failure; never used for a conflict. */
  retry(): void {
    if (this.status !== "offline" && this.status !== "error") return;
    this.setStatus("dirty");
    void this.flush();
  }

  /** Replaces the local base with the server version (explicit Reload or a fresh GET). */
  adopt(note: Note): void {
    this.server = note;
    this.revision = note.revision;
    this.value = writeOf(note);
    this.sequence = 0;
    this.ackedSequence = 0;
    this.setStatus("saved");
  }

  /** Keep local text and a newer server revision, but stop automatic writes: the user resolves it. */
  conflictAgainst(note: Note): void {
    this.server = note;
    this.revision = note.revision;
    this.setStatus("conflict");
  }

  /** Keep local text but adopt a newly fetched server revision after the user chose that path. */
  keepLocalAgainst(note: Note): void {
    this.server = note;
    this.revision = note.revision;
    this.sequence++;
    this.ackedSequence = 0;
    this.setStatus("dirty");
    this.schedule();
  }

  isDirty(): boolean {
    return this.sequence !== this.ackedSequence || this.status === "dirty" || this.status === "saving" || this.status === "offline" || this.status === "error";
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.deps.cancel?.(this.timer);
    this.timer = null;
  }
}
