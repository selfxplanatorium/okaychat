import { useState } from "react";
import { cn } from "@/lib/utils";

type Transition = "none" | "enter" | "exit";

/**
 * Anonymous chat mark. Off is an outlined ghost; on is a tinted ghost that floats.
 * Turning on crouches, leaps, and puffs; turning off drops and lands with a splat,
 * so the two transitions are distinct motions rather than one played backwards.
 * Keyframes live in motion/chat.css.
 */
export function GhostIcon({ active, className }: { active: boolean; className?: string }) {
  // Derived during render so the first frame after a change already plays the right transition.
  const [shown, setShown] = useState<{ active: boolean; transition: Transition }>({ active, transition: "none" });
  if (shown.active !== active) setShown({ active, transition: active ? "enter" : "exit" });

  return (
    <svg
      // Remounting restarts the keyframes on every change.
      key={`${shown.transition}-${shown.active}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinejoin="round"
      aria-hidden
      className={cn("ghost-icon overflow-visible", className)}
      data-state={shown.active ? "on" : "off"}
      data-transition={shown.transition}
    >
      <g className="ghost-float">
        <g className="ghost-body">
          <path
            className="ghost-shape"
            fill="currentColor"
            d="M6 20.5V11a6 6 0 0 1 12 0v9.5q-1-1.6-2 0t-2 0t-2 0t-2 0t-2 0t-2 0Z"
          />
          <g className="ghost-eyes" fill="currentColor" stroke="none">
            <ellipse cx="9.75" cy="11.25" rx="1.05" ry="1.35" />
            <ellipse cx="14.25" cy="11.25" rx="1.05" ry="1.35" />
          </g>
        </g>
      </g>
      {shown.transition === "enter" && (
        <g className="ghost-puffs" fill="currentColor" stroke="none">
          <circle cx="5" cy="20" r="1" style={{ "--dx": "-3px", "--dy": "1px" } as React.CSSProperties} />
          <circle cx="12" cy="21.5" r="0.9" style={{ "--dx": "0px", "--dy": "3px" } as React.CSSProperties} />
          <circle cx="19" cy="20" r="1" style={{ "--dx": "3px", "--dy": "1px" } as React.CSSProperties} />
        </g>
      )}
    </svg>
  );
}
