import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "bg-input data-checked:depth-primary not-data-checked:shadow-[inset_0_1px_2px_rgb(0_0_0/18%)] focus-visible:ring-ring/50 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-[background-color,box-shadow] duration-[var(--motion-fast)] ease-out-quart outline-none focus-visible:ring-2 data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:grayscale",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="depth-knob switch-thumb size-4 rounded-full data-checked:translate-x-4 active:scale-x-[1.08]" />
    </SwitchPrimitive.Root>
  );
}
