import { SimpleImageAttachmentAdapter, SimpleTextAttachmentAdapter, type AttachmentAdapter } from "@assistant-ui/react";
import { generateId } from "ai";
import { t } from "@/i18n";
import { formatBytes } from "@/i18n/format";
import { api } from "../lib/api";
import { BINARY_NOTE } from "./message-attachments";

const MAX_ATTACHMENT = 25 * 1024 * 1024;

const CODE_EXTENSIONS =
  ".txt,.md,.mdx,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.scss,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cs,.php,.sh,.bash,.zsh,.sql,.graphql,.proto,.ini,.env,.log,.r,.lua,.dart,.vue,.svelte,.tex";

/** Native PDFs up to this size. Larger ones are sent as extracted text, so requests and history stay small. */
const NATIVE_PDF_BYTES = 10 * 1024 * 1024;

const readDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Keep the existing data URL parts byte-for-byte; storage is a separate owned copy. */
export class StoredImageAttachmentAdapter extends SimpleImageAttachmentAdapter {
  constructor(private readonly temporary: () => boolean) { super(); }

  override async send(attachment: Parameters<AttachmentAdapter["send"]>[0], options?: { signal?: AbortSignal }) {
    if (attachment.file.size > MAX_ATTACHMENT) throw new Error(t("composer.fileTooLarge", { size: formatBytes(MAX_ATTACHMENT) }));
    const sent = await super.send(attachment, options);
    if (this.temporary()) return sent;
    const form = new FormData();
    form.append("file", attachment.file);
    const { fileId } = await api<{ fileId: string }>("/files/store", { method: "POST", body: form, signal: options?.signal });
    return {
      ...sent,
      content: [...sent.content, { type: "text" as const, text: `<attachment name="${attachment.name.replaceAll('"', "'")}" file_id="${fileId}"></attachment>` }],
    };
  }
}

/**
 * PDFs go as files: models that read PDFs see the pages, and the server extracts text for the rest.
 * Word files are always converted to text on the server.
 */
export class DocumentAttachmentAdapter implements AttachmentAdapter {
  constructor(private readonly temporary: () => boolean = () => false) {}
  accept =
    "application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  async add({ file }: { file: File }) {
    return {
      // Not crypto.randomUUID: it only exists in secure contexts, and plain-HTTP origins would fail silently.
      id: generateId(),
      type: "document" as const,
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
    };
  }

  async send(attachment: Parameters<AttachmentAdapter["send"]>[0], options?: { signal?: AbortSignal }) {
    const isPdf = attachment.file.type === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf");
    if (isPdf && attachment.file.size <= NATIVE_PDF_BYTES) {
      // The bytes stay with us too, so the model can import and restructure the PDF later.
      const form = new FormData();
      form.append("file", attachment.file);
      const stored = await api<{ fileId: string | null }>(`/files/store${this.temporary() ? "?temporary=1" : ""}`, {
        method: "POST",
        body: form,
        signal: options?.signal,
      });
      return {
        ...attachment,
        status: { type: "complete" as const },
        content: [
          { type: "file" as const, data: await readDataUrl(attachment.file), mimeType: "application/pdf", filename: attachment.name },
          ...(stored.fileId ? [{ type: "text" as const, text: `<attachment name="${attachment.name.replaceAll('"', "'")}" file_id="${stored.fileId}"></attachment>` }] : []),
        ],
      };
    }
    const form = new FormData();
    form.append("file", attachment.file);
    const { text, pages, fileId } = await api<{ text: string; pages?: number; fileId?: string }>(this.temporary() ? "/files/extract?temporary=1" : "/files/extract", {
      method: "POST",
      body: form,
      signal: options?.signal,
    });
    // file_id lets the model import the original bytes as an editable document artifact.
    const meta = `${pages ? ` pages="${pages}"` : ""}${fileId ? ` file_id="${fileId}"` : ""}`;
    return {
      ...attachment,
      status: { type: "complete" as const },
      content: [{ type: "text" as const, text: `<attachment name="${attachment.name.replaceAll('"', "'")}"${meta}>\n${text}\n</attachment>` }],
    };
  }

  async remove() {}
}

export class CodeAttachmentAdapter extends SimpleTextAttachmentAdapter {
  override accept = `${new SimpleTextAttachmentAdapter().accept},${CODE_EXTENSIONS}`;
  constructor(private readonly temporary: () => boolean = () => false) {
    super();
  }

