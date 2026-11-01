import type { ModelInfo, ReasoningEffort, UserSettings } from "./types.js";

export const REASONING_EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function reasoningOptions(model: Pick<ModelInfo, "reasoningEfforts">): ReasoningEffort[] {
  const supported = REASONING_EFFORTS.filter((effort) => model.reasoningEfforts?.includes(effort));
  return supported.length ? supported : ["low", "medium", "high"];
}

/** Use the nearest supported effort; ties favor the lower level. */
export function resolveReasoningEffort(
  model: Pick<ModelInfo, "ref" | "reasoningEfforts">,
  settings?: Pick<UserSettings, "defaultReasoningEffort" | "reasoningEffort"> | null,
  requested?: ReasoningEffort,
): ReasoningEffort {
  const wanted = requested ?? settings?.reasoningEffort[model.ref] ?? settings?.defaultReasoningEffort ?? "medium";
  const rank = REASONING_EFFORTS.indexOf(wanted);
  return reasoningOptions(model).reduce((closest, effort) =>
    Math.abs(REASONING_EFFORTS.indexOf(effort) - rank) < Math.abs(REASONING_EFFORTS.indexOf(closest) - rank) ? effort : closest);
}
