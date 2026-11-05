import { SOURCE } from "./catalog-rules.js";

/**
 * English-identical entries a reviewer accepted on purpose: API parameter literals, protocol names,
 * product names, shell commands, URL placeholders and units that are the same word in the target
 * language. Every other identical entry with a sentence-like shape fails the shipping gate.
 */
const REVIEWED_IDENTICAL: Record<string, readonly string[]> = {
  fr: [
    "agents.protocolChatTrigger",
    "apiAccess.paramModel",
    "apiAccess.paramMessages",
    "apiAccess.paramReasoning",
    "knowledge.urlPlaceholder",
    "mcp.transportHttp",
    "providers.chatgptRunCommand",
    "providers.ollamaAddressPlaceholder",
    "schedules.interval15",
    "schedules.interval30",
    "voice.callEngineRealtime",
  ],
  it: [
    "agents.protocolChatTrigger",
    "apiAccess.paramModel",
    "apiAccess.paramMessages",
    "apiAccess.paramReasoning",
    "keyboard.conflictScreenshotFirefox",
    "knowledge.urlPlaceholder",
    "mcp.transportHttp",
    "mcp.transportSse",
    "providers.chatgptRunCommand",
    "providers.ollamaAddressPlaceholder",
    "voice.browserVoiceOnline",
    "voice.callEngineRealtime",
  ],
  "pt-PT": [
    "agents.protocolChatTrigger",
    "apiAccess.paramModel",
    "apiAccess.paramMessages",
    "apiAccess.paramReasoning",
    "email.stageThunderbird",
    "knowledge.urlPlaceholder",
    "mcp.transportHttp",
    "projects.fileTokens",
    "providers.chatgptRunCommand",
    "providers.ollamaAddressPlaceholder",
    "voice.browserVoiceOnline",
    "voice.callEngineRealtime",
  ],
};

/**
 * Finds sentence-like English text left unchanged in a target catalog. Placeholders, separators and
 * all-caps technical tokens are stripped first, so `{gpu} · CUDA {version}` is not prose while an
 * untranslated instruction is. Single-word cognates are out of scope; the key scanner and a human
 * review cover those. Coverage (missing keys) is a separate gate.
 */
export function englishProseLeft(tag: string, translation: unknown, source: Record<string, Record<string, unknown>> = SOURCE): string[] {
  const accepted = new Set(REVIEWED_IDENTICAL[tag] ?? []);
  const problems: string[] = [];
  const catalog = translation as Record<string, Record<string, unknown>> | null;
  if (!catalog || typeof catalog !== "object") return problems;
  for (const [ns, entries] of Object.entries(source)) {
    const translated = catalog[ns];
    if (!translated || typeof translated !== "object") continue;
    for (const [key, english] of Object.entries(entries)) {
      const value = translated[key];
      if (typeof english !== "string" || typeof value !== "string" || english !== value) continue;
      const residual = english.replace(/\{[^}]*\}/g, " ").replace(/[·—×/]/g, " ").trim();
      if (!/\s/.test(residual) || !/[a-z]{4,}/.test(residual)) continue;
      const id = `${ns}.${key}`;
      if (!accepted.has(id)) problems.push(`${tag}: ${id} is still English`);
    }
  }
  return problems;
}
