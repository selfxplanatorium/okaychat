import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPORT_LIMITS } from "../../shared/chat-import.js";
import { ImportFailure, parseJson } from "./json.js";

const encode = (text: string) => new TextEncoder().encode(text);

function failureCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ImportFailure, `expected ImportFailure, received ${String(error)}`);
    assert.equal(error.name, "ImportFailure");
    assert.equal(typeof error.code, "string");
    return error.code;
  }
  return assert.fail("expected parseJson to reject the input");
}

const rejects = (text: string | Uint8Array, code: string) =>
  assert.equal(failureCode(() => parseJson(typeof text === "string" ? encode(text) : text)), code);

test("accepts a complete document and preserves decoded strings", () => {
  const parsed = parseJson(
    encode(
      ' \n { "title": "caf\\u00e9", "pair": "\\ud83d\\ude00", "nested": [1, -2.5, 1e3, true, false, null], ' +
        '"empty": {}, "list": [] } \r\n ',
    ),
  );
  assert.deepEqual(parsed, {
    title: "café",
    pair: "😀",
    nested: [1, -2.5, 1000, true, false, null],
    empty: {},
    list: [],
  });
});

test("accepts primitive roots, including top-level numbers and literals", () => {
  assert.equal(parseJson(encode("42")), 42);
  assert.equal(parseJson(encode("null")), null);
  assert.equal(parseJson(encode('"text"')), "text");
  assert.deepEqual(parseJson(encode("[]")), []);
  assert.deepEqual(parseJson(encode("{}")), {});
});

test("accepts exactly one leading UTF-8 BOM and rejects a repeated one", () => {
  const body = encode('{"a":1}');
  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(body, 3);
  assert.deepEqual(parseJson(withBom), { a: 1 });

  const twice = new Uint8Array(body.length + 6);
  twice.set([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]);
  twice.set(body, 6);
  rejects(twice, "invalid_json");
});

test("rejects empty and whitespace-only input", () => {
  // The file limit is "nonempty"; either code family is defensible, but it must be an ImportFailure.
  assert.ok(["too_large", "invalid_json"].includes(failureCode(() => parseJson(new Uint8Array()))));
  rejects("   \n\t ", "invalid_json");
});

test("rejects trailing junk, multiple roots and truncated documents", () => {
  rejects("{}x", "invalid_json");
  rejects("{} {}", "invalid_json");
  rejects("[]]", "invalid_json");
  rejects('{"a":1', "invalid_json");
  rejects('{"a":}', "invalid_json");
  rejects('{"a"}', "invalid_json");
  rejects('{"a" 1}', "invalid_json");
  rejects("{", "invalid_json");
  rejects("[1,]", "invalid_json");
  rejects("[,]", "invalid_json");
  rejects('{"a":1,}', "invalid_json");
});

test("rejects invalid escapes and raw control characters in strings", () => {
  rejects('"\\x41"', "invalid_json");
  rejects('"\\u12"', "invalid_json");
  rejects('"\\u12g4"', "invalid_json");
  rejects('"line\nbreak"', "invalid_json");
  rejects('"tab\there"', "invalid_json");
  assert.equal(parseJson(encode('"\\b\\f\\n\\r\\t\\/\\\\\\""')), '\b\f\n\r\t/\\"');
});

test("rejects NUL both raw and escaped", () => {
  const raw = new Uint8Array([0x22, 0x61, 0x00, 0x62, 0x22]);
  rejects(raw, "invalid_json");
  rejects('"a\\u0000b"', "invalid_json");
  rejects('{"a\\u0000b":1}', "invalid_json");
});

test("rejects unpaired UTF-16 surrogates and keeps valid pairs", () => {
  rejects('"\\ud800"', "invalid_json");
  rejects('"\\udc00"', "invalid_json");
  rejects('"\\ud800x"', "invalid_json");
  rejects('"\\ud800\\ud800"', "invalid_json");
  assert.equal(parseJson(encode('"\\ud83d\\ude00"')), "😀");
  // A literal supplementary character arrives as a valid pair after UTF-8 decoding.
  assert.equal(parseJson(encode('"😀"')), "😀");
});

test("rejects duplicate object keys instead of accepting last-wins", () => {
  rejects('{"a":1,"a":2}', "duplicate_key");
  rejects('{"a":1,"\\u0061":2}', "duplicate_key");
  rejects('{"\\u0061":1,"a":2}', "duplicate_key");
  rejects('{"outer":{"b":1,"b":2}}', "duplicate_key");
  rejects('{"outer":[{"c":1,"c":2}]}', "duplicate_key");
  rejects('{"\\ud83d\\ude00":1,"😀":2}', "duplicate_key");
  rejects('{"a\\/b":1,"a/b":2}', "duplicate_key");
  assert.deepEqual(parseJson(encode('{"a":1,"A":2}')), { a: 1, A: 2 });
});

