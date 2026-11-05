import { generateText } from "ai";
import type { EvalCaseSnapshot, EvalJudgeConfig, EvalScoreMode } from "../../shared/evaluations.js";
import { EVAL_MAX_RUBRIC } from "../../shared/evaluations.js";
import { EVAL_MAX_COMMENT } from "../../shared/evaluations.js";
import type { ModelInfo } from "../../shared/types.js";
import { AppError } from "../errors.js";
import type { ModelHandle } from "../llm.js";
import { describeProviderError } from "../provider-errors.js";
import { wrapUntrusted } from "../prompt-injection.js";
import { resolvePrompt } from "../prompt-policy.js";
import { costOf, normalizeUsage } from "../usage.js";
import type { TokenUsage } from "../../shared/types.js";

// One judge verdict. The candidate answer and the reference answer are the only untrusted inputs, and
// both arrive inside the shared envelope. Parsing is strict: a malformed or out-of-range reply is a
// failed case, never a guessed score.

export type JudgeVerdict =
  | { ok: true; score: number; rationale: string; usage: TokenUsage; cost: number }
  | { ok: false; error: AppError };

export interface JudgeInput {
  userId: string;
  model: ModelInfo;
  handle: ModelHandle;
  config: EvalJudgeConfig;
  case: EvalCaseSnapshot;
  output: string;
  signal: AbortSignal;
}

export async function judgeCase(input: JudgeInput): Promise<JudgeVerdict> {
  const reference = input.case.expected.trim();
  const output = wrapUntrusted(input.output, { kind: "evaluation_output", name: "candidate answer" }).text;
  const expected = reference ? wrapUntrusted(reference, { kind: "evaluation_expected", name: "reference answer" }).text : "";
  const prompt = resolvePrompt("evaluationJudge", { userId: input.userId, modelRef: input.model.ref }, {
    rubric: input.config.rubric.slice(0, EVAL_MAX_RUBRIC),
    input: input.case.input,
    expected,
    output,
  });
  try {
    const result = await generateText({
      model: input.handle.model,
      providerOptions: input.handle.providerOptions,
      maxRetries: 0,
      maxOutputTokens: 512,
      prompt,
      abortSignal: input.signal,
    });
    const verdict = parseJudgeVerdict(result.text, input.config.scale);
    if (!verdict) {
      return { ok: false, error: new AppError({ code: "unknown", message: "The judge did not return a usable verdict." }) };
    }
    const usage = normalizeUsage(result.totalUsage);
    return {
      ok: true,
      score: verdict.score,
      rationale: verdict.rationale.slice(0, EVAL_MAX_COMMENT),
      usage,
      cost: costOf(input.model.cost, usage),
    };
  } catch (error) {
    return { ok: false, error: describeProviderError(error, { log: false, model: input.model.ref, provider: input.model.providerId }) };
  }
}

/** A single JSON object, optionally inside one code fence. Unknown keys are ignored. */
export function parseJudgeVerdict(text: string, scale: EvalScoreMode): { score: number; rationale: string } | null {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1]!.trim();
  if (!body.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const rawScore = record.score ?? record.value;
  const rawReason = record.reason ?? record.rationale;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) return null;
  if (scale === "scale5") {
    if (!Number.isInteger(rawScore) || rawScore < 1 || rawScore > 5) return null;
  } else if (rawScore !== 0 && rawScore !== 1) {
    return null;
  }
  const rationale = typeof rawReason === "string" ? rawReason.trim() : "";
  if (!rationale) return null;
  return { score: rawScore, rationale };
}
