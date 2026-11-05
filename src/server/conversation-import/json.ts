import { IMPORT_LIMITS as L } from '../../shared/chat-import.js';

export class ImportFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ImportFailure'; }
}
export function fail(code = 'invalid_conversation'): never { throw new ImportFailure(code); }

/** Scan tokens before JSON.parse allocates objects. Container frames never recurse. */
export function parseJson(bytes: Uint8Array): unknown {
  if (!bytes.length || bytes.length > L.inputBytes) fail('too_large');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('invalid_json'); }
  let i = 0, tokens = 0;
  const frames: Array<{ kind: 'object' | 'array'; state: string; keys: Set<string> }> = [];
  let root = false;
  const ws = () => { while (i < text.length && /[\x20\t\r\n]/.test(text[i]!)) i++; };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      const c = text.charCodeAt(i++);
      if (c === 34) {
        let value: string;
        try { value = JSON.parse(text.slice(start, i)) as string; } catch { return fail('invalid_json'); }
        if (Buffer.byteLength(value) > L.stringBytes) fail('too_large');
        for (let j = 0; j < value.length; j++) {
          const u = value.charCodeAt(j);
          if (u === 0) fail('invalid_json');
          if (u >= 0xd800 && u <= 0xdbff) { const next = value.charCodeAt(++j); if (!(next >= 0xdc00 && next <= 0xdfff)) fail('invalid_json'); }
          else if (u >= 0xdc00 && u <= 0xdfff) fail('invalid_json');
        }
        return value;
      }
      if (c < 32) fail('invalid_json');
      if (c === 92) {
        const e = text[i++];
        if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) fail('invalid_json'); i += 4; }
        else if (!e || !'"\\/bfnrt'.includes(e)) fail('invalid_json');
      }
      // Escaped source can be six times larger than its decoded string.
      if (i - start > L.stringBytes * 6 + 2) fail('too_large');
    }
    return fail('invalid_json');
  };
  while (true) {
    ws();
    const f = frames.at(-1);
    if (!f && root) { if (i !== text.length) fail('invalid_json'); break; }
    if (++tokens > L.tokens) fail('too_large');
    if (f?.kind === 'object' && (f.state === 'key' || f.state === 'first')) {
      if (text[i] === '}' && f.state === 'first') { i++; frames.pop(); continue; }
      if (text[i] !== '"') fail('invalid_json');
      const key = string();
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('unsafe_key');
      if (f.keys.has(key)) fail('duplicate_key');
      f.keys.add(key); if (f.keys.size > L.objectMembers) fail('too_large');
      ws(); if (text[i++] !== ':') fail('invalid_json'); f.state = 'value'; continue;
    }
    if (f?.state === 'after') {
      const close = f.kind === 'object' ? '}' : ']';
      if (text[i] === close) { i++; frames.pop(); continue; }
      if (text[i++] !== ',') fail('invalid_json');
      f.state = f.kind === 'object' ? 'key' : 'value'; continue;
    }
    if (f?.kind === 'array' && f.state === 'first' && text[i] === ']') { i++; frames.pop(); continue; }
    if (f) f.state = 'after'; else root = true;
    const c = text[i];
    if (c === '{' || c === '[') {
      if (frames.length > L.jsonDepth) fail('too_deep');
      frames.push({ kind: c === '{' ? 'object' : 'array', state: 'first', keys: new Set() }); i++; continue;
    }
    if (c === '"') { string(); continue; }
    const start = i;
    while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
    const token = text.slice(start, i);
    if (['true', 'false', 'null'].includes(token)) continue;
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token) || !Number.isFinite(Number(token))) fail('invalid_json');
  }
  try { return JSON.parse(text) as unknown; } catch { return fail('invalid_json'); }
}
