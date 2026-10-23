import { escapeCurrencyDollars, normalizeMathDelimiters } from "@assistant-ui/react-markdown";

const FENCE = /^\s*(`{3,}|~{3,})/;
const ONE_LINE_DISPLAY = /^(\s*)\$\$([^$]+)\$\$\s*$/;

// remark-math only treats $$ as display math when the delimiters sit on their own lines.
// A paragraph that is just `$$x$$` (or `\[x\]` after normalizing) would otherwise render inline.
function fenceOneLineDisplayMath(text: string) {
  let fence: string | null = null;
  return text.split("\n").map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      return line;
    }
    if (fence !== null) return line;
    const match = ONE_LINE_DISPLAY.exec(line);
    if (!match) return line;
    const [, indent = "", tex = ""] = match;
    return `${indent}$$\n${indent}${tex.trim()}\n${indent}$$`;
  }).join("\n");
}

/** Normalizes model math output for remark-math: bracket delimiters, one-line display math, and prose prices. */
export const preprocessMarkdown = (text: string) =>
  escapeCurrencyDollars(fenceOneLineDisplayMath(normalizeMathDelimiters(text)));
