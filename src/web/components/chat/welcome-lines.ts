type Slot = "morning" | "afternoon" | "evening" | "night";

// `{name}` becomes the user's name. Lines with it are skipped until the name is known.
const ANY = [
  "What should we work on?",
  "What are you working on?",
  "Where do we start?",
  "What's on your mind?",
  "What do you need done?",
  "Ask me anything.",
  "What would you like to figure out?",
  "What's the problem today?",
  "What are we untangling today?",
  "What's the next thing on the list?",
  "What can I help you ship?",
];

const BY_SLOT: Record<Slot, string[]> = {
  morning: [
    "Good morning, {name}. What's first?",
    "Morning. What are we starting with?",
    "What's the plan for this morning?",
    "Coffee first, then what?",
    "Fresh start. What do you need?",
    "What's on the agenda this morning?",
    "Early start. Where should we begin?",
    "Morning, {name}. What's on your list?",
  ],
  afternoon: [
    "Good afternoon, {name}. What's next?",
    "Afternoon. What needs attention?",
    "What's left on today's list?",
    "How's the day going? What can I take off your plate?",
    "What's the next step this afternoon?",
    "Halfway through the day. What's next?",
    "What's blocking you this afternoon?",
    "Good afternoon. What should we tackle?",
  ],
  evening: [
    "Good evening, {name}. What's on your mind?",
    "Evening. What are we wrapping up?",
    "What's left to finish before tonight?",
    "Winding down? What can we close out?",
    "What would you like to sort out this evening?",
    "Evening, {name}. What's still open?",
    "Anything to finish before the day ends?",
    "What's the last thing on your list tonight?",
  ],
  night: [
    "Still up, {name}? What do you need?",
    "Late one. What should we look at?",
    "What can I help with before bed?",
    "Quiet hours. What's on your mind?",
    "Late session. What's the task?",
    "Up late? Tell me what needs doing.",
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
