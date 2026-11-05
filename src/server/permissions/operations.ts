import type { FeatureKey } from "../../shared/permissions.js";

// Every costly boundary that charges one operation (§2.4). Local reads, status, stream reconnects, token
// refreshes, transport fallbacks inside one web query, and cleanup are not operations.

export const OPERATIONS = {
  "llm.call": { feature: null, description: "One upstream model generate/stream attempt, including retries" },
  "web.search": { feature: "webSearch", description: "One built-in web search query" },
  "web.fetch": { feature: "webFetch", description: "One built-in page read" },
  "sandbox.run": { feature: "code", description: "One sandbox run" },
  "image.generate": { feature: "images", description: "One image generation request" },
  "mcp.connect": { feature: "mcp", description: "One MCP connection attempt (connect + discovery)" },
  "mcp.call": { feature: "mcp", description: "One MCP tool, resource, or prompt invocation" },
  "knowledge.embed": { feature: "knowledge", description: "One embedding batch" },
  "email.remote": { feature: "email", description: "One discovery, test, mailbox action, or send" },
  "speech.synthesize": { feature: "voice", description: "One speech synthesis" },
  "speech.transcribe": { feature: "voice", description: "One transcription" },
  "voice.session": { feature: "voice", description: "A voice call or Realtime signalling session" },
  "browser.render": { feature: "artifacts", description: "One browser worker render" },
} as const satisfies Record<string, { feature: FeatureKey | null; description: string }>;

export type OperationKey = keyof typeof OPERATIONS;
