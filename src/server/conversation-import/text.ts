import { parseHTML } from 'linkedom';
import type { ImportWarning, WarningCode } from '../../shared/chat-import.js';

export function warning(warnings: ImportWarning[], code: WarningCode, count = 1): void {
  if (!count) return;
  const previous = warnings.find((w) => w.code === code);
  if (previous) previous.count += count;
  else warnings.push({ code, count });
}
function markdown(text: string, warnings: ImportWarning[]): string {
  // Treat reference definitions as inert labels; never leave hidden image destinations behind.
  text = text.replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, () => { warning(warnings, 'links_removed'); return ''; });
  text = text.replace(/!\[([^\]]*)\](?:\([^\n]*?\)|\[[^\]\n]*\])?/g, (_all: string, label: string) => { warning(warnings, 'attachments_missing'); return label; });
  text = text.replace(/\[([^\]\n]+)\]\(([^\n]*?)\)/g, (all: string, label: string, target: string) => {
    const href = target.trim().replace(/^<|>$/g, '').split(/\s/)[0] ?? '';
    if (/^https?:\/\//i.test(href) && !/[\x00-\x20\\]/.test(href)) return all;
    warning(warnings, 'links_removed'); return label;
  });
  // A nested alt label must not reintroduce an image marker after replacement.
  return text.replace(/!\[/g, () => { warning(warnings, 'attachments_missing'); return '['; });
}
function prose(text: string, warnings: ImportWarning[]): string {
  text = markdown(text,warnings);
  if (!/<[!/?a-zA-Z]/.test(text)) return text;
  warning(warnings, 'html_removed');
  const { document } = parseHTML(`<html><body>${text}</body></html>`);
  for (const node of document.querySelectorAll('script,style,iframe,object,embed,form,svg,math')) node.remove();
  // Reading text nodes only drops every attribute and all possible URL-bearing elements.
  let result = '';
  const stack = Array.from(document.body.childNodes).reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType === 3) result += node.textContent ?? '';
    else if (node.nodeType === 1) {
      const tag = node.nodeName.toLowerCase();
      if (['p', 'div', 'br', 'li', 'pre', 'h1', 'h2', 'h3'].includes(tag)) result += '\n';
      stack.push(...Array.from(node.childNodes).reverse());
    }
  }
  // Escaping angle brackets prevents a second pass interpreting decoded entities as new HTML.
  return markdown(result.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),warnings);
}
export function sanitizeText(input: string, warnings: ImportWarning[]): string {
  let text = input.replace(/\r\n?/g, '\n');
  text = text.replace(/[\u0000\u202a-\u202e\u2066-\u2069]/g, () => { warning(warnings, 'controls_removed'); return ''; });
  // Preserve fenced and inline examples literally. No placeholders can collide with source text.
  const code = /(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\2\s*$|`+[^`\n]*`+)/gm;
  let output = '', start = 0;
  for (const match of text.matchAll(code)) {
    output += prose(text.slice(start, match.index), warnings) + match[0]; start = match.index + match[0].length;
  }
  return output + prose(text.slice(start), warnings);
}
export function label(text: string, limit: number, warnings: ImportWarning[], title = false): string {
  const clean = sanitizeText(text, warnings).trim();
  const chars = Array.from(clean);
  if (chars.length > limit) warning(warnings, title ? 'title_shortened' : 'label_shortened');
  return chars.slice(0, limit).join('');
}
