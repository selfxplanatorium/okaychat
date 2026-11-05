import { create } from "zustand";
import type {
  EvalCaseFields,
  EvalComparison,
  EvalDatasetDetail,
  EvalDatasetSummary,
  EvalProgress,
  EvalRunDetail,
  EvalRunSummary,
  EvalScore,
  EvalScoreMode,
} from "@shared/evaluations";
import { t } from "@/i18n";
import { api } from "@/lib/api";

// Evaluation workspace state. Each slice has its own load token so a slower answer for a dataset or run
// the user has already left never paints over the current view.

interface EvaluationsState {
  datasets: EvalDatasetSummary[];
  dataset: EvalDatasetDetail | null;
  runs: EvalRunSummary[];
  run: EvalRunDetail | null;
  progress: EvalProgress | null;
  comparison: EvalComparison | null;
  status: "idle" | "loading" | "error";
  error: string | null;
  actionError: string | null;
  conflict: boolean;
  saving: boolean;

  loadDatasets: () => Promise<void>;
  loadDataset: (id: string) => Promise<void>;
  createDataset: (input: { name: string; description: string; cases?: EvalCaseFields[] }) => Promise<string | null>;
  saveDataset: (id: string, patch: { name: string; description: string }) => Promise<boolean>;
  duplicateDataset: (id: string) => Promise<string | null>;
  deleteDataset: (id: string) => Promise<boolean>;
  addCase: (datasetId: string, fields: EvalCaseFields) => Promise<boolean>;
  updateCase: (datasetId: string, caseId: string, fields: EvalCaseFields) => Promise<boolean>;
  deleteCase: (datasetId: string, caseId: string) => Promise<boolean>;
  moveCase: (datasetId: string, caseId: string, direction: -1 | 1) => Promise<boolean>;

  loadRuns: (datasetId: string) => Promise<void>;
  startRun: (datasetId: string, input: StartRunInput) => Promise<string | null>;
  loadRun: (id: string) => Promise<void>;
  pollRun: (id: string) => Promise<void>;
  refreshDetail: (id: string) => Promise<void>;
  cancelRun: (id: string) => Promise<void>;
  deleteRun: (id: string) => Promise<void>;
  duplicateRun: (id: string) => Promise<string | null>;
  scoreCase: (runId: string, caseId: string, input: { expectedRevision: number; value: number; comment?: string }) => Promise<boolean>;
  clearScore: (runId: string, caseId: string, expectedRevision: number) => Promise<boolean>;
  judgeRun: (runId: string, input: { modelRef: string; rubric: string; scale: EvalScoreMode; effort?: string }) => Promise<boolean>;
  loadComparison: (a: string, b: string) => Promise<void>;
  clearActionError: () => void;
  reset: () => void;
}

export interface StartRunInput {
  label?: string;
  modelRef: string;
  effort?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  assistantPresetId?: string;
  assistantRevision?: number;
  concurrency?: number;
  budgetMicros?: number;
  budgetTokens?: number;
  scoreMode?: EvalScoreMode;
  caseIds?: string[];
  expectedRevision?: number;
}

let datasetsToken = 0;
let datasetToken = 0;
let runsToken = 0;
let runToken = 0;
let comparisonToken = 0;
let lastDetailAt = 0;

const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message : t("errors.unknownMessage"));
const conflictOf = (error: unknown) => (error as { status?: number })?.status === 409;

const mergeSummary = (list: EvalDatasetSummary[], next: EvalDatasetSummary): EvalDatasetSummary[] =>
  [next, ...list.filter((item) => item.id !== next.id)].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

const initial = {
  datasets: [] as EvalDatasetSummary[],
  dataset: null as EvalDatasetDetail | null,
  runs: [] as EvalRunSummary[],
  run: null as EvalRunDetail | null,
  progress: null as EvalProgress | null,
  comparison: null as EvalComparison | null,
  status: "idle" as const,
  error: null as string | null,
  actionError: null as string | null,
  conflict: false,
  saving: false,
};

