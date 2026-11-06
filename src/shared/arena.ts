import type { TokenUsage } from "./types.js";

export const ARENA_LIMITS = {
  maxPrompt: 20_000, maxPool: 100, maxContents: 20, outputBytes: 32 * 1024,
  paneReservation: 48 * 1024, metadataReservation: 4096, retentionMs: 30 * 86400_000,
  deadlineMs: 120_000, minimumBattles: 20, k: 32,
} as const;
export type ArenaSide = "A" | "B";
export type ArenaMode = "personal" | "public";
export type ArenaChoice = ArenaSide | "tie" | "both_bad";
export type ArenaBattleState = "running" | "ready" | "voted" | "failed" | "cancelled" | "interrupted" | "expired";
export type ArenaPaneState = "running" | "done" | "failed" | "cancelled" | "interrupted";
export type ArenaErrorCode = "arena_not_found" | "arena_invalid" | "arena_start_conflict" | "arena_vote_locked" | "arena_not_ready" | "arena_expired" | "arena_capacity" | "arena_failed" | "arena_interrupted";
export interface ArenaStart { mutationId: string; prompt: string; mode: ArenaMode; poolRefs?: string[] }
export interface ArenaVote { choice: ArenaChoice; createdAt: number }
export interface BlindPane { side: ArenaSide; state: ArenaPaneState; text: string; finish?: "stop" | "length"; errorCode?: ArenaErrorCode }
interface BattleCommon { id: string; mode: ArenaMode; state: ArenaBattleState; createdAt: number; contentExpiresAt: number; canVote: boolean; prompt?: string }
export interface BlindBattle extends BattleCommon { visibility: "blind"; panes: [BlindPane, BlindPane] }
export interface RevealedPane extends BlindPane {
  model: { key: string; ref: string; label: string; available: boolean };
  effort: string; usage: TokenUsage | null; cost: number | null;
  costState: "unknown" | "estimated" | "reported"; finishReason: string | null;
}
export interface RevealedBattle extends BattleCommon { visibility: "revealed"; panes: [RevealedPane, RevealedPane]; vote: ArenaVote }
export type BattleView = BlindBattle | RevealedBattle;
export interface LeaderboardRow {
  modelKey: string; label: string; available: boolean; rank: number | null; rating: number;
  battles: number; wins: number; losses: number; ties: number; bothBad: number;
  winRate: number | null; scoreRate: number | null; provisional: boolean;
}
export interface LeaderboardPage {
  ratingVersion: "elo-v1"; scope: "mine" | "global"; window: "all" | "30d";
  asOf: number; revision: number; rows: LeaderboardRow[]; total: number;
  offset: number; limit: number; minimumBattles: 20; k: 32;
}
