import { useEffect, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { t } from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChannels } from "@/state/channels";

/** Starts a 1:1 or small-group conversation by exact email; only accounts sharing a group are found. */
export function ChannelDmDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<Array<{ id: string; name: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [miss, setMiss] = useState(false);
  const error = useChannels((state) => state.error);

  useEffect(() => {
    if (open) return;
    setEmail("");
    setChosen([]);
    setMiss(false);
  }, [open]);

  const search = async () => {
    const query = email.trim();
    if (!query || chosen.length >= 7) return;
    setSearching(true);
    setMiss(false);
    const found = await useChannels.getState().lookupPeople(query);
    const person = found.find((item) => !chosen.some((other) => other.id === item.id));
    if (person) {
      setChosen((current) => [...current, person]);
      setEmail("");
    } else {
      setMiss(true);
    }
    setSearching(false);
  };

  const create = async () => {
    if (!chosen.length) return;
    setBusy(true);
    const id = await useChannels.getState().createDm(chosen.map((person) => person.id));
    setBusy(false);
    if (id) {
      setChosen([]);
      setEmail("");
      onOpenChange(false);
      onCreated(id);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("channels.newDm")}</DialogTitle>
          <DialogDescription>{t("channels.dmSharedGroupRequired")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("channels.dmTo")}
            <div className="flex gap-1">
              <Input
                value={email}
                type="email"
                autoComplete="off"
                placeholder={t("channels.dmSearchPlaceholder")}
                aria-label={t("channels.dmSearchPlaceholder")}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setMiss(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void search();
                  }
                }}
              />
              <Button type="button" variant="outline" disabled={!email.trim() || searching || chosen.length >= 7} onClick={() => void search()}>
                <PlusIcon aria-hidden /> {t("channels.dmAddPeople")}
              </Button>
            </div>
          </label>
          {miss && <p className="text-muted-foreground text-xs">{t("channels.dmNoMatch")}</p>}
          {chosen.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label={t("channels.dmTo")}>
              {chosen.map((person) => (
                <li key={person.id} className="border-border bg-muted/50 flex items-center gap-1 rounded-lg border px-1.5 py-1 text-xs">
                  <span className="max-w-48 truncate">{person.name}</span>
                  <button
                    type="button"
                    aria-label={t("channels.attachmentRemove", { name: person.name })}
                    onClick={() => setChosen((current) => current.filter((item) => item.id !== person.id))}
                    className="text-muted-foreground hover:text-foreground rounded p-1 pointer-coarse:p-2"
                  >
                    <XIcon aria-hidden className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {chosen.length >= 7 && <p className="text-muted-foreground text-xs">{t("channels.dmFull")}</p>}
          {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("channels.cancel")}</Button>
          <Button type="button" disabled={!chosen.length || busy} onClick={() => void create()}>{t("channels.newDm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
