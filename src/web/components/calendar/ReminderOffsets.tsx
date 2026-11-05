import { PlusIcon, XIcon } from "lucide-react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_REMINDERS, MAX_REMINDER_OFFSET_MINUTES } from "@shared/calendar";

/** Up to five unique reminder offsets in minutes, sorted for canonical storage. */
export function ReminderOffsets({
  offsets,
  onChange,
  allDay,
  zone,
  disabled,
}: {
  offsets: number[];
  onChange: (offsets: number[]) => void;
  allDay: boolean;
  zone: string;
  disabled?: boolean;
}) {
  const update = (index: number, value: number) => {
    const next = [...offsets];
    next[index] = value;
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("calendar.reminders")}</span>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || offsets.length >= MAX_REMINDERS}
          onClick={() => onChange([...offsets, 0])}
        >
          <PlusIcon aria-hidden /> {t("calendar.addReminder")}
        </Button>
      </div>
      {!offsets.length && <p className="text-muted-foreground text-xs">{t("calendar.noReminders")}</p>}
      <ul className="flex flex-col gap-1.5">
        {offsets.map((offset, index) => (
          <li key={`${index}-${offset}`} className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={MAX_REMINDER_OFFSET_MINUTES}
              value={offset}
              disabled={disabled}
              aria-label={t("calendar.offsetMinutes", { count: offset })}
              onChange={(event) => {
                const value = Number(event.target.value);
                update(index, Number.isFinite(value) ? Math.max(0, Math.min(MAX_REMINDER_OFFSET_MINUTES, Math.trunc(value))) : 0);
              }}
              className="h-8 w-28"
            />
            <span className="text-muted-foreground text-xs">{offset === 0 ? t("calendar.atStart") : t("calendar.offsetMinutes", { count: offset })}</span>
            <Button size="icon-xs" variant="ghost" disabled={disabled} aria-label={t("calendar.removeReminder")} onClick={() => onChange(offsets.filter((_, at) => at !== index))}>
              <XIcon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      {allDay && <p className="text-muted-foreground text-xs">{t("calendar.allDayReminder", { zone })}</p>}
      <p className="text-muted-foreground text-xs">{t("calendar.reminderHelp")}</p>
    </div>
  );
}
