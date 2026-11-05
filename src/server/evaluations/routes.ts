import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  EVAL_DEFAULT_BUDGET_MICROS,
  EVAL_DEFAULT_BUDGET_TOKENS,
  EVAL_DEFAULT_CONCURRENCY,
  EVAL_MAX_BUDGET_MICROS,
  EVAL_MAX_BUDGET_TOKENS,
  EVAL_MAX_CONCURRENCY,
  EVAL_MAX_LABEL,
  EVAL_MAX_RUBRIC,
  EVAL_MIN_BUDGET_MICROS,
  EVAL_MIN_BUDGET_TOKENS,
  EVAL_MIN_CONCURRENCY,
  type EvalJudgeConfig,
} from "../../shared/evaluations.js";
import { resolveReasoningEffort } from "../../shared/reasoning.js";
import type { ReasoningEffort } from "../../shared/types.js";
import { validateSampling } from "../../shared/assistant-presets.js";
import type { AppEnv } from "../auth.js";
import { getPreset } from "../assistant-presets.js";
import { resolveModel } from "../catalog/providers.js";
import { sha256 } from "../crypto.js";
import { AppError } from "../errors.js";
import { assertModelAllowed, requireFeature } from "../permissions/guard.js";
import { getSettings } from "../settings.js";
import {
  addCase,
  createDataset,
  deleteCase,
  deleteDataset,
  deleteManualScore,
  deleteRun,
  duplicateDataset,
  duplicateRun,
  exportData,
  finalizeQueuedCancel,
  getCaseView,
  getComparison,
  getDataset,
  getRun,
  getRunProgress,
  launchRun,
  listDatasets,
  listRuns,
  markRunCancelling,
  queueJudge,
  reorderCases,
  runRow,
  saveManualScore,
  updateCase,
  updateDataset,
  type LaunchInput,
} from "./store.js";
import { exportCsv, exportFilename, exportJson } from "./export.js";
import { cancelRunJob, enqueueJudge, enqueueRun } from "./worker.js";

// Mounted by routes.ts at /api/evaluations. Every route is feature-gated; ownership checks live in
// store.ts. A foreign or missing id answers 404 without distinguishing the two.

const body = async (c: Context): Promise<Record<string, unknown>> => {
  const parsed = await c.req.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError({ code: "validation", message: "Invalid request body." });
  }
  return parsed as Record<string, unknown>;
};

/** A CAS failure carries the stored row so the client recovers without a second request. */
function answer(c: Context, error: unknown) {
  if (error instanceof AppError && error.code === "conflict") {
    const details = error.details as { dataset?: unknown; score?: unknown } | undefined;
    if (details?.dataset) return c.json({ error: error.message, dataset: details.dataset }, 409);
    if (details?.score) return c.json({ error: error.message, score: details.score }, 409);
  }
  throw error;
}

const efforts = new Set<string>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const effortOf = (value: string | undefined): ReasoningEffort | undefined => (value && efforts.has(value) ? (value as ReasoningEffort) : undefined);

