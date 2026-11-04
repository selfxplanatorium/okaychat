/** The Details popover under each assistant reply: stored model, token, cost, and time values. */
export default {
  open: "Details",
  title: "Reply details",
  model: "Model",
  input: "Total input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Total output",
  reasoning: "Reasoning tokens",
  cost: "Estimated cost",
  duration: "Elapsed time",
  notReported: "Not reported",
  totalsHelp: "Token totals cover all generation steps. Context fill uses only the final step.",
  cacheHelp: "Cache tokens are part of total input, and reasoning tokens are part of total output.",
  originalGeneration: "Usage describes the original generation.",
} as const;
