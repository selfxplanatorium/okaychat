/** Side-by-side model comparison. Every pane is a real hidden chat run through the normal turn pipeline. */
import type { UIMessage } from "ai";

export const COMPARE_MIN_PANES = 2;
export const COMPARE_MAX_PANES = 3;
export const COMPARE_MAX_PROMPT = 20_000;
export const COMPARE_MAX_GROUPS = 20;
export const COMPARE_RETENTION_DAYS = 30;

export interface ComparisonModelChoice {
  ref: string;
  effort?: string;
}

export interface ComparisonGroupSummary {
  id: string;
  title: string;
  prompt: string;
  projectId: string | null;
  sourceThreadId: string | null;
  paneCount: number;
  createdAt: number;
  updatedAt: number;
}

/** One pane: a hidden thread whose branch is rendered read-only in its column. */
export interface ComparisonPaneDetail {
  threadId: string;
  modelRef: string;
  modelName: string;
  title: string | null;
  messages: UIMessage[];
}

export interface ComparisonGroupDetail extends ComparisonGroupSummary {
  panes: ComparisonPaneDetail[];
}

export interface ComparisonCreateInput {
  prompt: string;
  models: ComparisonModelChoice[];
  projectId?: string | null;
  sourceThreadId?: string | null;
}
