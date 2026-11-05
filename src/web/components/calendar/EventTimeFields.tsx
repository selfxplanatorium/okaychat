import type { CalendarTimeCandidate } from "@shared/calendar";
import { formatInZone } from "@shared/calendar-time";
import { t } from "@/i18n";
import { Input } from "@/components/ui/input";

function CandidateChoices({
  candidates,
  selected,
  onSelect,
  label,
  zone,
}: {
  candidates: CalendarTimeCandidate[];
  selected: number | null;
  onSelect: (at: number) => void;
  label: string;
  zone: string;
}) {
  if (candidates.length !== 2) return null;
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-muted-foreground text-xs">{label}</legend>
      {candidates.map((candidate) => {
        const parts = formatInZone(zone, candidate.at);
        return (
          <label key={candidate.at} className="flex min-h-8 items-center gap-2 text-sm">
            <input type="radio" name={label} checked={selected === candidate.at} onChange={() => onSelect(candidate.at)} />
            {t("calendar.offsetChoice", { time: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`, offset: candidate.label })}
          </label>
        );
      })}
    </fieldset>
  );
}

/** Start/end controls. Timed fields are local clock strings; the dialog resolves them to instants. */
export function EventTimeFields({
  allDay,
  timeZone,
  startLocal,
  endLocal,
  startDate,
  endDate,
  startCandidates,
  endCandidates,
  selectedStart,
  selectedEnd,
  onStartLocal,
  onEndLocal,
  onStartDate,
  onEndDate,
  onSelectStart,
  onSelectEnd,
  disabled,
}: {
  allDay: boolean;
  timeZone: string;
  startLocal: string;
  endLocal: string;
  startDate: string;
  endDate: string;
  startCandidates: CalendarTimeCandidate[];
  endCandidates: CalendarTimeCandidate[];
  selectedStart: number | null;
  selectedEnd: number | null;
  onStartLocal: (value: string) => void;
  onEndLocal: (value: string) => void;
  onStartDate: (value: string) => void;
  onEndDate: (value: string) => void;
  onSelectStart: (at: number) => void;
  onSelectEnd: (at: number) => void;
  disabled?: boolean;
}) {
  if (allDay) {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("calendar.start")}</span>
          <Input type="date" value={startDate} disabled={disabled} onChange={(event) => onStartDate(event.target.value)} aria-label={t("calendar.start")} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("calendar.endExclusive")}</span>
          <Input type="date" value={endDate} disabled={disabled} onChange={(event) => onEndDate(event.target.value)} aria-label={t("calendar.endExclusive")} />
        </label>
      </div>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("calendar.start")}</span>
          <Input type="datetime-local" value={startLocal} disabled={disabled} onChange={(event) => onStartLocal(event.target.value)} aria-label={t("calendar.start")} />
        </label>
        {startCandidates.length === 0 && <p role="alert" className="text-destructive text-xs">{t("calendar.gap", { zone: timeZone })}</p>}
        <CandidateChoices candidates={startCandidates} selected={selectedStart} onSelect={onSelectStart} label={t("calendar.fold")} zone={timeZone} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("calendar.end")}</span>
          <Input type="datetime-local" value={endLocal} disabled={disabled} onChange={(event) => onEndLocal(event.target.value)} aria-label={t("calendar.end")} />
        </label>
        {endCandidates.length === 0 && <p role="alert" className="text-destructive text-xs">{t("calendar.gap", { zone: timeZone })}</p>}
        <CandidateChoices candidates={endCandidates} selected={selectedEnd} onSelect={onSelectEnd} label={t("calendar.fold")} zone={timeZone} />
      </div>
    </div>
  );
}
