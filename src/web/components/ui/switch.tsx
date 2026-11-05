// The app's switch: Glisse 0.5.0's Switch (local adaptation in
// vendor/glisse/switch.tsx) behind one native, labelled button. Base UI's
// switch is kept as FormSwitch for the cases this migration does not cover:
// form participation (name/value/required), Field validity, `render` and
// `inputRef`. See docs/implementation/appearance.md.
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { GlisseSwitch } from "@/vendor/glisse/switch";
import { cn } from "@/lib/utils";

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role" | "type" | "aria-checked" | "children" | "onChange"> {
  checked?: boolean;
  defaultChecked?: boolean;
  /** Called once per accepted action, after a click, Space/Enter or a drag. */
  onCheckedChange?: (checked: boolean) => void;
  /** A save is in flight: the switch cannot change and announces itself busy. */
  loading?: boolean;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { loading = false, disabled = false, ...props },
  ref,
) {
  return <GlisseSwitch {...props} disabled={disabled} loading={loading} ref={ref} />;
});

/**
 * The Base UI switch, for callers that need a real form control: a `name` and
 * `value` in a submitted form, `required` validity, a disabled fieldset reset,
 * a custom `render`, or a `(checked, eventDetails)` handler. New code should
 * prefer `Switch` unless it needs one of those.
 */
export function FormSwitch({ className, ...props }: SwitchPrimitive.Root.Props) {
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
