import type { AssistantIcon, KnowledgePolicy, SamplingSettings } from "./assistant-presets.js";
import type { FinishReason } from "./generation.js";
import type { TokenUsage } from "./types.js";

/**
 * Portable native conversation archives (`okaychat.zip`). A versioned JSON manifest plus one entry
 * per asset. The format is display-only: importing creates new chats and inert tool records; it never
 * recreates runnable tools, credentials, providers, or approvals.
 */

export const ARCHIVE_FORMAT = "okaychat.chat-archive";
export const ARCHIVE_VERSION = 1;

export const ARCHIVE_LIMITS = {
  /** Compressed HTTP upload. */
  uploadBytes: 128 * 1024 ** 2,
  /** Sum of every expanded entry, manifest included. */
  expandedBytes: 128 * 1024 ** 2,
  entryBytes: 50 * 1024 ** 2,
  manifestBytes: 16 * 1024 ** 2,
  entries: 2_001,
  assets: 2_000,
  chats: 100,
  messages: 10_000,
  partsPerMessage: 200,
  graphDepth: 10_000,
  jsonDepth: 40,
  stringBytes: 2 * 1024 ** 2,
  artifactVersions: 1_000,
  titleCodePoints: 200,
  fileNameCodePoints: 240,
  mimeChars: 100,
  keyChars: 100,
  jobLifetimeMs: 30 * 60_000,
  stagingTotalBytes: 512 * 1024 ** 2,
  stagingJobBytes: 256 * 1024 ** 2,
  validationMs: 60_000,
  preparationMs: 60_000,
  workers: 2,
  queued: 4,
} as const;

/** `asset` is the sha256 of the entry's bytes; artifacts keep an explicit asset reference. */
export type ArchiveAssetRef = string;

export type ArchivePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "file"; asset: ArchiveAssetRef | null; name: string; mime: string; missing: boolean }
  | { type: "source"; title: string; url: string }
  | {
      type: "tool-record";
      name: string;
      input: unknown;
      output: unknown;
      state: "completed" | "failed" | "interrupted";
      references: Array<{ kind: "asset" | "artifact"; key: string; version?: number }>;
    };

/** A display-only generation summary. Never trusted for Continue or usage totals. */
export interface ArchiveGeneration {
  modelRef?: string;
  assistantName?: string;
  assistantIcon?: AssistantIcon;
  usage?: TokenUsage;
  cost?: number;
  durationMs?: number;
  finishReason?: FinishReason;
}

export interface ArchiveMessage {
  key: string;
  parentKey: string | null;
  createdAt: number;
  role: "user" | "assistant";
  parts: ArchivePart[];
  generation?: ArchiveGeneration;
}

export interface ArchiveArtifact {
  key: string;
  version: number;
  title: string;
  kind: string;
  language: string | null;
  content: string;
  fileAsset: ArchiveAssetRef | null;
  createdAt: number;
}

/** Allowlisted preset fields; MCP and knowledge selections are intentionally omitted on export. */
export interface PortableAssistant {
  name: string;
  icon: AssistantIcon;
  instructions: string;
  modelRef: string | null;
  sampling: SamplingSettings;
  reasoningEffort?: string;
  builtins: string[];
  omittedTools: boolean;
  omittedKnowledge: boolean;
}

export interface ArchiveChat {
  key: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  status: "regular" | "archived";
  modelRef: string | null;
  selectedLeaf: string | null;
  messages: ArchiveMessage[];
  artifacts: ArchiveArtifact[];
  assistant: PortableAssistant | null;
}

export interface ArchiveAssetEntry {
  key: ArchiveAssetRef;
  size: number;
  mime: string;
  name: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  exportedAt: number;
  chats: ArchiveChat[];
  assets: ArchiveAssetEntry[];
}

/** Safe warning codes returned by export/import; the web maps each to one message key. */
export const ARCHIVE_WARNING_CODES = [
  "missingAsset",
  "unsupportedPart",
  "unsupportedFormat",
  "draftExcluded",
  "portableSettingsInactive",
  "embeddedLinks",
  "unknownModel",
  "mcpToolsOmitted",
  "knowledgeOmitted",
  "editedTextOnly",
  "attachmentMissing",
] as const;
export type ArchiveWarningCode = (typeof ARCHIVE_WARNING_CODES)[number];

export interface ArchiveWarning {
  code: ArchiveWarningCode;
  count?: number;
  name?: string;
  type?: string;
  model?: string;
}

export interface ArchiveChatSummary {
  key: string;
  title: string | null;
  messages: number;
  branches: number;
  assets: number;
  bytes: number;
  warnings: ArchiveWarning[];
}

export interface ArchiveSummary {
  chats: ArchiveChatSummary[];
  totalBytes: number;
  lossyConversions: number;
}

export type ArchiveJobKind = "import" | "export";
export type ArchiveJobState = "preparing" | "ready" | "committing" | "done" | "failed" | "cancelled";

export interface ArchiveJob {
  id: string;
  kind: ArchiveJobKind;
  state: ArchiveJobState;
  expiresAt: number;
  summary?: ArchiveSummary;
  error?: { code: string; message: string };
  result?: {
    threads: Array<{ archiveKey: string; id: string; title: string | null }>;
    warnings: ArchiveWarning[];
  };
}

/** Server-generated job identifiers are produced by `newId("arc")`; this is only the shape check. */
export const isArchiveKey = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);

export const isAssetHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Keys may not be hashes, so a chat/message key can never accidentally name an asset entry. */
export const isArchiveChatKey = isArchiveKey;

/** Manifest containers are bounded before validation descends into them. */
export function archiveWithinLimits(manifest: ArchiveManifest): string | null {
  if (manifest.chats.length > ARCHIVE_LIMITS.chats) return "This archive has too many chats.";
  if (manifest.assets.length > ARCHIVE_LIMITS.assets) return "This archive has too many files.";
  let messages = 0;
  let versions = 0;
  for (const chat of manifest.chats) {
    messages += chat.messages.length;
    versions += chat.artifacts.length;
    if ((chat.title?.length ?? 0) > ARCHIVE_LIMITS.titleCodePoints * 2) return "A chat title is too long.";
    for (const message of chat.messages) {
      if (message.parts.length > ARCHIVE_LIMITS.partsPerMessage) return "A message has too many parts.";
    }
  }
  if (messages > ARCHIVE_LIMITS.messages) return "This archive has too many messages.";
  if (versions > ARCHIVE_LIMITS.artifactVersions) return "This archive has too many artifact versions.";
  return null;
}

/** Settings printed in the export review: what is private and what deliberately does not travel. */
export const ARCHIVE_PRIVATE_DATA_NOTE =
  "Archives contain private conversation text, reasoning, and historical tool inputs and results in plain text. They exclude credentials, account and project memory, private bookmarks and feedback, unsent drafts, schedules, and share links.";