test("rejects unsafe decoded keys anywhere, including ignored metadata", () => {
  for (const key of ["__proto__", "prototype", "constructor"]) {
    rejects(JSON.stringify({ [key]: 1 }), "unsafe_key");
    rejects(`{"nested":{"${key}":1}}`, "unsafe_key");
    rejects(`[{"${key}":{}}]`, "unsafe_key");
  }
  rejects('{"\\u005f\\u005fproto__":1}', "unsafe_key");
  rejects('{"constr\\u0075ctor":1}', "unsafe_key");
  rejects('{"__proto__":null}', "unsafe_key");
  // Unsafe words as values are ordinary text and must stay accepted.
  assert.deepEqual(parseJson(encode('{"a":"__proto__","b":["constructor"]}')), {
    a: "__proto__",
    b: ["constructor"],
  });
});

test("rejects non-finite numbers and malformed number syntax", () => {
  rejects("1e999", "invalid_json");
  rejects("-1e999", "invalid_json");
  rejects("NaN", "invalid_json");
  rejects("Infinity", "invalid_json");
  rejects("01", "invalid_json");
  rejects("+1", "invalid_json");
  rejects(".5", "invalid_json");
  rejects("1.", "invalid_json");
  rejects("0x10", "invalid_json");
});

test("rejects invalid UTF-8 bytes", () => {
  rejects(new Uint8Array([0x7b, 0xff, 0x7d]), "invalid_json");
  rejects(new Uint8Array([0x22, 0xc3, 0x28, 0x22]), "invalid_json");
  rejects(new Uint8Array([0xed, 0xa0, 0x80]), "invalid_json");
});

test("enforces the decoded string byte limit at the boundary", () => {
  const atLimit = "a".repeat(IMPORT_LIMITS.stringBytes);
  assert.equal((parseJson(encode(JSON.stringify({ value: atLimit }))) as { value: string }).value.length, IMPORT_LIMITS.stringBytes);
  rejects(JSON.stringify({ value: `${atLimit}b` }), "too_large");
  rejects(JSON.stringify({ [`${atLimit}b`]: 1 }), "too_large");
  // Multi-byte characters are measured in UTF-8 bytes, not code units.
  rejects(JSON.stringify({ value: "é".repeat(IMPORT_LIMITS.stringBytes / 2 + 1) }), "too_large");
});

test("enforces JSON nesting depth 40 with root at depth zero", () => {
  const nest = (levels: number) => `${"[".repeat(levels)}0${"]".repeat(levels)}`;
  assert.doesNotThrow(() => parseJson(encode(nest(IMPORT_LIMITS.jsonDepth + 1))));
  rejects(nest(IMPORT_LIMITS.jsonDepth + 2), "too_deep");
  rejects(nest(200), "too_deep");
  assert.doesNotThrow(() => parseJson(encode(`${'{"a":'.repeat(IMPORT_LIMITS.jsonDepth + 1)}1${"}".repeat(IMPORT_LIMITS.jsonDepth + 1)}`)));
  rejects(`${'{"a":'.repeat(IMPORT_LIMITS.jsonDepth + 2)}1${"}".repeat(IMPORT_LIMITS.jsonDepth + 2)}`, "too_deep");
});

test("enforces the object member limit at the boundary", () => {
  const members = (count: number) => `{${Array.from({ length: count }, (_, n) => `"k${n}":0`).join(",")}}`;
  assert.doesNotThrow(() => parseJson(encode(members(IMPORT_LIMITS.objectMembers))));
  rejects(members(IMPORT_LIMITS.objectMembers + 1), "too_large");
});

test("enforces the token limit", () => {
  // Comfortably past the token cap while staying inside every other file limit.
  const huge = `[${"0,".repeat(IMPORT_LIMITS.tokens)}0]`;
  rejects(huge, "too_large");
});

test("enforces the raw input byte limit", () => {
  const over = new Uint8Array(IMPORT_LIMITS.inputBytes + 1).fill(0x20);
  rejects(over, "too_large");
});

test("reports a stable failure code for every malformed case", () => {
  for (const input of ['{"a":1}', "[]", '"x"', "null"]) {
    assert.doesNotThrow(() => parseJson(encode(input)));
  }
  for (const input of ["", "{", "}", '{"a":1}garbage', '{"__proto__":1}', '{"a":1,"a":1}']) {
    const code = failureCode(() => parseJson(encode(input)));
    assert.ok(
      ["invalid_json", "too_large", "unsafe_key", "duplicate_key"].includes(code),
      `unexpected code ${code} for ${JSON.stringify(input)}`,
    );
  }
});