export const useEvaluations = create<EvaluationsState>((set, get) => ({
  ...initial,

  async loadDatasets() {
    const token = ++datasetsToken;
    set({ status: "loading", error: null });
    try {
      const result = await api<{ datasets: EvalDatasetSummary[] }>("/evaluations/datasets");
      if (token !== datasetsToken) return;
      set({ datasets: result.datasets, status: "idle" });
    } catch (error) {
      if (token === datasetsToken) set({ status: "error", error: messageOf(error) });
    }
  },

  async loadDataset(id) {
    const token = ++datasetToken;
    set({ status: "loading", error: null, actionError: null, conflict: false });
    try {
      const result = await api<{ dataset: EvalDatasetSummary; cases: EvalDatasetDetail["cases"]; usedBytes: number }>(`/evaluations/datasets/${id}`);
      if (token !== datasetToken) return;
      set({ dataset: { ...result.dataset, cases: result.cases, usedBytes: result.usedBytes }, status: "idle" });
    } catch (error) {
      if (token === datasetToken) set({ status: "error", error: messageOf(error), dataset: null });
    }
  },

  async createDataset(input) {
    set({ saving: true, actionError: null, conflict: false });
    try {
      const detail = await api<EvalDatasetDetail>("/evaluations/datasets", { method: "POST", json: input });
      set((state) => ({ datasets: mergeSummary(state.datasets, detail), dataset: detail, saving: false }));
      return detail.id;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return null;
    }
  },

  async saveDataset(id, patch) {
    const current = get().dataset;
    if (!current) return false;
    set({ saving: true, actionError: null, conflict: false });
    try {
      const result = await api<{ dataset: EvalDatasetSummary }>(`/evaluations/datasets/${id}`, {
        method: "PUT",
        json: { expectedRevision: current.revision, ...patch },
      });
      set((state) => ({
        saving: false,
        datasets: mergeSummary(state.datasets, result.dataset),
        dataset: state.dataset?.id === id ? { ...state.dataset, ...result.dataset } : state.dataset,
      }));
      return true;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return false;
    }
  },

  async duplicateDataset(id) {
    set({ saving: true, actionError: null, conflict: false });
    try {
      const result = await api<{ dataset: EvalDatasetSummary }>(`/evaluations/datasets/${id}/duplicate`, { method: "POST" });
      set((state) => ({ saving: false, datasets: mergeSummary(state.datasets, result.dataset) }));
      return result.dataset.id;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return null;
    }
  },

  async deleteDataset(id) {
    set({ saving: true, actionError: null, conflict: false });
    try {
      await api(`/evaluations/datasets/${id}`, { method: "DELETE" });
      set((state) => ({
        saving: false,
        datasets: state.datasets.filter((item) => item.id !== id),
        dataset: state.dataset?.id === id ? null : state.dataset,
        runs: state.dataset?.id === id ? [] : state.runs,
      }));
      return true;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return false;
    }
  },

  async addCase(datasetId, fields) {
    const current = get().dataset;
    if (!current) return false;
    set({ saving: true, actionError: null, conflict: false });
    try {
      const result = await api<{ case: EvalDatasetDetail["cases"][number]; dataset: EvalDatasetSummary }>(`/evaluations/datasets/${datasetId}/cases`, {
        method: "POST",
        json: { expectedRevision: current.revision, ...fields },
      });
      set((state) =>
        state.dataset?.id === datasetId
          ? {
              saving: false,
              dataset: { ...state.dataset, ...result.dataset, cases: [...state.dataset.cases, result.case] },
              datasets: mergeSummary(state.datasets, result.dataset),
            }
          : { saving: false },
      );
      return true;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return false;
    }
  },

  async updateCase(datasetId, caseId, fields) {
    const current = get().dataset;
    if (!current) return false;
    set({ saving: true, actionError: null, conflict: false });
    try {
      const result = await api<{ case: EvalDatasetDetail["cases"][number]; dataset: EvalDatasetSummary }>(`/evaluations/datasets/${datasetId}/cases/${caseId}`, {
        method: "PUT",
        json: { expectedRevision: current.revision, ...fields },
      });
      set((state) =>
        state.dataset?.id === datasetId
          ? {
              saving: false,
              dataset: {
                ...state.dataset,
                ...result.dataset,
                cases: state.dataset.cases.map((item) => (item.caseId === caseId ? result.case : item)),
              },
              datasets: mergeSummary(state.datasets, result.dataset),
            }
          : { saving: false },
      );
      return true;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return false;
    }
  },

  async deleteCase(datasetId, caseId) {
    const current = get().dataset;
    if (!current) return false;
    set({ saving: true, actionError: null, conflict: false });
    try {
      await api(`/evaluations/datasets/${datasetId}/cases/${caseId}`, {
        method: "DELETE",
        json: { expectedRevision: current.revision },
      });
      set({ saving: false });
      await get().loadDataset(datasetId);
      return true;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return false;
    }
  },

  async moveCase(datasetId, caseId, direction) {
    const current = get().dataset;
    if (!current) return false;
    const index = current.cases.findIndex((item) => item.caseId === caseId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.cases.length) return false;
    const order = current.cases.map((item) => item.caseId);
    const [moved] = order.splice(index, 1);
    order.splice(target, 0, moved!);
    set({ saving: true, actionError: null, conflict: false });
    try {
      const result = await api<{ cases: EvalDatasetDetail["cases"]; dataset: EvalDatasetSummary }>(`/evaluations/datasets/${datasetId}/cases/order`, {
        method: "PATCH",
        json: { expectedRevision: current.revision, caseIds: order },
      });
      set((state) =>
        state.dataset?.id === datasetId
          ? { saving: false, dataset: { ...state.dataset, ...result.dataset, cases: result.cases }, datasets: mergeSummary(state.datasets, result.dataset) }
          : { saving: false },
      );
      return true;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return false;
    }
  },

  async loadRuns(datasetId) {
    const token = ++runsToken;
    try {
      const result = await api<{ runs: EvalRunSummary[] }>(`/evaluations/runs?dataset=${encodeURIComponent(datasetId)}&limit=50`);
      if (token !== runsToken) return;
      set({ runs: result.runs });
    } catch (error) {
      if (token === runsToken) set({ actionError: messageOf(error) });
    }
  },

  async startRun(datasetId, input) {
    set({ saving: true, actionError: null, conflict: false });
    try {
      const run = await api<EvalRunSummary>(`/evaluations/datasets/${datasetId}/runs`, { method: "POST", json: input });
      set((state) => ({ saving: false, runs: [run, ...state.runs.filter((item) => item.id !== run.id)] }));
      await get().loadRun(run.id);
      return run.id;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return null;
    }
  },

  async loadRun(id) {
    const token = ++runToken;
    set({ status: "loading", error: null, actionError: null, conflict: false });
    try {
      const run = await api<EvalRunDetail>(`/evaluations/runs/${id}`);
      if (token !== runToken) return;
      lastDetailAt = Date.now();
      set({
        run,
        progress: progressOf(run),
        status: "idle",
        runs: [run, ...get().runs.filter((item) => item.id !== run.id)],
      });
    } catch (error) {
      if (token === runToken) set({ status: "error", error: messageOf(error), run: null });
    }
  },

  async pollRun(id) {
    if (get().run?.id !== id && get().progress === null) return;
    try {
      const progress = await api<EvalProgress>(`/evaluations/runs/${id}/progress`);
      if (get().run?.id !== id) return;
      const before = get().progress;
      set({ progress });
      const changed =
        !before ||
        before.state !== progress.state ||
        before.judgeState !== progress.judgeState ||
        before.completedCases !== progress.completedCases ||
        before.failedCases !== progress.failedCases ||
        before.skippedCases !== progress.skippedCases;
      const terminal = progress.state !== "queued" && progress.state !== "running" && progress.state !== "cancelling";
      const judging = progress.judgeState === "queued" || progress.judgeState === "running";
      if (changed && (Date.now() - lastDetailAt > 3_000 || terminal || (!judging && progress.judgeState !== "idle"))) await get().refreshDetail(id);
    } catch {
      // A poll failure is transient; the next tick retries.
    }
  },

  async refreshDetail(id) {
    try {
      const run = await api<EvalRunDetail>(`/evaluations/runs/${id}`);
      if (get().run?.id !== id && get().run !== null) return;
      lastDetailAt = Date.now();
      set((state) => ({
        run,
        progress: progressOf(run),
        runs: state.runs.some((item) => item.id === run.id) ? state.runs.map((item) => (item.id === run.id ? run : item)) : [run, ...state.runs],
      }));
    } catch {
      // The visible detail stays; the next poll or explicit reload tries again.
    }
  },

  async cancelRun(id) {
    set({ actionError: null, conflict: false });
    try {
      const result = await api<{ state: EvalRunSummary["state"]; judgeState: string }>(`/evaluations/runs/${id}/cancel`, { method: "POST" });
      set((state) => ({
        progress: state.progress ? { ...state.progress, state: result.state, judgeState: result.judgeState as EvalProgress["judgeState"] } : state.progress,
      }));
    } catch (error) {
      set({ actionError: messageOf(error), conflict: conflictOf(error) });
    }
  },

  async deleteRun(id) {
    set({ actionError: null, conflict: false });
    try {
      await api(`/evaluations/runs/${id}`, { method: "DELETE" });
      set((state) => ({ runs: state.runs.filter((item) => item.id !== id), run: state.run?.id === id ? null : state.run }));
    } catch (error) {
      set({ actionError: messageOf(error), conflict: conflictOf(error) });
    }
  },

  async duplicateRun(id) {
    set({ saving: true, actionError: null, conflict: false });
    try {
      const run = await api<EvalRunSummary>(`/evaluations/runs/${id}/duplicate`, { method: "POST" });
      set((state) => ({ saving: false, runs: [run, ...state.runs] }));
      await get().loadRun(run.id);
      return run.id;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return null;
    }
  },

  async scoreCase(runId, caseId, input) {
    set({ actionError: null, conflict: false });
    try {
      const result = await api<{ score: EvalScore }>(`/evaluations/runs/${runId}/cases/${caseId}/score`, { method: "PUT", json: input });
      set((state) => (state.run ? { run: withScore(state.run, result.score) } : {}));
      return true;
    } catch (error) {
      set({ actionError: messageOf(error), conflict: conflictOf(error) });
      return false;
    }
  },

  async clearScore(runId, caseId, expectedRevision) {
    set({ actionError: null, conflict: false });
    try {
      await api(`/evaluations/runs/${runId}/cases/${caseId}/score`, { method: "DELETE", json: { expectedRevision } });
      set((state) => (state.run ? { run: { ...state.run, scores: state.run.scores.filter((score) => !(score.caseId === caseId && score.source === "manual")) } } : {}));
      return true;
    } catch (error) {
      set({ actionError: messageOf(error), conflict: conflictOf(error) });
      return false;
    }
  },

  async judgeRun(runId, input) {
    set({ saving: true, actionError: null, conflict: false });
    try {
      await api(`/evaluations/runs/${runId}/judge`, { method: "POST", json: input });
      set({ saving: false });
      await get().refreshDetail(runId);
      return true;
    } catch (error) {
      set({ saving: false, actionError: messageOf(error), conflict: conflictOf(error) });
      return false;
    }
  },

  async loadComparison(a, b) {
    const token = ++comparisonToken;
    set({ status: "loading", error: null });
    try {
      const comparison = await api<EvalComparison>(`/evaluations/runs/${a}/compare/${b}`);
      if (token !== comparisonToken) return;
      set({ comparison, status: "idle" });
    } catch (error) {
      if (token === comparisonToken) set({ status: "error", error: messageOf(error), comparison: null });
    }
  },

  clearActionError() {
    set({ actionError: null, conflict: false });
  },

  reset() {
    datasetsToken++;
    datasetToken++;
    runsToken++;
    runToken++;
    comparisonToken++;
    set({ ...initial });
  },
}));

const progressOf = (run: EvalRunDetail): EvalProgress => ({
  state: run.state,
  stopReason: run.stopReason,
  errorCode: run.errorCode,
  totalCases: run.totalCases,
  completedCases: run.completedCases,
  failedCases: run.failedCases,
  skippedCases: run.skippedCases,
  usage: run.usage,
  cost: run.cost,
  latencyTotalMs: run.latencyTotalMs,
  judgeState: run.judge?.state ?? "idle",
  judgeDoneCases: run.judge?.doneCases ?? 0,
  judgeFailedCases: run.judge?.failedCases ?? 0,
  judgeCost: run.judge?.cost ?? 0,
  updatedAt: run.updatedAt,
});

const withScore = (run: EvalRunDetail, score: EvalScore): EvalRunDetail => ({
  ...run,
  scores: [...run.scores.filter((item) => !(item.caseId === score.caseId && item.source === score.source)), score],
});
