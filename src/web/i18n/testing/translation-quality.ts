import { SOURCE } from "./catalog-rules.js";

/**
 * English-identical entries a reviewer accepted on purpose, bound to the exact reviewed English text:
 * API parameter literals, protocol names, product names, shell commands, URL placeholders and units that
 * are the same word in the target language. A key alone is not an exemption, so changing the English text
 * later cannot ride on an old decision.
 */
const REVIEWED_IDENTICAL: Record<string, Record<string, readonly string[]>> = {
  fr: {
    "agents.protocolChatTrigger": ["Chat Trigger"],
    "apiAccess.paramModel": ["provider/model"],
    "apiAccess.paramMessages": ["system, user, assistant"],
    "apiAccess.paramReasoning": ["none, minimal, low, medium, high, xhigh, max"],
    "knowledge.urlPlaceholder": ["https://example.com/guide"],
    "mcp.transportHttp": ["Streamable HTTP"],
    "providers.chatgptRunCommand": ["node chatgpt-connect.mjs {file}"],
    "providers.ollamaAddressPlaceholder": ["http://127.0.0.1:11434"],
    "schedules.interval15": ["15 minutes"],
    "schedules.interval30": ["30 minutes"],
    "voice.callEngineRealtime": ["OpenAI Realtime"],
  },
  it: {
    "agents.protocolChatTrigger": ["Chat Trigger"],
    "apiAccess.paramModel": ["provider/model"],
    "apiAccess.paramMessages": ["system, user, assistant"],
    "apiAccess.paramReasoning": ["none, minimal, low, medium, high, xhigh, max"],
    "keyboard.conflictScreenshotFirefox": ["screenshot (Firefox)"],
    "knowledge.urlPlaceholder": ["https://example.com/guide"],
    "mcp.transportHttp": ["Streamable HTTP"],
    "mcp.transportSse": ["SSE (legacy)"],
    "providers.chatgptRunCommand": ["node chatgpt-connect.mjs {file}"],
    "providers.ollamaAddressPlaceholder": ["http://127.0.0.1:11434"],
    "voice.browserVoiceOnline": ["{name} ({lang}) · online"],
    "voice.callEngineRealtime": ["OpenAI Realtime"],
  },
  "pt-PT": {
    "agents.protocolChatTrigger": ["Chat Trigger"],
    "apiAccess.paramModel": ["provider/model"],
    "apiAccess.paramMessages": ["system, user, assistant"],
    "apiAccess.paramReasoning": ["none, minimal, low, medium, high, xhigh, max"],
    "email.stageThunderbird": ["Thunderbird XML"],
    "knowledge.urlPlaceholder": ["https://example.com/guide"],
    "mcp.transportHttp": ["Streamable HTTP"],
    "projects.fileTokens": ["~{tokens} tokens"],
    "providers.chatgptRunCommand": ["node chatgpt-connect.mjs {file}"],
    "providers.ollamaAddressPlaceholder": ["http://127.0.0.1:11434"],
    "voice.browserVoiceOnline": ["{name} ({lang}) · online"],
    "voice.callEngineRealtime": ["OpenAI Realtime"],
  },
};

/**
 * Finds sentence-like English text left unchanged in a target catalog. Placeholders, separators and
 * all-caps technical tokens are stripped first, so `{gpu} · CUDA {version}` is not prose while an
 * untranslated instruction is. Single-word cognates are out of scope; the key scanner and a human
 * review cover those. Coverage (missing keys) is a separate gate.
 */
export function englishProseLeft(tag: string, translation: unknown, source: Record<string, Record<string, unknown>> = SOURCE): string[] {
  const accepted = REVIEWED_IDENTICAL[tag] ?? {};
  const problems: string[] = [];
  const catalog = translation as Record<string, Record<string, unknown>> | null;
  if (!catalog || typeof catalog !== "object") return problems;
  const prose = (text: string) => {
    const residual = text.replace(/\{[^}]*\}/g, " ").replace(/[·—×/]/g, " ").trim();
    return /\s/.test(residual) && /[a-z]{4,}/.test(residual);
  };
  const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
  const check = (id: string, english: string, value: string, form?: string) => {
    if (!same(english, value) || !prose(english)) return;
    if ((accepted[id] ?? []).includes(english)) return;
    problems.push(`${tag}: ${form ? `${id}.${form}` : id} is still English`);
  };
  for (const [ns, entries] of Object.entries(source)) {
    const translated = catalog[ns];
    if (!translated || typeof translated !== "object") continue;
    for (const [key, english] of Object.entries(entries)) {
      const value = translated[key];
      const id = `${ns}.${key}`;
      if (typeof english === "string") {
        if (typeof value === "string") check(id, english, value);
        continue;
      }
      if (!value || typeof value !== "object" || typeof english !== "object" || english === null) continue;
      // Forms English lacks (`many` in fr/it/pt-PT) are compared with English `other`.
      const englishForms = english as Record<string, unknown>;
      for (const [form, translatedForm] of Object.entries(value as Record<string, unknown>)) {
        const text = englishForms[form] ?? englishForms.other;
        if (typeof text === "string" && typeof translatedForm === "string") check(id, text, translatedForm, form);
      }
    }
  }
  return problems;
}
