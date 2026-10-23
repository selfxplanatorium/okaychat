import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "@/lib/utils";

// Native scrollbars sit on the container's edge, so inside a rounded popup they
// cross the border and corners (and Firefox has no `::-webkit-scrollbar`). This
// draws its own thumb, inset from every edge. The root is a flex child that
// shrinks to the parent's max height.
function ScrollArea({
  className,
  viewportClassName,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & { viewportClassName?: string }) {
  return (
    <ScrollAreaPrimitive.Root className={cn("flex min-h-0 flex-col", className)} {...props}>
      <ScrollAreaPrimitive.Viewport className={cn("min-h-0 flex-1 overscroll-contain outline-none", viewportClassName)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="my-2 me-0.5 flex w-1.5 justify-center opacity-0 transition-opacity duration-[var(--motion-fast)] data-hovering:opacity-100 data-scrolling:opacity-100 data-scrolling:duration-0"
      >
        <ScrollAreaPrimitive.Thumb className="bg-muted-foreground/45 hover:bg-muted-foreground/70 w-full rounded-full" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}

export { ScrollArea };
