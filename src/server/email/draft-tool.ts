import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { EMAIL_DRAFT_LIMITS as LIMITS, type EmailDraft, type EmailDraftFields } from "../../shared/email-draft.js";
import { injectionMetadata, scanForInjection, wrapUntrusted } from "../prompt-injection.js";
import { defaultAccount } from "./accounts.js";
import { createDraft, draftForModel, getDraft, updateDraft } from "./drafts.js";

// `draft_email` writes an editable draft that the chat shows as an inline card. It never sends: the
// user sends from the card after reviewing the exact payload, or asks for email_send separately. The
// tool exists for every stored chat, with or without a connected mailbox, so the tool block does not
// change when an account is added. It is not given to delegates.

const recipient = z.string().trim().min(1).max(LIMITS.entry).refine((value) => !/[\r\n\0]/.test(value), "A recipient cannot contain line breaks.");
const recipients = z.array(recipient).max(LIMITS.entries);

const inputSchema = z
  .object({
    draftId: z.string().min(1).max(80).optional().describe("An existing draft id. Alone, it returns the latest saved draft including the user's edits."),
    revision: z.number().int().min(1).optional().describe("Required when changing an existing draft: the revision you last read. A stale revision fails and returns nothing changed."),
    accountId: z.string().min(1).max(80).nullable().optional().describe("Sending account id from email_folders. Omit on a new draft to use the default account, if any."),
    to: recipients.optional().describe('Recipients as "address@example.com" or "Name <address@example.com>".'),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: z.string().max(LIMITS.subject).refine((value) => !/[\r\n\0]/.test(value), "A subject cannot contain line breaks.").optional(),
    body: z.string().max(LIMITS.body).refine((value) => !value.includes("\0"), "Invalid message text.").optional().describe("Plain-text body. When the account has a signature, end the body with \"\\n\\n-- \\n\" and the signature exactly as email_folders returns it."),
    inReplyTo: z.string().min(1).max(2000).nullable().optional().describe("The email_read id of a message this draft replies to. Replies may only go to that conversation's participants and keep its subject."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const FIELD_KEYS = ["accountId", "to", "cc", "bcc", "subject", "body", "inReplyTo"] as const satisfies ReadonlyArray<keyof EmailDraftFields>;

function fieldsOf(input: Input): Partial<EmailDraftFields> {
  const fields: Partial<EmailDraftFields> = {};
  for (const key of FIELD_KEYS) {
    if (input[key] !== undefined) (fields as Record<string, unknown>)[key] = input[key];
  }
  return fields;
}

export type DraftToolOutput = { action: "created" | "read" | "updated"; draft: EmailDraft; injection?: ReturnType<typeof scanForInjection> };

export function draftTools(opts: { userId: string; threadId: string; temporary?: boolean }): ToolSet {
  if (opts.temporary) return {};
  const { userId, threadId } = opts;
  const draft_email = tool({
    description:
      `Write an email as an editable draft card in the chat; it is never sent by this tool. The user can edit, copy, download, open it in their mail app, or send it after reviewing it. Call with no draftId to create a draft (empty subject or body are allowed). Call with only draftId to read the latest saved version, including the user's edits, before changing it. To change a draft pass draftId, the revision you last read, and only the fields to change; the user's edits win until you write again. Recipients are at most ${LIMITS.sendRecipients} in total when sending.`,
    inputSchema,
    execute: async (input, { toolCallId }): Promise<DraftToolOutput> => {
      const fields = fieldsOf(input);
      let action: DraftToolOutput["action"];
      let draft: EmailDraft;
      if (!input.draftId) {
        if (fields.accountId === undefined) fields.accountId = defaultAccount(userId)?.id ?? null;
        draft = createDraft(userId, threadId, fields, { toolCallId, by: "model" });
        action = "created";
      } else if (!Object.keys(fields).length) {
        draft = getDraft(userId, threadId, input.draftId);
        action = "read";
      } else {
        if (input.revision === undefined) {
          throw new Error("Pass the revision you last read. Call draft_email with only draftId to read the latest draft first.");
        }
        try {
          draft = updateDraft(userId, threadId, input.draftId, { revision: input.revision, fields }, "model");
        } catch (error) {
          const latest = (() => {
            try { return getDraft(userId, threadId, input.draftId!); } catch { return null; }
          })();
          if (latest && latest.revision !== input.revision) {
            throw new Error(`The user edited this draft since revision ${input.revision} (now revision ${latest.revision}). Nothing was changed. Call draft_email with only draftId to read the latest text, then apply your change to it.`);
          }
          throw error;
        }
        action = "updated";
      }
      const injection = scanForInjection(JSON.stringify(draftForModel(draft)));
      return { action, draft, ...(injectionMetadata(injection) ? { injection } : {}) };
    },
    // The text may contain the user's edits and pasted third-party mail, so it is data, never
    // instructions. The envelope also taints the turn for the approval gate.
    toModelOutput: ({ output }) => ({
      type: "text",
      value: wrapUntrusted(JSON.stringify({ action: output.action, ...draftForModel(output.draft) }), { kind: "email_draft", name: output.draft.subject || "email draft" }).text,
    }),
  });
  return { draft_email };
}
