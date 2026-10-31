import type { InjectionReport } from "@shared/types";

/** A tool result carries the server's advisory scan at `injection`; everything else is ignored. */
export function toolInjection(result: unknown): InjectionReport | undefined {
  if (!result || typeof result !== "object") return undefined;
  const report = (result as { injection?: unknown }).injection;
  if (!report || typeof report !== "object") return undefined;
  const { flagged, findings } = report as Partial<InjectionReport>;
  if (flagged !== true || !Array.isArray(findings)) return undefined;
  return { flagged: true, findings: findings.filter((item) => typeof item?.code === "string" && typeof item?.reason === "string") };
}
