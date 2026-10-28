import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompleteAttachment, ThreadUserMessagePart } from "@assistant-ui/react";
import { attachmentPreview, BINARY_NOTE, parseAttachmentText, splitUserMessage, textAttachments, typedText } from "./message-attachments";

const text = (value: string): ThreadUserMessagePart => ({ type: "text", text: value });

test("parses attachment parts from every adapter, including escaped and legacy headers", () => {
  assert.deepEqual(parseAttachmentText('<attachment name="a &amp; &quot;b&quot;.txt">\nhello\n</attachment>'), { name: 'a & "b".txt', body: "hello" });
  assert.deepEqual(parseAttachmentText('<attachment name="r.pdf" pages="2" file_id="upl_1">\nx\n</attachment>'), { name: "r.pdf", fileId: "upl_1", body: "x" });
  assert.deepEqual(parseAttachmentText('<attachment file_id="upl_pdf"></attachment>'), { name: "Attachment", fileId: "upl_pdf", body: "" });
  assert.equal(parseAttachmentText("Look at <attachment> tags"), undefined);
  assert.equal(parseAttachmentText("plain"), undefined);
});

test("typed text excludes attachment parts", () => {
  assert.equal(typedText([text("Summarize"), text('<attachment name="n.txt">\nbody\n</attachment>')]), "Summarize");
});

test("previews show transcripts and text, not the binary placeholder", () => {
  assert.equal(attachmentPreview("<transcript>\nhi there\n</transcript>"), "hi there");
  assert.equal(attachmentPreview("line"), "line");
  assert.equal(attachmentPreview(BINARY_NOTE), undefined);
  assert.equal(attachmentPreview(""), undefined);
});

const image: CompleteAttachment = {
  id: "0",
  type: "image",
  name: 'my "photo".png',
  contentType: "image/png",
  content: [{ type: "image", image: "data:image/png;base64,AA==" }],
  status: { type: "complete" },
};

test("file headers rejoin their file; text attachments get their own tile", () => {
  const content = [
    text("Compare these"),
    text(`<attachment name="my 'photo'.png" file_id="upl_img"></attachment>`),
    text('<attachment name="notes.md" file_id="upl_txt">\n# Notes\n</attachment>'),
  ];
  assert.deepEqual(textAttachments(content, [image]).map((a) => a.name), ["notes.md"]);
  const split = splitUserMessage(content, [image]);
  assert.equal(split.text, "Compare these");
  assert.equal(split.attachments.length, 2);
  assert.deepEqual(split.attachments[0]!.content, [image.content[0], content[1]]);
  assert.equal(split.attachments[1]!.name, "notes.md");
  assert.deepEqual(split.attachments[1]!.content, [content[2]]);
  // The source attachment is not mutated.
  assert.equal(image.content.length, 1);
});
