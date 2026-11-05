import { onPermissionChange } from "../permissions/audit.js";

// Knowledge revocation is separate from the team-channel aggregate: it tracks the work that can still
// release shared collection content, and stops it when the authority behind it changes. An entry carries a
// re-check instead of a captured "allowed" bit, because a cached decision is never a lease.

interface Registration {
  controller: AbortController;
  /** Called after a change commits. Returning false aborts and forgets the operation. */
  revalidate: () => boolean;
}

const registrations = new Set<Registration>();
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  // Every audited permission/policy commit (membership edits, provider deletion, demotion paths that use the
  // workspace) bumps the global revision. Re-check rather than guessing which listener caused it.
  onPermissionChange(() => requestKnowledgeRevocation());
}

/**
 * Registers an active retrieval, restricted-chat turn, or owner ingest. The caller keeps the controller and
 * must release it when the operation settles; an aborted controller is removed here immediately so a late
 * permission change cannot abort unrelated work.
 */
export function registerKnowledgeOperation(controller: AbortController, revalidate: () => boolean): () => void {
  install();
  const entry: Registration = { controller, revalidate };
  registrations.add(entry);
  return () => registrations.delete(entry);
}

/**
 * Re-evaluates every live registration. Anything whose authority is gone is aborted; work that is already
 * settled has removed itself, so a no-op audience write does not touch it.
 */
export function requestKnowledgeRevocation(): void {
  for (const entry of [...registrations]) {
    let allowed = false;
    try {
      allowed = entry.revalidate();
    } catch {
      allowed = false;
    }
    if (allowed) continue;
    registrations.delete(entry);
    entry.controller.abort();
  }
}

/** Test seam: drops every registration so one suite cannot leak a controller into the next. */
export function resetKnowledgeRevocationsForTests(): void {
  registrations.clear();
}
