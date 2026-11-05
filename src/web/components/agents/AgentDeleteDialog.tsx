import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { N8nAgentSummary } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import { t } from "@/i18n";
import { agentErrorText } from "./agent-error";
import type { AgentScope } from "./AgentEditor";

const basePath = (scope: AgentScope) => (scope === "shared" ? "/admin/agents/n8n" : "/agents/n8n");

/**
 * Deleting a definition never deletes chats or their messages. The revision is sent with the request, so
 * a definition changed in another tab is not removed by a stale dialog.
 */
export function AgentDeleteDialog({
  agent,
  scope,
  onClose,
  onDeleted,
}: {
  agent: N8nAgentSummary | null;
  scope: AgentScope;
  onClose: () => void;
  onDeleted: (agent: N8nAgentSummary) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // Keep the last agent while the dialog animates out.
  const [shown, setShown] = useState(agent);
  if (agent && agent !== shown) {
    setShown(agent);
    setError(null);
    setConflict(false);
  }
  useEffect(() => {
    if (!agent) setBusy(false);
  }, [agent]);

  const remove = async () => {
    if (!shown || busy) return;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      await api(`${basePath(scope)}/${encodeURIComponent(shown.id)}`, { method: "DELETE", json: { revision: shown.revision } });
      onDeleted(shown);
      onClose();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) setConflict(true);
      else setError(agentErrorText(failure).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={agent !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("agents.deleteTitle", { name: shown?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("agents.deleteBody")}</DialogDescription>
        </DialogHeader>
        {conflict && (
          <p role="alert" className="text-warning flex items-start gap-1.5 text-xs">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {t("agents.conflict")}
          </p>
        )}
        {error && !conflict && <p role="alert" className="text-destructive text-xs wrap-break-word">{error}</p>}
        <DialogFooter>
          <DialogClose type="button" disabled={busy} render={<Button variant="outline" className="min-h-10 pointer-coarse:min-h-11" />}>
            {t("agents.cancel")}
          </DialogClose>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()} className="min-h-10 pointer-coarse:min-h-11">
            {busy && <Loader2Icon className="animate-spin motion-reduce:animate-none" />}
            {t("agents.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