export const evaluationRoutes = new Hono<AppEnv>()
  .use("*", requireFeature("evaluations"))
  .get("/datasets", (c) => c.json({ datasets: listDatasets(c.get("user").id) }))
  .post("/datasets", async (c) => {
    const input = await body(c);
    return c.json(createDataset(c.get("user").id, { name: input.name, description: input.description, cases: input.cases }), 201);
  })
  .get("/datasets/:id", (c) => {
    const detail = getDataset(c.get("user").id, c.req.param("id"));
    if (!detail) return c.json({ error: "Dataset not found." }, 404);
    const { cases, usedBytes, ...dataset } = detail;
    return c.json({ dataset, cases, usedBytes });
  })
  .put("/datasets/:id", async (c) => {
    const input = await body(c);
    try {
      return c.json({
        dataset: updateDataset(c.get("user").id, c.req.param("id"), {
          expectedRevision: input.expectedRevision,
          name: input.name,
          description: input.description,
        }),
      });
    } catch (error) {
      return answer(c, error);
    }
  })
  .delete("/datasets/:id", (c) => {
    deleteDataset(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/datasets/:id/duplicate", (c) => {
    const detail = duplicateDataset(c.get("user").id, c.req.param("id"));
    const { cases: _cases, usedBytes: _usedBytes, ...dataset } = detail;
    return c.json({ dataset }, 201);
  })
  // Static before parameterized: `/cases/order` must never be read as a case id.
  .patch("/datasets/:id/cases/order", async (c) => {
    const input = await body(c);
    try {
      const result = reorderCases(c.get("user").id, c.req.param("id"), input.expectedRevision, input.caseIds);
      return c.json(result);
    } catch (error) {
      return answer(c, error);
    }
  })
  .post("/datasets/:id/cases", async (c) => {
    const input = await body(c);
    try {
      return c.json(addCase(c.get("user").id, c.req.param("id"), input.expectedRevision, input), 201);
    } catch (error) {
      return answer(c, error);
    }
  })
  .put("/datasets/:id/cases/:caseId", async (c) => {
    const input = await body(c);
    try {
      return c.json(updateCase(c.get("user").id, c.req.param("id"), c.req.param("caseId"), input.expectedRevision, input));
    } catch (error) {
      return answer(c, error);
    }
  })
  .delete("/datasets/:id/cases/:caseId", async (c) => {
    const input = await body(c);
    try {
      return c.json(deleteCase(c.get("user").id, c.req.param("id"), c.req.param("caseId"), input.expectedRevision));
    } catch (error) {
      return answer(c, error);
    }
  })
  .get("/runs", (c) => {
    const dataset = c.req.query("dataset") || undefined;
    const requested = Number(c.req.query("limit") ?? 50);
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(50, requested)) : 50;
    return c.json({ runs: listRuns(c.get("user").id, dataset, limit) });
  })
  .post("/datasets/:id/runs", async (c) => {
    const parsed = launchBody.safeParse(await body(c));
    if (!parsed.success) throw new AppError({ code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid run settings." });
    const userId = c.get("user").id;
    const datasetId = c.req.param("id");
    const input = parsed.data;
    if (input.modelRef.startsWith("n8n/")) throw new AppError({ code: "validation", message: "Agents cannot be evaluated as language models." });
    if (input.effort && !efforts.has(input.effort)) throw new AppError({ code: "validation", message: "Unknown reasoning effort." });
    const dataset = getDataset(userId, datasetId);
    if (!dataset) throw new AppError({ code: "not_found", message: "Dataset not found." });
    if (input.expectedRevision !== undefined && dataset.revision !== input.expectedRevision) {
      const { cases: _cases, usedBytes: _usedBytes, ...stored } = dataset;
      return c.json({ error: "This dataset changed in another tab. Reload it.", dataset: stored }, 409);
    }
    if (input.caseIds) {
      if (new Set(input.caseIds).size !== input.caseIds.length) throw new AppError({ code: "validation", message: "Pick each case once." });
      const known = new Set(dataset.cases.map((item) => item.caseId));
      if (input.caseIds.some((id) => !known.has(id))) throw new AppError({ code: "validation", message: "One of those cases is not in this dataset." });
      if (input.caseIds.length === 0) throw new AppError({ code: "validation", message: "Pick at least one case." });
    } else if (dataset.cases.length === 0) {
      throw new AppError({ code: "validation", message: "Add a case before starting a run." });
    }
    const { model } = await resolveModel(userId, input.modelRef);
    const settings = getSettings(userId);
    const effort = resolveReasoningEffort(model, settings, effortOf(input.effort));
    let preset: ReturnType<typeof getPreset> = null;
    if (input.assistantPresetId) {
      preset = getPreset(userId, input.assistantPresetId);
      if (!preset) throw new AppError({ code: "not_found", message: "Assistant not found." });
      if (input.assistantRevision !== undefined && preset.revision !== input.assistantRevision) {
        throw new AppError({ code: "conflict", message: "This assistant changed in another tab. Reload it." });
      }
    }
    const presetSampling = preset?.config.sampling ?? {};
    const sampling = validateSampling(
      {
        ...(input.temperature !== undefined ? { temperature: input.temperature } : { temperature: presetSampling.temperature }),
        ...(input.topP !== undefined ? { topP: input.topP } : { topP: presetSampling.topP }),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : { maxOutputTokens: presetSampling.maxOutputTokens }),
      },
      model,
      effort,
    );
    if (!sampling.ok) throw new AppError({ code: "validation", message: sampling.message ?? "Invalid sampling settings." });
    const policy = assertModelAllowed(userId, model.ref);
    const cap = policy.limits.concurrentOperations ?? EVAL_MAX_CONCURRENCY;
    const concurrency = Math.max(EVAL_MIN_CONCURRENCY, Math.min(input.concurrency ?? EVAL_DEFAULT_CONCURRENCY, EVAL_MAX_CONCURRENCY, cap));
    const launch: LaunchInput = {
      label: input.label?.trim() || defaultRunLabel(dataset.name, model.name),
      target: {
        modelRef: model.ref,
        modelName: model.name,
        effort: model.reasoning ? effort : null,
        sampling: sampling.sampling,
        assistantPresetId: preset?.id ?? null,
        assistantName: preset?.name ?? null,
        instructions: preset?.config.instructions ?? "",
      },
      scoreMode: input.scoreMode ?? "scale5",
      concurrency,
      budgetTokens: input.budgetTokens ?? EVAL_DEFAULT_BUDGET_TOKENS,
      budgetMicros: input.budgetMicros ?? EVAL_DEFAULT_BUDGET_MICROS,
      ...(input.caseIds ? { caseIds: input.caseIds } : {}),
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    };
    try {
      const { run } = launchRun(userId, datasetId, launch);
      enqueueRun(userId, run.id);
      return c.json(run, 201);
    } catch (error) {
      return answer(c, error);
    }
  })
  .post("/runs/:id/duplicate", (c) => {
    const user = c.get("user");
    const run = duplicateRun(user.id, c.req.param("id"));
    enqueueRun(user.id, run.id);
    return c.json(run, 201);
  })
  .get("/runs/:id", (c) => {
    const run = getRun(c.get("user").id, c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "Run not found." }, 404);
  })
  .get("/runs/:id/progress", (c) => {
    const progress = getRunProgress(c.get("user").id, c.req.param("id"));
    return progress ? c.json(progress) : c.json({ error: "Run not found." }, 404);
  })
  .get("/runs/:id/cases/:caseId", (c) => {
    const view = getCaseView(c.get("user").id, c.req.param("id"), c.req.param("caseId"));
    return view ? c.json(view) : c.json({ error: "Case not found." }, 404);
  })
  .post("/runs/:id/cancel", (c) => {
    const userId = c.get("user").id;
    const runId = c.req.param("id");
    const before = runRow(userId, runId);
    if (!before) return c.json({ error: "Run not found." }, 404);
    const result = markRunCancelling(userId, runId);
    const phase = cancelRunJob(userId, runId);
    // A queued run the worker never picked up still has to reach a terminal state.
    if (!phase && before.state === "queued") finalizeQueuedCancel(runId);
    return c.json(result);
  })
  .delete("/runs/:id", (c) => {
    deleteRun(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .put("/runs/:id/cases/:caseId/score", async (c) => {
    const input = await body(c);
    try {
      return c.json({
        score: saveManualScore(c.get("user").id, c.req.param("id"), c.req.param("caseId"), {
          expectedRevision: input.expectedRevision,
          value: input.value,
          comment: input.comment,
        }),
      });
    } catch (error) {
      return answer(c, error);
    }
  })
  .delete("/runs/:id/cases/:caseId/score", async (c) => {
    const input = await body(c);
    try {
      deleteManualScore(c.get("user").id, c.req.param("id"), c.req.param("caseId"), input.expectedRevision);
      return c.json({ ok: true });
    } catch (error) {
      return answer(c, error);
    }
  })
  .post("/runs/:id/judge", async (c) => {
    const parsed = judgeBody.safeParse(await body(c));
    if (!parsed.success) throw new AppError({ code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid judge settings." });
    const userId = c.get("user").id;
    const runId = c.req.param("id");
    const row = runRow(userId, runId);
    if (!row) return c.json({ error: "Run not found." }, 404);
    if (parsed.data.modelRef.startsWith("n8n/")) throw new AppError({ code: "validation", message: "Agents cannot be evaluated as language models." });
    if (parsed.data.effort && !efforts.has(parsed.data.effort)) throw new AppError({ code: "validation", message: "Unknown reasoning effort." });
    const rubric = parsed.data.rubric.trim();
    if (rubric.length < 1 || rubric.length > EVAL_MAX_RUBRIC) throw new AppError({ code: "validation", message: `A rubric is 1 to ${EVAL_MAX_RUBRIC} characters.` });
    const { model } = await resolveModel(userId, parsed.data.modelRef);
    assertModelAllowed(userId, model.ref);
    const effort = resolveReasoningEffort(model, getSettings(userId), effortOf(parsed.data.effort));
    const config: EvalJudgeConfig = {
      modelRef: model.ref,
      modelName: model.name,
      effort: model.reasoning ? effort : null,
      scale: parsed.data.scale,
      rubric,
      rubricHash: sha256(rubric),
    };
    const judge = queueJudge(userId, runId, config);
    enqueueJudge(userId, runId);
    return c.json({ judge }, 202);
  })
  .get("/runs/:id/compare/:otherId", (c) => c.json(getComparison(c.get("user").id, c.req.param("id"), c.req.param("otherId"))))
  .get("/runs/:id/export", (c) => {
    const format = c.req.query("format");
    if (format !== "csv" && format !== "json") throw new AppError({ code: "validation", message: "Pick CSV or JSON." });
    const data = exportData(c.get("user").id, c.req.param("id"));
    if (!data) return c.json({ error: "Run not found." }, 404);
    const text = format === "csv" ? exportCsv(data) : exportJson(data);
    return c.body(text, 200, {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(data.dataset.name, data.run.id, format)}"`,
      "Cache-Control": "no-store",
    });
  });

const launchBody = z.object({
  label: z.string().max(EVAL_MAX_LABEL).optional(),
  modelRef: z.string().min(1).max(300),
  effort: z.string().optional(),
  temperature: z.number().finite().optional(),
  topP: z.number().finite().optional(),
  maxOutputTokens: z.number().int().min(1).max(131_072).optional(),
  assistantPresetId: z.string().min(1).max(200).optional(),
  assistantRevision: z.number().int().min(1).optional(),
  concurrency: z.number().int().min(EVAL_MIN_CONCURRENCY).max(EVAL_MAX_CONCURRENCY).optional(),
  budgetMicros: z.number().int().min(EVAL_MIN_BUDGET_MICROS).max(EVAL_MAX_BUDGET_MICROS).optional(),
  budgetTokens: z.number().int().min(EVAL_MIN_BUDGET_TOKENS).max(EVAL_MAX_BUDGET_TOKENS).optional(),
  scoreMode: z.enum(["scale5", "pass_fail"]).optional(),
  caseIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  expectedRevision: z.number().int().min(1).optional(),
});

const judgeBody = z.object({
  modelRef: z.string().min(1).max(300),
  rubric: z.string().max(EVAL_MAX_RUBRIC),
  scale: z.enum(["scale5", "pass_fail"]),
  effort: z.string().optional(),
});

function defaultRunLabel(datasetName: string, modelName: string): string {
  const stamp = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date());
  return `${datasetName} · ${modelName} · ${stamp}`.slice(0, EVAL_MAX_LABEL);
}
