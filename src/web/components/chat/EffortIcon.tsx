import { REASONING_EFFORTS } from "@shared/reasoning";
import type { ReasoningEffort } from "@shared/types";
import { cn } from "@/lib/utils";

/** Normalize against this model's choices, so its highest effort always fills the dial. */
export function EffortIcon({ effort, options, className }: {
  effort?: ReasoningEffort;
  options: readonly ReasoningEffort[];
  className?: string;
}) {
  const levels = REASONING_EFFORTS.filter((level) => options.includes(level));
  const index = effort ? levels.indexOf(effort) : -1;
  const progress = index < 0 ? undefined : levels.length > 1 ? index / (levels.length - 1) : effort === "none" ? 0 : 1;
  const angle = (150 + (progress ?? 0) * 240) * Math.PI / 180;
  const arc = "M 4.206 18.5 A 9 9 0 1 1 19.794 18.5";

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4 shrink-0", className)}
    >
      <path d={arc} opacity="0.25" />
      {progress !== undefined && (
        <>
          {progress > 0 && <path d={arc} pathLength="1" strokeDasharray={`${progress} 1`} />}
          <path d={`M 12 14 L ${12 + 5.5 * Math.cos(angle)} ${14 + 5.5 * Math.sin(angle)}`} />
        </>
      )}
      <circle cx="12" cy="14" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
