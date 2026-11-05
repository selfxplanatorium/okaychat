// The app's segmented control: Glisse 0.5.0's segmented design (local
// adaptation in vendor/glisse/segmented-control.tsx) behind a real radio group.
// Labels are passed in, so no user-facing text lives in the vendor code.
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SegmentedControl as GlisseSegmentedControl,
  type SegmentItem,
  type SegmentedControlProps as GlisseProps,
} from "@/vendor/glisse/segmented-control";

export interface SegmentedControlItem extends SegmentItem {
  /** Why this choice is unavailable; shown in a tooltip and kept in the a11y tree. */
  reason?: string;
}

export interface SegmentedControlProps extends Omit<GlisseProps, "items" | "renderItem"> {
  items: ReadonlyArray<SegmentedControlItem>;
}

export function SegmentedControl({ items, ...props }: SegmentedControlProps) {
  return (
    <GlisseSegmentedControl
      {...props}
      items={items}
      renderItem={(item, radio) => {
        const reason = items.find((candidate) => candidate.value === item.value)?.reason;
        if (!reason) return radio;
        return (
          <Tooltip>
            {/* aria-disabled, not disabled, so the reason is still reachable. */}
            <TooltipTrigger render={radio} />
            {/* The theme inspector must not treat the tooltip as page content. */}
            <TooltipContent data-theme-editor-panel="">{reason}</TooltipContent>
          </Tooltip>
        );
      }}
    />
  );
}
