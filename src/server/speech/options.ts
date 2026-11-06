import { sttEngineDef, ttsEngineDef, type SpeechOption, type SpeechOptionList } from "../../shared/speech.js";
import { sha256 } from "../crypto.js";
import { connectionDigest } from "../catalog/provider-config.js";
import { azureRegion, credentialFor, upstream, type ResolvedCredential } from "./engines.js";
import { speechWorkerConfigured, workerVoices } from "./worker.js";

// Voice and model lists for the settings pickers, from each provider with the user's key, cached one hour per
// key and address. Any failure shows the built-in list with the reason. See docs/implementation/speech.md.

const TTL_MS = 60 * 60_000;
const cache = new Map<string, { list: SpeechOptionList; at: number }>();

type Row = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
/** Lists arrive as `data`, `items`, `voices`, `models`, or a bare array depending on the server. */
const rowsOf = (body: unknown): Row[] => {
  if (Array.isArray(body)) return body as Row[];
  const obj = (body ?? {}) as Row;
  for (const key of ["data", "items", "voices", "models"]) if (Array.isArray(obj[key])) return obj[key] as Row[];
  return [];
};

async function json(cred: ResolvedCredential, url: string, headers: Record<string, string>, label: string): Promise<unknown> {
  return (await upstream(cred, url, { headers }, label, AbortSignal.timeout(15_000))).json();
}

const bearer = (cred: ResolvedCredential): Record<string, string> => (cred.apiKey ? { Authorization: `Bearer ${cred.apiKey}` } : {});

async function openAiModels(cred: ResolvedCredential, label: string, match: RegExp): Promise<SpeechOption[]> {
  return rowsOf(await json(cred, `${cred.baseURL}/models`, bearer(cred), label)).flatMap((m) => {
    const id = str(m.id);
    return id && match.test(id) ? [{ id }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchOptions(kind: "stt" | "tts", engine: string, what: "models" | "voices", cred: ResolvedCredential): Promise<SpeechOption[] | null> {
  if (kind === "stt") {
    if (what !== "models") return null;
    switch (engine) {
      case "openai":
        return openAiModels(cred, "OpenAI", /transcri|whisper/);
      case "groq":
        return openAiModels(cred, "Groq", /whisper|transcri/);
      case "mistral":
        return openAiModels(cred, "Mistral", /voxtral.*(transcri|mini-latest|mini-2)/);
      case "openai-compatible":
        return openAiModels(cred, "The server", /./);
    }
    return null;
  }
  switch (`${engine}:${what}`) {
    case "local:voices":
      return speechWorkerConfigured() ? workerVoices() : null;
    case "openai:models":
      return openAiModels(cred, "OpenAI", /tts/);
    case "openai-realtime:models":
      return openAiModels(cred, "OpenAI", /^gpt-realtime(?!.*(translate|whisper))/);
    case "elevenlabs:voices": {
      const body = await json(cred, "https://api.elevenlabs.io/v2/voices?page_size=100", { "xi-api-key": cred.apiKey! }, "ElevenLabs");
      return rowsOf(body).flatMap((v) => {
        const id = str(v.voice_id);
        const labels = (v.labels ?? {}) as Row;
        return id ? [{ id, name: [str(v.name), str(labels.accent), str(labels.gender)].filter(Boolean).join(" · "), language: str(labels.language) }] : [];
      });
    }
    case "elevenlabs:models": {
      const body = await json(cred, "https://api.elevenlabs.io/v1/models", { "xi-api-key": cred.apiKey! }, "ElevenLabs");
      return rowsOf(body).flatMap((m) => (str(m.model_id) && m.can_do_text_to_speech !== false ? [{ id: str(m.model_id)!, name: str(m.name) }] : []));
    }
    case "azure:voices": {
      const region = azureRegion(cred);
      const body = await json(cred, `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { "Ocp-Apim-Subscription-Key": cred.apiKey! }, "Azure AI Speech");
      return rowsOf(body).flatMap((v) => {
        const id = str(v.ShortName);
        return id ? [{ id, name: `${str(v.DisplayName) ?? id} (${str(v.LocaleName) ?? str(v.Locale) ?? ""})`, language: str(v.Locale) }] : [];
      });
    }
    case "mistral:voices": {
      const body = await json(cred, `${cred.baseURL}/audio/voices?limit=100`, bearer(cred), "Mistral");
      return rowsOf(body).flatMap((v) => {
        const id = str(v.id) ?? str(v.voice_id);
        const languages = Array.isArray(v.languages) ? (v.languages as unknown[]).filter((l) => typeof l === "string").join(", ") : str(v.language);
        return id ? [{ id, name: [str(v.name), languages].filter(Boolean).join(" · "), language: languages }] : [];
      });
    }
    case "mistral:models":
      return openAiModels(cred, "Mistral", /tts/);
    case "openai-compatible:voices": {
      const body = await json(cred, `${cred.baseURL}/audio/voices`, bearer(cred), "The server");
      return (rowsOf(body) as unknown[]).flatMap((v): SpeechOption[] => {
        if (typeof v === "string") return [{ id: v }];
        const row = v as Row;
        const id = str(row.id) ?? str(row.voice_id);
        return id ? [{ id, name: str(row.name) }] : [];
      });
    }
    case "openai-compatible:models":
      return openAiModels(cred, "The server", /./);
  }
  return null;
}

export async function speechOptions(userId: string, kind: "stt" | "tts", engine: string, what: "models" | "voices"): Promise<SpeechOptionList> {
  const def = kind === "stt" ? sttEngineDef(engine) : ttsEngineDef(engine);
  if (!def) return { options: [], live: false, error: "Unknown engine." };
  const builtIn = (what === "models" ? def.models : "voices" in def ? (def.voices as string[]) : []).map((id) => ({ id }));
  const cred = credentialFor(userId, def.credential);
  if (!cred) return { options: builtIn, live: false, error: `Connect ${def.name} to load its list.` };
  // The connection digest covers any transport configuration as well as the key and address.
  const key = sha256(`${kind}:${engine}:${what}:${cred.apiKey ?? ""}:${cred.baseURL ?? ""}:${cred.conn ? connectionDigest(cred.conn) : ""}`);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
  let list: SpeechOptionList;
  try {
    const options = await fetchOptions(kind, engine, what, cred);
    list = options && options.length ? { options, live: true } : { options: builtIn, live: false };
  } catch (error) {
    // Only the reason, never a response body.
    return { options: builtIn, live: false, error: (error as Error).message.slice(0, 200) };
  }
  cache.set(key, { list, at: Date.now() });
  return list;
}
