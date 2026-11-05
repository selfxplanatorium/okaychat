# Image generation services

`generate_image` can use any service the user has connected and left switched on. Service definitions live in `src/shared/image-services.ts`; generation, the tool, and the routes are in `src/server/tools/image.ts`. Codex specifics are in `codex-images.md`.

## Services and credentials

| Service | Credential | Package |
| --- | --- | --- |
| ChatGPT plan (Codex) | Codex device login | Codex CLI |
| OpenAI | `openai` chat connection | `@ai-sdk/openai` |
| Google Gemini | `google` chat connection | `@ai-sdk/google` |
| xAI Grok | `xai` chat connection | `@ai-sdk/xai` |
| Together AI | `togetherai` chat connection | `@ai-sdk/togetherai` |
| Black Forest Labs | own key, `image-black-forest-labs` | `@ai-sdk/black-forest-labs` |
| fal | own key, `image-fal` | `@ai-sdk/fal` |
| Replicate | own key, `image-replicate` | `@ai-sdk/replicate` |

Multimodal providers reuse the chat provider connection: one key covers chat and images, including an admin's shared connection and a custom base URL. Image-only keys are stored as provider connections with an `image-` prefix, so they get the same encryption and shared-connection merge. The `image-` ids are not in models.dev, so they never appear in the provider list or the model picker.

Not covered: OpenRouter (images come through chat completions, not an image API), and Ideogram, Recraft, and Stability directly. fal and Replicate host those models.

## Settings

`settings.imageServices` maps a service id to `{ enabled?, model? }`. A connected service is on unless switched off. Default model is the first entry of the built-in list. Codex has no model choice.

## Model lists

The settings picker loads `GET /api/image-services/:id/models` when it first opens (`src/server/tools/image-models.ts`). Lists come from the provider with the user's key, cached one hour per key and base URL:

| Service | Endpoint | Filter |
| --- | --- | --- |
| OpenAI | `GET /v1/models` | ids starting `gpt-image`, `chatgpt-image`, `dall-e` |
| Google | `GET /v1beta/models` (paged, `x-goog-api-key`) | ids containing `image`, `imagen`, `nano-banana` |
| xAI | `GET /v1/image-generation-models` | all |
| Together | `GET /v1/models` | `type: "image"` |
| fal | `GET https://api.fal.ai/v1/models?category=text-to-image&status=active&limit=100` | first page, ranked by popularity |
| Replicate | `GET /v1/collections/text-to-image` | all, as `owner/name` |

Black Forest Labs has no list endpoint (`/v1/models` returns 404), so it shows the built-in list. Any failure (bad key, timeout) also shows the built-in list with the reason. Only host and status code are reported, never the response body. fal rejects an invalid key with 401 even though the list is public without one.

## Choosing a service

With one service on, the tool has no `service` argument. With several, `service` is a required enum and the description lists every service with its model. It tells the model to ask the user before the first image of a conversation, never pick one itself, and keep the choice afterwards. The description only changes when the account's choices change, so the tool block stays cacheable.

## Generation

API services go through AI SDK `generateImage` with `maxRetries: 1` (each retry bills another image) and a 5-minute timeout joined with the chat abort signal. Reference ids become `prompt.images`, which the providers send as an edit. A reference is an earlier generated image id or the `file_id` of one of the account's own image attachments; both resolve to the original file, never a preview (`referencePaths`). Provider errors are collapsed to 300 characters behind the service name.

The format is detected from magic bytes (PNG, JPEG, WebP, GIF, AVIF) and the image is then fully decoded by sharp within the 100-megapixel bound. Anything else is rejected, so a provider cannot make the server serve HTML or SVG. `images.mime` holds the detected type. Files keep the `<id>.png` name for every format so older paths stay valid. Width and height come from the decode (after orientation). The file is written via temp + rename, and the `images` row plus its `image_threads` reference are inserted in one transaction; a failure removes the file. Cards and the Library load previews (`?variant=`, see `media.md`); a fork keeps a generated image alive after its source chat is deleted.

The prompt-fidelity rules in `codex-images.md` apply to every service.

Chat plan SIWC credentials are not image-service credentials. The Codex image relay retains its independent CLI login; see `codex-chat.md` for the default-off desktop chat integration.
