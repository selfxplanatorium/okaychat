import { useEffect, useState } from "react";
import type { RoomArchiveIdentityRosterItem } from "@shared/room-archive";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { useRoomArchives } from "@/state/room-archives";

/**
 * The historical roster is a separate, paged list. It never joins live members, the mention picker,
 * presence, or account lookups: recognized accounts show their current local name, everyone else is a
 * neutral "Imported member".
 */
export function RoomArchiveRoster({ jobId }: { jobId: string }) {
  const roster = useRoomArchives((state) => state.roster);
  const [items, setItems] = useState<RoomArchiveIdentityRosterItem[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setItems([]);
    setAfter(null);
    setLoading(true);
    void roster(jobId).then((page) => {
      if (!live || !page) return;
      setItems(page.items);
      setAfter(page.nextAfter);
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [jobId, roster]);

  const more = async () => {
    if (!after || loading) return;
    setLoading(true);
    const page = await roster(jobId, after);
    if (page) {
      setItems((current) => [...current, ...page.items]);
      setAfter(page.nextAfter);
    }
    setLoading(false);
  };

  if (!items.length && !loading) return null;
  return (
    <section className="flex flex-col gap-1" aria-label={t("roomArchives.importedRoster")}>
      <h4 className="text-xs font-medium">{t("roomArchives.importedRoster")}</h4>
      <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto pe-1">
        {items.map((item) => (
          <li key={item.key} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate">{item.recognizedName ?? item.historicalName ?? t("roomArchives.unknownAuthor")}</span>
            <span className="text-muted-foreground shrink-0">
              {item.role === "owner" ? t("channels.owner") : item.role === "moderator" ? t("channels.moderator") : item.role === "member" ? t("channels.member") : ""}
            </span>
            {item.recognizedName && <span className="text-muted-foreground shrink-0">{t("roomArchives.importedHistory")}</span>}
          </li>
        ))}
      </ul>
      {after && (
        <Button type="button" size="xs" variant="ghost" className="self-start" disabled={loading} onClick={() => void more()}>
          {t("roomArchives.showMore")}
        </Button>
      )}
    </section>
  );
}
