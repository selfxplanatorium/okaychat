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
  autoSave: boolean;
}

export interface MemorySnapshot {
  preferences: MemoryPreferences;
  entries: MemoryEntry[];
}

export interface MemoryImportCandidate {
  content: string;
  scope?: string | null;
}

export interface MemoryImportPreview {
  entries: MemoryImportCandidate[];
  warnings: string[];
}
