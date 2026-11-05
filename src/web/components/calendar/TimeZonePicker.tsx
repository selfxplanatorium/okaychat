import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

function knownZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return ["UTC", ...supported.filter((zone) => zone !== "UTC")];
  } catch {
    return ["UTC", "Europe/Rome", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];
  }
}

/** Searchable zone picker. The current event zone and UTC are always present. */
export function TimeZonePicker({ value, onChange, disabled }: { value: string; onChange: (zone: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const zones = useMemo(() => {
    const all = knownZones();
    if (!all.includes(value)) all.unshift(value);
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((zone) => zone.toLowerCase().includes(needle)).slice(0, 200) : all;
  }, [value, query]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="justify-between gap-2 font-normal" disabled={disabled} aria-label={t("calendar.timeZone")} data-command="calendar.zone" />}>
        <span className="truncate">{value}</span>
        <ChevronsUpDownIcon aria-hidden className="text-muted-foreground size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2">
        <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("calendar.zoneSearch")} aria-label={t("calendar.zoneSearch")} />
        <ScrollArea className="mt-2 max-h-64">
          <ul role="listbox" aria-label={t("calendar.timeZone")} className="flex flex-col gap-0.5 p-0.5">
            {zones.map((zone) => (
              <li key={zone}>
                <button
                  type="button"
                  role="option"
                  aria-selected={zone === value}
                  onClick={() => {
                    onChange(zone);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="hover:bg-muted flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-start text-sm pointer-coarse:min-h-11"
                >
                  <span className="truncate">{zone}</span>
                  {zone === value && <CheckIcon aria-hidden className="size-4" />}
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
