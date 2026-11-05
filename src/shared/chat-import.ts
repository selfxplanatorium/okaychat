/** Text-only conversation transfer. Independent of the native ZIP archive contract. */
export const IMPORT_LIMITS = {
  inputBytes: 32 * 1024 * 1024, jsonDepth: 40, stringBytes: 1024 * 1024,
  tokens: 1_000_000, objectMembers: 50_000, conversations: 1000, totalNodes: 50_000,
  nodesPerConversation: 5000, messageBytes: 256 * 1024, conversationBytes: 2 * 1024 * 1024,
  parts: 100, stagingBytes: 48 * 1024 * 1024, reservationBytes: 80 * 1024 * 1024,
  workerTimeoutMs: 60_000, lifetimeMs: 86_400_000, identityBytes: 2048,
} as const;
export type SourceNamespace = 'mapping-v1' | 'portable-v1';
export type WarningCode = 'branches_omitted' | 'roles_quarantined' | 'attachments_missing' | 'html_removed' | 'links_removed' | 'timestamps_inferred' | 'title_shortened' | 'label_shortened' | 'controls_removed' | 'unknown_fields' | 'unsupported_content' | 'reasoning_omitted' | 'source_changed' | 'model_unavailable' | 'model_unset' | 'export_loss';
export type ImportWarning = { code: WarningCode; count: number };
export type MissingKind = 'image' | 'file' | 'audio' | 'video' | 'unknown';
export type PortablePart = { type: 'text'; text: string } | { type: 'missing-attachment'; kind: MissingKind; name: string | null } | { type: 'historical-tool'; name: string; text: string };
export interface PortableMessage {
  id: string; createdAt: number; role: 'user' | 'assistant' | 'tool' | 'quarantine';
  originalRole: string | null; parts: PortablePart[];
}
export interface PortableConversation {
  source: { namespace: SourceNamespace; id: string }; title: string | null;
  createdAt: number; updatedAt: number; status: 'regular' | 'archived'; messages: PortableMessage[];
}
export interface PortableFile { format: 'okaychat.conversations'; version: 1; exportedAt: number; conversations: PortableConversation[] }
export interface ImportCounts { sourceNodes: number; sourceMessages: number; discardedBranchNodes: number; discardedBranchMessages: number; quarantine: number; omittedAttachments: number }
export interface NormalizedItem { ordinal: number; conversation: PortableConversation | null; errorCode: string | null; warnings: ImportWarning[]; counts: ImportCounts }
export interface NormalizedFile { adapter: SourceNamespace; items: NormalizedItem[] }
export type ImportJobState = 'receiving' | 'validating' | 'ready' | 'queued' | 'importing' | 'paused' | 'cancelling' | 'done' | 'cancelled' | 'failed' | 'expired';
export type ImportItemState = 'valid' | 'invalid' | 'pending' | 'imported' | 'duplicate' | 'failed' | 'cancelled' | 'unselected';
