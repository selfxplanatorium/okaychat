export type MemorySource = "manual" | "conversation" | "claude" | "chatgpt" | "okaychat";
export type MemoryImportSource = Exclude<MemorySource, "conversation">;

export interface MemoryEntry {
  id: string;
  content: string;
  source: MemorySource;
  /** null for account memory, otherwise an owned project id. */
  scope: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryPreferences {
  enabled: boolean;
  /** In-chat saving without approval, and background review of finished chats. */
  autoSave: boolean;
  /** conversation_search / conversation_read over earlier chats in the same scope. */
  chatSearch: boolean;
}

/** The synthesized view of one scope's facts that every chat in that scope starts with. */
export interface MemorySummary {
  scope: string | null;
  /** null while it is being rewritten after a change, or before the first summary exists. */
  content: string | null;
  updatedAt: number | null;
  /** Facts changed since it was written; a rewrite is pending. */
  stale: boolean;
  error: string | null;
}

export interface MemorySnapshot {
  preferences: MemoryPreferences;
  entries: MemoryEntry[];
  summaries: MemorySummary[];
}

export interface MemoryImportCandidate {
  content: string;
  scope?: string | null;
}

export interface MemoryImportPreview {
  entries: MemoryImportCandidate[];
  warnings: string[];
}
