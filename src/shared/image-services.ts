/** Image generation backends. See docs/research/image-generation.md. */
export type ImageServiceId = "codex" | "openai" | "google" | "xai" | "togetherai" | "black-forest-labs" | "fal" | "replicate";

export interface ImageServiceDef {
  id: ImageServiceId;
  name: string;
  /**
   * Where the credential comes from: the Codex login, the chat provider connection of the same id
   * (one key covers chat and images), or a key entered only for images.
   */
  credential: "codex" | "provider" | "own";
  /**
   * Built-in models, best first. The first is the default. The picker lists the provider's own models
   * instead whenever it can fetch them.
   */
  models: string[];
  keyUrl?: string;
}

export const IMAGE_SERVICES: ImageServiceDef[] = [
  { id: "codex", name: "ChatGPT plan (Codex)", credential: "codex", models: [] },
  { id: "openai", name: "OpenAI", credential: "provider", models: ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-1.5", "gpt-image-1-mini"] },
  { id: "google", name: "Google Gemini", credential: "provider", models: ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview", "gemini-nano-banana-2.1", "gemini-2.5-flash-image"] },
  { id: "xai", name: "xAI Grok", credential: "provider", models: ["grok-imagine-image-2.0", "grok-imagine-image-pro", "grok-imagine-image"] },
  { id: "togetherai", name: "Together AI", credential: "provider", models: ["black-forest-labs/FLUX.1.1-pro", "black-forest-labs/FLUX.1-kontext-pro", "black-forest-labs/FLUX.1-schnell"] },
  { id: "black-forest-labs", name: "Black Forest Labs (FLUX)", credential: "own", models: ["flux-3-image", "flux-3-image-klein", "flux-kontext-pro", "flux-pro-1.1-ultra"], keyUrl: "https://dashboard.bfl.ai/keys" },
  { id: "fal", name: "fal", credential: "own", models: ["fal-ai/flux-pro/kontext", "fal-ai/flux-pro/v1.1-ultra", "fal-ai/recraft/v3/text-to-image", "fal-ai/imagen4/preview", "fal-ai/qwen-image"], keyUrl: "https://fal.ai/dashboard/keys" },
  { id: "replicate", name: "Replicate", credential: "own", models: ["black-forest-labs/flux-2-pro", "black-forest-labs/flux-1.1-pro-ultra", "ideogram-ai/ideogram-v2", "recraft-ai/recraft-v3", "stability-ai/stable-diffusion-3.5-large"], keyUrl: "https://replicate.com/account/api-tokens" },
];

export const imageServiceDef = (id: string) => IMAGE_SERVICES.find((s) => s.id === id);

/** Image-only keys live beside provider connections under this prefix, so they share encryption and admin sharing. */
export const imageConnectionId = (def: ImageServiceDef) => (def.credential === "own" ? `image-${def.id}` : def.id);

/** Per-account choices. A connected service is enabled unless switched off. */
export type ImageServiceSettings = Partial<Record<ImageServiceId, { enabled?: boolean; model?: string }>>;

export interface ImageServiceStatus {
  id: ImageServiceId;
  name: string;
  credential: ImageServiceDef["credential"];
  keyUrl?: string;
  connected: boolean;
  /** The key comes from an admin's server-wide connection. */
  shared: boolean;
  enabled: boolean;
  model: string | null;
}

export interface ImageModelOption {
  id: string;
  name?: string;
}

export interface ImageModelList {
  models: ImageModelOption[];
  /** False when the built-in list is shown because the provider has no list endpoint or failed. */
  live: boolean;
  error?: string;
}
