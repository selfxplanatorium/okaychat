import type { CompleteAttachment, ThreadUserMessagePart } from "@assistant-ui/react";

/**
 * Attachments reach the model as `<attachment name="…" file_id="…">body</attachment>` text parts. The AI SDK
 * converter lifts file parts into message attachments but leaves these text parts in the message content, so the
 * chat UI separates them here: typed text goes in the bubble, attachment parts become tiles and survive edits.
 */
export type AttachmentText = { name: string; fileId?: string; body: string };

const ATTACHMENT = /^<attachment((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]*)<\/attachment>\s*$/;

// assistant-ui's text adapter escapes names as HTML entities; ours replace `"` with `'`.
const unescape = (value: string) =>
  value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

export function parseAttachmentText(text: string): AttachmentText | undefined {
  const match = ATTACHMENT.exec(text);
  if (!match) return undefined;
  const attrs = new Map([...match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, unescape(value!)]));
  return {
    name: attrs.get("name") ?? "Attachment",
    ...(attrs.has("file_id") && { fileId: attrs.get("file_id")! }),
    body: match[2]!.replace(/^\n/, "").replace(/\n$/, ""),
  };
}

/** What a reader should see when opening an attachment's text, or undefined when there is nothing to show. */
export function attachmentPreview(body: string): string | undefined {
  const transcript = /^<transcript>\n?([\s\S]*?)\n?<\/transcript>$/.exec(body.trim());
  const text = transcript ? transcript[1]! : body;
  return text.trim() && text !== BINARY_NOTE ? text : undefined;
}

export const BINARY_NOTE = "Original bytes are available through file_id.";

/** The message's typed text, without attachment parts. */
export function typedText(content: readonly ThreadUserMessagePart[]): string {
  return content
    .flatMap((part) => (part.type === "text" && !parseAttachmentText(part.text) ? [part.text] : []))
    .join("\n\n");
}

const sameName = (a: string, b: string) => a === b || a.replaceAll('"', "'") === b;

/**
 * Splits a user message into its typed text and complete attachments, as the composer held them before sending.
 * A header part of an image or PDF (empty body, same name) rejoins that file's attachment, so an edit resends the
 * file_id with the file. Every other attachment part becomes a text attachment of its own.
 */
export function splitUserMessage(
  content: readonly ThreadUserMessagePart[],
  attachments: readonly CompleteAttachment[] = [],
): { text: string; attachments: CompleteAttachment[] } {
  const files = attachments.map((attachment) => ({ ...attachment, content: [...attachment.content] }));
  const claimed = new Set<number>();
  const texts: CompleteAttachment[] = [];
  content.forEach((part, index) => {
    if (part.type !== "text") return;
    const parsed = parseAttachmentText(part.text);
    if (!parsed) return;
    const file = parsed.body.trim()
      ? -1
      : files.findIndex((candidate, i) => !claimed.has(i) && sameName(candidate.name, parsed.name));
    if (file >= 0) {
      claimed.add(file);
      files[file]!.content.push(part);
      return;
    }
    texts.push({
      id: `text-attachment-${index}`,
      type: "document",
      name: parsed.name,
      contentType: "text/plain",
      content: [part],
      status: { type: "complete" },
    });
  });
  return { text: typedText(content), attachments: [...files, ...texts] };
}

/** Text attachment parts that have no file attachment of their own, with their position in the content. */
export function textAttachments(
  content: readonly ThreadUserMessagePart[],
  attachments: readonly { name: string }[] = [],
): Array<AttachmentText & { key: string }> {
  const claimed = new Set<number>();
  return content.flatMap((part, index) => {
    if (part.type !== "text") return [];
    const parsed = parseAttachmentText(part.text);
    if (!parsed) return [];
    if (!parsed.body.trim()) {
      const file = attachments.findIndex((candidate, i) => !claimed.has(i) && sameName(candidate.name, parsed.name));
      if (file >= 0) {
        claimed.add(file);
        return [];
      }
    }
    return [{ ...parsed, key: `${index}` }];
  });
}
