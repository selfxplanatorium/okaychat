import { interpolate, template, type MessageKey } from "@/i18n";

type Slot = "morning" | "afternoon" | "evening" | "night";

// `{name}` becomes the user's name. Lines with it are skipped until the name is known.
const ANY = [
  "composer.welcomeAny1",
  "composer.welcomeAny2",
  "composer.welcomeAny3",
  "composer.welcomeAny4",
  "composer.welcomeAny5",
  "composer.welcomeAny6",
  "composer.welcomeAny7",
  "composer.welcomeAny8",
] as const satisfies readonly MessageKey[];

const BY_SLOT = {
  morning: [
    "composer.welcomeMorning1",
    "composer.welcomeMorning2",
    "composer.welcomeMorning3",
    "composer.welcomeMorning4",
    "composer.welcomeMorning5",
    "composer.welcomeMorning6",
  ],
  afternoon: [
    "composer.welcomeAfternoon1",
    "composer.welcomeAfternoon2",
    "composer.welcomeAfternoon3",
    "composer.welcomeAfternoon4",
    "composer.welcomeAfternoon5",
    "composer.welcomeAfternoon6",
  ],
  evening: [
    "composer.welcomeEvening1",
    "composer.welcomeEvening2",
    "composer.welcomeEvening3",
    "composer.welcomeEvening4",
    "composer.welcomeEvening5",
    "composer.welcomeEvening6",
  ],
  night: [
    "composer.welcomeNight1",
    "composer.welcomeNight2",
    "composer.welcomeNight3",
    "composer.welcomeNight4",
    "composer.welcomeNight5",
    "composer.welcomeNight6",
  ],
} as const satisfies Record<Slot, readonly MessageKey[]>;

function slotFor(hour: number): Slot {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

export function pickWelcomeLine(name: string | undefined, now: Date = new Date()): string {
  const keys: readonly MessageKey[] = [...ANY, ...BY_SLOT[slotFor(now.getHours())]];
  const lines = keys.filter((key) => name || !template(key).includes("{name}"));
  const key = lines[Math.floor(Math.random() * lines.length)] ?? ANY[0];
  return interpolate(template(key), name ? { name } : undefined);
}
