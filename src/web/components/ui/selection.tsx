import { CheckIcon, ListChecksIcon, Loader2Icon, MinusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { pruneSelection, toggleSelection } from "@/lib/selection";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** The box drawn on a selectable row or card. Decorative: the row itself carries the checkbox role. */
export function SelectionCheck({ checked, indeterminate = false, className }: { checked: boolean; indeterminate?: boolean; className?: string }) {
  const on = checked || indeterminate;
  return (
    <span
      aria-hidden
      data-checked={on || undefined}
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[5px] border transition-[background-color,border-color,box-shadow] duration-(--motion-fast) ease-out-quart",
        on ? "depth-primary text-primary-foreground border-transparent" : "border-muted-foreground/40 bg-background/80",
        className,
      )}
    >
      {indeterminate && !checked ? (
        <MinusIcon className="size-3" strokeWidth={3} />
      ) : (
        <CheckIcon className={cn("size-3 transition-[opacity,scale] duration-(--motion-fast) ease-spring", checked ? "scale-100 opacity-100" : "scale-50 opacity-0")} strokeWidth={3} />
      )}
    </span>
  );
}

/**
 * Selection over an ordered list: Shift extends from the last clicked id, ids that leave `order`
 * drop out, and leaving selection mode clears everything.
 */
export function useSelection(order: readonly string[]) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);

  useEffect(() => setSelected((prev) => pruneSelection(prev, order)), [order]);

  const toggle = useCallback(
    (id: string, range = false) => {
      // Read before reassigning: the updater runs later, during render.
      const from = anchor.current;
      setSelected((prev) => toggleSelection(prev, order, id, from, range));
      anchor.current = id;
    },
    [order],
  );
  const selectAll = useCallback((ids: readonly string[] = order) => setSelected(new Set(ids)), [order]);
  const clear = useCallback(() => setSelected(new Set()), []);
  const setMode = useCallback((on: boolean) => {
    setSelecting(on);
    if (!on) {
      setSelected(new Set());
      anchor.current = null;
    }
  }, []);

  const allSelected = order.length > 0 && order.every((id) => selected.has(id));
  return { selecting, setMode, selected, toggle, selectAll, clear, allSelected };
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Escape leaves selection mode and Ctrl/Cmd+A selects everything. Ignored while typing or while a
 * dialog or menu is open, which own those keys. With `scope`, only while focus is inside it.
 */
export function useSelectionKeys(
  active: boolean,
  { onExit, onSelectAll, scope }: { onExit: () => void; onSelectAll: () => void; scope?: RefObject<HTMLElement | null> },
) {
  const handlers = useRef({ onExit, onSelectAll });
  handlers.current = { onExit, onSelectAll };
  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu]")) return;
      if (scope && !scope.current?.contains(document.activeElement)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        handlers.current.onExit();
      } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        handlers.current.onSelectAll();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [active, scope]);
}

/** The "Select" / "Done" switch that enters and leaves selection mode. */
export function SelectModeToggle({ selecting, onChange, disabled }: { selecting: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <Button
      variant={selecting ? "default" : "outline"}
      size="sm"
      aria-pressed={selecting}
      disabled={disabled}
      onClick={() => onChange(!selecting)}
      className="pointer-coarse:h-10 pointer-coarse:px-4"
    >
      {selecting ? <XIcon /> : <ListChecksIcon />} {selecting ? "Done" : "Select"}
    </Button>
  );
}

/**
 * Floating bar pinned to the bottom of a page while selecting: count, select all, and actions.
 * `children` are the actions; they should disable themselves when nothing is selected.
 */
export function FloatingSelectionBar({
  count,
  allSelected,
  selectAllBusy = false,
  onSelectAll,
  onClear,
  error,
  children,
}: {
  count: number;
  allSelected: boolean;
  selectAllBusy?: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="pointer-events-none sticky bottom-[max(1rem,env(safe-area-inset-bottom))] z-20 flex justify-center">
      <div
        role="toolbar"
        aria-label={t("ui.selectionActions")}
        className="dropdown-glass depth-float animate-rise-in pointer-events-auto flex max-w-full flex-col gap-1.5 rounded-2xl border p-1.5"
      >
        {error && <p role="alert" className="text-destructive px-2 pt-1 text-xs">{error}</p>}
        <div className="flex flex-wrap items-center gap-1">
          <span className="px-2 text-sm font-medium tabular-nums">{t("ui.selectedCount", { count })}</span>
          <Button variant="ghost" size="sm" disabled={selectAllBusy} onClick={allSelected ? onClear : onSelectAll} className="pointer-coarse:h-10">
            {selectAllBusy ? <Loader2Icon className="animate-spin" /> : <SelectionCheck checked={allSelected} indeterminate={count > 0} className="size-3.5" />}
            {allSelected ? t("ui.deselectAll") : t("common.selectAll")}
          </Button>
          <span aria-hidden className="bg-border mx-0.5 h-5 w-px" />
          {children}
        </div>
      </div>
      <span aria-live="polite" className="sr-only">
        {t("ui.itemsSelected", { count })}
      </span>
    </div>
  );
}

/** Confirms a bulk deletion. Stays open with the error when some or all deletes fail. */
export function BulkDeleteDialog({
  open,
  title,
  description,
  confirmLabel,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("ui.deleteSelectionFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && (setError(null), onOpenChange(next))}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <DialogClose disabled={busy} render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy && <Loader2Icon className="animate-spin" />} {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
