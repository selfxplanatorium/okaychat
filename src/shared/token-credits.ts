/** Token activity allowance; monetary usage estimates remain separate. */
export type CreditStatus = "unlimited" | "available" | "exhausted" | "usage_unknown";
export interface TokenCreditBalance {
  creditTokens: number | null;
  consumedTokens: number;
  remainingTokens: number | null;
  unknownRequests: number;
  period: number;
  periodStartedAt: number;
  resetPolicy: "manual";
  version: number;
  status: CreditStatus;
  activeOperations: number;
  asOf: number;
}
export interface SetTokenCredit {
  creditTokens: number | null;
  expectedVersion: number;
  mutationId: string;
  reason: string;
}
export interface ResetTokenCredit {
  expectedVersion: number;
  mutationId: string;
  reason: string;
  acknowledgeUnknown: boolean;
}
export type CreditSnapshot = Omit<TokenCreditBalance, "asOf" | "activeOperations">;
export interface TokenCreditAuditEntry {
  id: number;
  actorId: string | null;
  action: "set" | "clear" | "reset";
  before: CreditSnapshot;
  after: CreditSnapshot;
  reason: string;
  createdAt: number;
}
export const CREDIT_ORIGINS = ["chat", "temporary", "schedule", "api", "evaluation", "evaluation_judge", "channel", "translation", "compaction", "title", "memory", "voice", "unmetered", "arena"] as const;
export type CreditOrigin = typeof CREDIT_ORIGINS[number];
export const MAX_TOKEN_CREDIT = 1_000_000_000_000;
