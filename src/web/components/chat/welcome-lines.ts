type Slot = "morning" | "afternoon" | "evening" | "night";

// `{name}` becomes the user's name. Lines with it are skipped until the name is known.
const ANY = [
  "Tell me the plan. I'll supply the foreseeable consequences.",
  "Your half-baked idea is welcome here.",
  "{name}, how much of this plan is held together by optimism?",
  "{name}, let's hear the idea before common sense gets here.",
  "Okay, {name}. What's the plan we're calling reasonable?",
  "This sounds like a future us problem. Let's interfere.",
  "How much trouble can one little question cause?",
  "We can start with the sensible idea, if you brought one.",
];

const BY_SLOT: Record<Slot, string[]> = {
  morning: [
    "Morning, {name}. Have we tried coffee before strategy?",
    "Morning, {name}. Let's make a plan before the inbox does.",
    "Coffee first. Grand schemes second.",
    "Good morning. The to-do list has been making demands.",
    "New day. Same suspiciously optimistic estimates.",
    "Let's see what survived yesterday's 'I'll do it tomorrow.'",
  ],
  afternoon: [
    "Afternoon already. Rude.",
    "{name}, there's still time for a small, manageable plot twist.",
    "Afternoon, {name}. Shall we negotiate with the to-do list?",
    "The afternoon slump has requested a meeting. Declined.",
    "We still have time. Depending on what you're about to ask.",
    "Lunch is over. Apparently the tasks aren't.",
  ],
  evening: [
    "Evening, {name}. One quick thing, allegedly.",
    "{name}, what are we squeezing in before 'definitely stopping'?",
    "Let's wrap this up before it develops a sequel.",
    "Today's loose ends have formed a committee.",
    "Just one more thing. Famous last words.",
    "Evening. How did the side quest go?",
  ],
  night: [
    "This had better be a good idea. It's past our bedtime.",
    "Ah, the hour when buying a domain feels reasonable.",
    "Still up, {name}? Let's keep the domain purchases supervised.",
    "{name}, is this a tomorrow problem wearing a fake mustache?",
    "The sensible ideas went to bed. What have you got?",
    "Let's write it down before morning asks for evidence.",
  ],
};

function slotFor(hour: number): Slot {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

export function pickWelcomeLine(name: string | undefined, now: Date = new Date()): string {
  const lines = [...ANY, ...BY_SLOT[slotFor(now.getHours())]].filter((line) => name || !line.includes("{name}"));
  const line = lines[Math.floor(Math.random() * lines.length)] ?? ANY[0] ?? "How can I help?";
  return name ? line.replace("{name}", name) : line;
}
