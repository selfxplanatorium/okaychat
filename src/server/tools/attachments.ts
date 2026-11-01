import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readUpload } from "../media/store.js";
import { extract, MAX_CHARS } from "../files.js";
import { scanForInjection, wrapUntrusted } from "../prompt-injection.js";
import { MAX_TOOL_IMAGES_PER_TURN, type ToolImage } from "./screenshots.js";

/**
 * Offered once a chat is trimmed: attachment bodies and images in earlier messages become placeholders,
 * and this brings one back on demand. Images reach vision models the same way MCP images do.
 */
export function attachmentTools(userId: string, images?: Map<string, ToolImage[]>): ToolSet {
  return {
    read_attachment: tool({
      description:
        "Read a file the user attached earlier whose content was removed from the conversation to save context. Pass the file_id from its <attachment> header.",
      inputSchema: z.object({ file_id: z.string().min(1).max(200).describe("The attachment's file_id") }),
      execute: async ({ file_id }, { toolCallId }) => {
        const row = readUpload(userId, file_id);
        if (!row) throw new Error("That file is no longer available. Ask the user to attach it again.");
        const header = `<attachment name="${row.name.replaceAll('"', "'")}" file_id="${file_id}">`;
        if (row.mime.startsWith("image/")) {
          if (!images) return { text: `${header}This model cannot view images.</attachment>`, images: [], name: row.name };
          const shown = [...images.values()].reduce((sum, list) => sum + list.length, 0);
          if (shown >= MAX_TOOL_IMAGES_PER_TURN) return { text: `${header}Not shown: this reply reached its image limit.</attachment>`, images: [], name: row.name };
          images.set(toolCallId, [{ data: new Uint8Array(row.data), mediaType: row.mime }]);
          return { text: `${header}The image is shown below.</attachment>`, images: [], name: row.name };
        }
        const { text } = await extract(row.name, row.mime, new Uint8Array(row.data));
        const body = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[truncated: ${text.length - MAX_CHARS} more characters]` : text;
        const content = `${header}\n${body}\n</attachment>`;
        const injection = scanForInjection(content);
        return { text: content, images: [], name: row.name, ...(injection.flagged ? { injection } : {}) };
      },
      // The UI shows the extracted text; the model gets it spotlighted as third-party data.
      toModelOutput: ({ output }) => ({ type: "text", value: wrapUntrusted(output.text, { kind: "file", name: output.name }).text }),
    }),
  };
}
