"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBackClose } from "@/hooks/use-back-close";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

// Back closes the dialog on touch devices, as it would in a native app.
function Dialog({ actionsRef, onOpenChange, ...props }: DialogPrimitive.Root.Props) {
  const ownActions = React.useRef<DialogPrimitive.Root.Actions>(null);
  const actions = actionsRef ?? ownActions;
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(props.defaultOpen ?? false);
  useBackClose(props.open ?? uncontrolledOpen, () => actions.current?.close(), "(pointer: coarse)");
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      actionsRef={actions}
      onOpenChange={(open, details) => {
        setUncontrolledOpen(open);
        onOpenChange?.(open, details);
      }}
      {...props}
    />
  );
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs",
        "transition-[opacity,backdrop-filter] duration-[var(--motion-base)] ease-out-quart",
        "data-[starting-style]:opacity-0 data-[starting-style]:[backdrop-filter:blur(0px)]",
        "data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--motion-fast)] data-[ending-style]:ease-in-quart",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // Glass surface (follows the Glass opacity setting) and spacing from T3Code's dialog.
          "dialog-glass text-popover-foreground fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 scale-100 gap-5 rounded-xl border p-6 text-sm outline-none sm:max-w-lg",
          // Rises from just below its resting spot; the centering lives in the
          // same `translate` property so the two compose without extra wrappers.
          "transition-[opacity,translate,scale] duration-[var(--motion-base)] ease-out-expo",
          "data-[starting-style]:translate-y-[calc(-50%_+_6px)] data-[starting-style]:scale-96 data-[starting-style]:opacity-0",
          "data-[ending-style]:translate-y-[calc(-50%_+_2px)] data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--motion-fast)] data-[ending-style]:ease-in-quart",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">{t("common.close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          {t("common.close")}
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "cn-font-heading text-xl leading-none font-semibold",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-muted-foreground *:[a]:hover:text-foreground text-sm *:[a]:underline *:[a]:underline-offset-3",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
