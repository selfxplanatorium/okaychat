import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "placeholder:text-muted-foreground depth-field disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 bg-muted/60 focus-visible:bg-background field-sizing-content min-h-16 w-full min-w-0 rounded-lg border border-transparent px-3 py-2 text-base transition-[color,background-color,border-color,box-shadow] duration-[var(--motion-fast)] ease-out-quart outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-1 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
