/**
 * Toggles `id` in a selection. With `range` and an anchor still in `order`, every id between the
 * anchor and `id` takes the state `id` is switching to, like Shift+click in a file manager.
 */
export function toggleSelection(
  selected: ReadonlySet<string>,
  order: readonly string[],
  id: string,
  anchor: string | null,
  range: boolean,
): Set<string> {
  const next = new Set(selected);
  const on = !selected.has(id);
  const from = range && anchor !== null ? order.indexOf(anchor) : -1;
  const to = order.indexOf(id);
  const ids = from >= 0 && to >= 0 ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
  for (const each of ids) {
    if (on) next.add(each);
    else next.delete(each);
  }
  return next;
}

/** Drops ids that left `order` (deleted, filtered out), keeping the same set when nothing changed. */
export function pruneSelection(selected: ReadonlySet<string>, order: readonly string[]): ReadonlySet<string> {
  const valid = new Set(order);
  const next = new Set([...selected].filter((id) => valid.has(id)));
  return next.size === selected.size ? selected : next;
}

/** Runs `task` over `items` a few at a time, so a large selection does not flood the server. */
export async function runBatch<T>(items: readonly T[], task: (item: T) => unknown, concurrency = 4) {
  const failed: T[] = [];
  const queue = [...items];
  let error: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        try {
          await task(item);
        } catch (cause) {
          failed.push(item);
          error ??= cause;
        }
      }
    }),
  );
  return { failed, error };
}

/** One line for a bulk action that partly or fully failed; `verb` is e.g. "delete". */
export function batchError(failed: number, total: number, verb: string, error: unknown) {
  const reason = error instanceof Error && error.message ? ` ${error.message}` : "";
  return failed === total ? `Could not ${verb} the selection.${reason}` : `${failed} of ${total} could not ${verb}.${reason}`;
}
