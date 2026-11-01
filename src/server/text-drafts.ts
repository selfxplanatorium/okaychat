import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { EMAIL_DRAFT_LIMITS } from "../shared/email-draft.js";
import { createDraft, getDraft, updateDraft } from "./email/drafts.js";
import { injectionMetadata, scanForInjection, wrapUntrusted } from "./prompt-injection.js";

// Text and mail share the owned, revision-checked persistence and autosave lifecycle. The stored
// kind is immutable, and the mail service refuses text drafts even through a direct API request.
export function textDraftTools(opts: { userId: string; threadId: string; temporary?: boolean }): ToolSet {
  if (opts.temporary) return {};
  const { userId, threadId } = opts;
  return {
    draft_text: tool({
      description: "Create an editable writing draft for text the user wants to copy and use elsewhere: messages, social posts, letters, announcements, and other standalone writing. Use draft_email for emails. Do not use for ordinary answers, explanations, code, or when the user explicitly requests plain text or Markdown. Supply title and body to create a draft; unknown details may be placeholders. Read an existing draft with only draftId before rewriting it, then pass its revision and only changed fields. The user can edit and copy the card; nothing is sent or published. Do not repeat the full draft in your chat reply.",
      inputSchema: z.object({
        draftId: z.string().min(1).max(80).optional(),
        revision: z.number().int().min(1).optional().describe("Required to update: the revision returned by the latest read."),
        title: z.string().max(EMAIL_DRAFT_LIMITS.subject).refine((s) => !/[\r\n\0]/.test(s), "A title cannot contain line breaks.").optional(),
        body: z.string().max(EMAIL_DRAFT_LIMITS.body).refine((s) => !s.includes("\0"), "Invalid text.").optional(),
      }).strict(),
      execute: async (input, { toolCallId }) => {
        const fields = {
          ...(input.title !== undefined ? { subject: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        };
        let action: "created" | "read" | "updated" = "created";
        let draft;
        if (!input.draftId) {
          draft = createDraft(userId, threadId, fields, { toolCallId, by: "model", kind: "text" });
        } else {
          draft = getDraft(userId, threadId, input.draftId);
          if (draft.kind !== "text") throw new Error("Use draft_email for an email draft.");
          action = "read";
          if (Object.keys(fields).length) {
            if (input.revision === undefined || input.revision !== draft.revision) {
              throw new Error("Read the latest draft with only draftId, then update using its revision. Nothing was changed.");
            }
            draft = updateDraft(userId, threadId, input.draftId, { revision: input.revision, fields }, "model");
            action = "updated";
          }
        }
        const injection = scanForInjection(JSON.stringify({ title: draft.subject, body: draft.body }));
        return { action, draft, ...(injectionMetadata(injection) ? { injection } : {}) };
      },
      toModelOutput: ({ output }) => ({
        type: "text",
        value: wrapUntrusted(JSON.stringify({ action: output.action, draftId: output.draft.id, revision: output.draft.revision, title: output.draft.subject, body: output.draft.body }), { kind: "text_draft", name: output.draft.subject || "writing draft" }).text,
      }),
    }),
  };
}