  override async send(attachment: Parameters<AttachmentAdapter["send"]>[0], options?: { signal?: AbortSignal }) {
    if (attachment.file.size > MAX_ATTACHMENT) throw new Error(t("composer.fileTooLarge", { size: formatBytes(MAX_ATTACHMENT) }));
    const sent = await super.send(attachment, options);
    if (this.temporary()) return sent;
    // Keep every attachment, even when code execution is disabled.
    const form = new FormData();
    form.append("file", attachment.file);
    const { fileId } = await api<{ fileId: string | null }>("/files/store", { method: "POST", body: form, signal: options?.signal });
    if (!fileId) return sent;
    return {
      ...sent,
      content: sent.content.map((part) => (part.type === "text" ? { ...part, text: part.text.replace(/^<attachment name="([^"]*)">/, `<attachment name="$1" file_id="${fileId}">`) } : part)),
    };
  }
}

export class BinaryAttachmentAdapter implements AttachmentAdapter {
  accept = "*";
  constructor(private readonly temporary: () => boolean) {}
  async add({ file }: { file: File }) {
    return { id: generateId(), type: "document" as const, name: file.name, contentType: file.type, file,
      status: { type: "requires-action" as const, reason: "composer-send" as const } };
  }
  async send(attachment: Parameters<AttachmentAdapter["send"]>[0], options?: { signal?: AbortSignal }) {
    if (attachment.file.size > MAX_ATTACHMENT) throw new Error(t("composer.fileTooLarge", { size: formatBytes(MAX_ATTACHMENT) }));
    if (this.temporary()) return { ...attachment, status: { type: "complete" as const }, content: [
      { type: "file" as const, data: await readDataUrl(attachment.file), mimeType: attachment.file.type || "application/octet-stream", filename: attachment.name },
    ] };
    const form = new FormData();
    form.append("file", attachment.file);
    const { fileId } = await api<{ fileId: string }>("/files/store", { method: "POST", body: form, signal: options?.signal });
    return { ...attachment, status: { type: "complete" as const }, content: [
      { type: "text" as const, text: `<attachment name="${attachment.name.replaceAll('"', "'")}" file_id="${fileId}">${BINARY_NOTE}</attachment>` },
    ] };
  }
  async remove() {}
}

/**
 * Audio files are transcribed by the account's speech engine (or the first server engine that is ready), so any
 * model can read them. The original is kept like other attachments, except in temporary chats.
 */
export class AudioAttachmentAdapter implements AttachmentAdapter {
  accept = "audio/*,.mp3,.wav,.m4a,.ogg,.oga,.opus,.flac,.weba,.aac";
  constructor(private readonly temporary: () => boolean) {}
  async add({ file }: { file: File }) {
    return { id: generateId(), type: "document" as const, name: file.name, contentType: file.type, file,
      status: { type: "requires-action" as const, reason: "composer-send" as const } };
  }
  async send(attachment: Parameters<AttachmentAdapter["send"]>[0], options?: { signal?: AbortSignal }) {
    if (attachment.file.size > MAX_ATTACHMENT) throw new Error(t("composer.audioTooLarge", { size: formatBytes(MAX_ATTACHMENT) }));
    const name = attachment.name.replaceAll('"', "'");
    const form = new FormData();
    form.append("file", attachment.file, attachment.name);
    form.append("purpose", "file");
    const transcript = (await api<{ text: string }>("/speech/transcribe", { method: "POST", body: form, signal: options?.signal }).catch((error: Error) => {
      if (options?.signal?.aborted) throw error;
      throw new Error(t("composer.transcribeFailed", { name: attachment.name, reason: error.message }));
    })).text;
    let fileId: string | undefined;
    if (!this.temporary()) {
      const store = new FormData();
      store.append("file", attachment.file);
      fileId = (await api<{ fileId: string }>("/files/store", { method: "POST", body: store, signal: options?.signal })).fileId;
    }
    const header = fileId ? `<attachment name="${name}" file_id="${fileId}">` : `<attachment name="${name}">`;
    return { ...attachment, status: { type: "complete" as const }, content: [
      { type: "text" as const, text: `${header}\n<transcript>\n${transcript || "(no speech recognized)"}\n</transcript>\n</attachment>` },
    ] };
  }
  async remove() {}
}
