import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-muted skeleton-shimmer rounded-md", className)}
      {...props}
    />
  );
}

/**
 * Renders nothing until `ms` pass, so a quick load goes straight from blank to content without a skeleton
 * flashing in between. A timer, not an animation delay: reduced motion zeroes animation delays.
 */
function Delayed({ ms = 400, children }: { ms?: number; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return shown ? children : null;
}

export { Delayed, Skeleton };
