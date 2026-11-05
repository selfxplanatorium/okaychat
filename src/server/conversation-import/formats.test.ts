import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPORT_LIMITS } from "../../shared/chat-import.js";
import type {
  NormalizedItem,
  PortableConversation,
  PortableMessage,
  PortablePart,
  WarningCode,
} from "../../shared/chat-import.js";
import { ImportFailure } from "./json.js";
import { normalizeFile } from "./formats.js";

const ADMISSION = 1_700_000_000_000;
const DAY_MS = 86_400_000;

const WARNING_CODES = new Set<WarningCode>([
  "branches_omitted",
  "roles_quarantined",
  "attachments_missing",
  "html_removed",
  "links_removed",
  "timestamps_inferred",
  "title_shortened",
  "label_shortened",
  "controls_removed",
  "unknown_fields",
  "unsupported_content",
  "reasoning_omitted",
  "source_changed",
  "model_unavailable",
  "model_unset",
  "export_loss",
]);

type Obj = Record<string, unknown>;

const rec = (value: unknown): Obj => value as Obj;

// ---------------------------------------------------------------------------
// Mapping fixtures
// ---------------------------------------------------------------------------

type NodeSpec = {
  key: string;
  parent: string | null;
  children: string[];
  message: unknown;
  id?: string;
};

function textMessage(id: string, role: string, text: string, extra: Obj = {}): Obj {
  return {
    id,
    author: { role },
    content: { content_type: "text", parts: [text] },
    create_time: 1000,
    ...extra,
  };
}

function mappingOf(specs: NodeSpec[]): Obj {
  const mapping: Obj = {};
  for (const spec of specs) {
    mapping[spec.key] = {
      ...(spec.id === undefined ? {} : { id: spec.id }),
      parent: spec.parent,
      children: [...spec.children],
      message: spec.message,
    };
  }
  return mapping;
}

function mappingConversation(specs: NodeSpec[], overrides: Obj = {}, currentNode?: string): Obj {
  return {
    id: "conv-1",
    create_time: 1000,
    update_time: 1002,
    mapping: mappingOf(specs),
    current_node: currentNode ?? specs[specs.length - 1]!.key,
    ...overrides,
  };
}

function standardSpecs(): NodeSpec[] {
  return [
    { key: "root", parent: null, children: ["n2"], message: textMessage("m1", "user", "hello", { create_time: 1000 }) },
    { key: "n2", parent: "root", children: [], message: textMessage("m2", "assistant", "hi", { create_time: 1001 }) },
  ];
}

// ---------------------------------------------------------------------------
// Portable fixtures
// ---------------------------------------------------------------------------

const portableText = (text: string): PortablePart => ({ type: "text", text });

function portableMessage(
  id: string,
  role: PortableMessage["role"],
  parts: PortablePart[],
  overrides: Partial<PortableMessage> = {},
): PortableMessage {
  return {
    id,
    createdAt: 1000,
    role,
    originalRole: role === "user" || role === "assistant" ? null : role,
    parts,
    ...overrides,
  };
}

function portableConversation(overrides: Partial<PortableConversation> = {}): PortableConversation {
  return {
    source: { namespace: "portable-v1", id: "source-1" },
    title: "Conversation",
    createdAt: 1000,
    updatedAt: 2000,
    status: "regular",
    messages: [
      portableMessage("m1", "user", [portableText("hello")]),
      portableMessage("m2", "assistant", [portableText("hi")], { createdAt: 2000 }),
    ],
    ...overrides,
  };
}

function portableFile(conversations: unknown[], overrides: Obj = {}): Obj {
  return { format: "okaychat.conversations", version: 1, exportedAt: ADMISSION, conversations, ...overrides };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalize(value: unknown, admissionTime = ADMISSION) {
  return normalizeFile(value, admissionTime);
}

function oneItem(value: unknown, admissionTime = ADMISSION): NormalizedItem {
  const result = normalize(value, admissionTime);
  assert.equal(result.adapter, Array.isArray(value) ? "mapping-v1" : "portable-v1");
  assert.equal(result.items.length, 1);
  return result.items[0]!;
}

function validConversation(value: unknown, admissionTime = ADMISSION): PortableConversation {
  const item = oneItem(value, admissionTime);
  assert.equal(item.errorCode, null, `unexpected error ${String(item.errorCode)}`);
  assert.ok(item.conversation !== null);
  return item.conversation;
}

function itemErrorAt(value: unknown, index: number, allowed: string | string[]): string {
  // Mapping fixtures may be passed as one conversation object; normalize them the way a file would.
  const file =
    Array.isArray(value) || (value !== null && typeof value === "object" && !Object.hasOwn(value, "format"))
      ? Array.isArray(value)
        ? value
        : [value]
      : value;
  const result = normalize(file);
  const item = result.items[index];
  assert.ok(item, `missing item ${index}`);
  assert.equal(item.conversation, null);
  const allowedCodes = typeof allowed === "string" ? [allowed] : allowed;
  assert.ok(
    item.errorCode !== null && allowedCodes.includes(item.errorCode),
    `expected ${allowedCodes.join("|")}, got ${String(item.errorCode)}`,
  );
  return item.errorCode;
}

function itemError(value: unknown, allowed: string | string[]): string {
  return itemErrorAt(value, 0, allowed);
}

function framingError(value: unknown): string {
  try {
    normalize(value);
  } catch (error) {
    assert.ok(error instanceof ImportFailure, `expected ImportFailure, received ${String(error)}`);
    return error.code;
  }
  return assert.fail("expected a framing failure");
}

function warningCount(item: NormalizedItem, code: WarningCode): number {
  return item.warnings.find((warning) => warning.code === code)?.count ?? 0;
}

function hasWarning(item: NormalizedItem, code: WarningCode): void {
  assert.equal(warningCount(item, code) > 0, true, `missing warning ${code}`);
}

const messageOf = (conversation: PortableConversation, index: number): Obj =>
  rec(conversation.messages[index]);
const partOf = (conversation: PortableConversation, messageIndex: number, partIndex: number): Obj =>
  rec(conversation.messages[messageIndex]!.parts[partIndex]);
function msgAt(conversation: PortableConversation, index: number): PortableMessage {
  return conversation.messages[index]!;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test("shared limits match the documented parser contract", () => {
  assert.equal(IMPORT_LIMITS.inputBytes, 32 * 1024 * 1024);
  assert.equal(IMPORT_LIMITS.jsonDepth, 40);
  assert.equal(IMPORT_LIMITS.stringBytes, 1024 * 1024);
  assert.equal(IMPORT_LIMITS.tokens, 1_000_000);
  assert.equal(IMPORT_LIMITS.objectMembers, 50_000);
  assert.equal(IMPORT_LIMITS.conversations, 1000);
  assert.equal(IMPORT_LIMITS.totalNodes, 50_000);
  assert.equal(IMPORT_LIMITS.nodesPerConversation, 5000);
  assert.equal(IMPORT_LIMITS.messageBytes, 256 * 1024);
  assert.equal(IMPORT_LIMITS.conversationBytes, 2 * 1024 * 1024);
  assert.equal(IMPORT_LIMITS.parts, 100);
  assert.equal(IMPORT_LIMITS.stagingBytes, 48 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// Mapping: shape, identity, title, status
// ---------------------------------------------------------------------------

test("normalizes a minimal two-message mapping conversation", () => {
  const item = oneItem([mappingConversation(standardSpecs())]);
  assert.equal(item.ordinal, 0);
  assert.equal(item.errorCode, null);
  assert.deepEqual(item.counts, {
    sourceNodes: 2,
    sourceMessages: 2,
    discardedBranchNodes: 0,
    discardedBranchMessages: 0,
    quarantine: 0,
    omittedAttachments: 0,
  });
  assert.deepEqual(item.warnings, []);
  assert.deepEqual(item.conversation, {
    source: { namespace: "mapping-v1", id: "conv-1" },
    title: null,
    createdAt: 1_000_000,
    updatedAt: 1_002_000,
    status: "regular",
    messages: [
      { id: "m1", createdAt: 1_000_000, role: "user", originalRole: null, parts: [portableText("hello")] },
      { id: "m2", createdAt: 1_001_000, role: "assistant", originalRole: null, parts: [portableText("hi")] },
    ],
  });
});

test("accepts id or conversation_id when they agree", () => {
  assert.equal(validConversation([mappingConversation(standardSpecs(), { id: undefined, conversation_id: "conv-2" })]).source.id, "conv-2");
  assert.equal(validConversation([mappingConversation(standardSpecs())]).source.id, "conv-1");
  assert.equal(
    validConversation([mappingConversation(standardSpecs(), { conversation_id: "conv-1" })]).source.id,
    "conv-1",
  );
  itemError(mappingConversation(standardSpecs(), { conversation_id: "conv-other" }), "invalid_conversation");
  itemError([mappingConversation(standardSpecs(), { id: undefined })], "invalid_conversation");
  itemError([mappingConversation(standardSpecs(), { id: null, conversation_id: null })], "invalid_conversation");
});

test("enforces identifier syntax and length on sources and mapping keys", () => {
  const good = "Abc_09.az:Z-1";
  assert.equal(validConversation([mappingConversation(standardSpecs(), { id: good })]).source.id, good);
  const boundary = "a".repeat(200);
  assert.equal(validConversation([mappingConversation(standardSpecs(), { id: boundary })]).source.id, boundary);
  itemError(mappingConversation(standardSpecs(), { id: "bad id" }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { id: "a".repeat(201) }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { id: "a/b" }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { id: "" }), "invalid_conversation");
  itemError(
    mappingConversation([
      { key: "root", parent: null, children: [], message: textMessage("bad message id", "user", "x") },
    ]),
    "invalid_conversation",
  );

  const invalidKey = mappingConversation(standardSpecs());
  rec(invalidKey.mapping)["bad key"] = { parent: "n2", children: [], message: null };
  rec(rec(invalidKey.mapping).n2!).children = ["bad key"];
  itemError(invalidKey, "invalid_conversation");
});

test("normalizes titles, trimming empty values and truncating long ones", () => {
  assert.equal(validConversation([mappingConversation(standardSpecs(), { title: null })]).title, null);
  assert.equal(validConversation([mappingConversation(standardSpecs(), { title: "" })]).title, null);
  assert.equal(validConversation([mappingConversation(standardSpecs(), { title: "   " })]).title, null);
  assert.equal(validConversation([mappingConversation(standardSpecs(), { title: "  named  " })]).title, "named");

  const long = "😀".repeat(201);
  const item = oneItem([mappingConversation(standardSpecs(), { title: long })]);
  assert.equal(Array.from(item.conversation!.title!).length, 200);
  assert.equal(warningCount(item, "title_shortened"), 1);
  itemError(mappingConversation(standardSpecs(), { title: 7 }), "invalid_conversation");
});

test("maps is_archived to status only when boolean", () => {
  assert.equal(validConversation([mappingConversation(standardSpecs(), { is_archived: true })]).status, "archived");
  assert.equal(validConversation([mappingConversation(standardSpecs(), { is_archived: false })]).status, "regular");
  assert.equal(validConversation([mappingConversation(standardSpecs())]).status, "regular");
  itemError(mappingConversation(standardSpecs(), { is_archived: "yes" }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { is_archived: null }), "invalid_conversation");
});

// ---------------------------------------------------------------------------
// Mapping: graph validation
// ---------------------------------------------------------------------------

test("rejects cycles, self-links and disconnected cycles", () => {
  itemError(
    [
      mappingConversation(
        [
          { key: "a", parent: "b", children: ["b"], message: textMessage("m1", "user", "a") },
          { key: "b", parent: "a", children: ["a"], message: textMessage("m2", "assistant", "b") },
        ],
        {},
        "a",
      ),
    ],
    "invalid_tree",
  );
  itemError(
    mappingConversation([{ key: "a", parent: "a", children: ["a"], message: textMessage("m1", "user", "a") }], {}, "a"),
    "invalid_tree",
  );
  itemError(
    [
      mappingConversation(
        [
          { key: "root", parent: null, children: [], message: textMessage("m1", "user", "root") },
          { key: "a", parent: "b", children: ["b"], message: textMessage("m2", "user", "a") },
          { key: "b", parent: "a", children: ["a"], message: textMessage("m3", "user", "b") },
        ],
        {},
        "root",
      ),
    ],
    "invalid_tree",
  );
});

test("rejects two roots, dangling parents and child/parent disagreement", () => {
  itemError(
    mappingConversation(
      [
        { key: "a", parent: null, children: [], message: textMessage("m1", "user", "a") },
        { key: "b", parent: null, children: [], message: textMessage("m2", "assistant", "b") },
      ],
      {},
      "a",
    ),
    "invalid_tree",
  );
  itemError(
    mappingConversation(
      [
        { key: "root", parent: null, children: [], message: textMessage("m1", "user", "a") },
        { key: "a", parent: "ghost", children: [], message: textMessage("m2", "assistant", "b") },
      ],
      {},
      "a",
    ),
    "invalid_tree",
  );
  itemError(
    mappingConversation(
      [
        { key: "a", parent: null, children: ["b"], message: textMessage("m1", "user", "a") },
        { key: "b", parent: "c", children: [], message: textMessage("m2", "assistant", "b") },
        { key: "c", parent: "a", children: [], message: textMessage("m3", "assistant", "c") },
      ],
      {},
      "b",
    ),
    "invalid_tree",
  );
});

test("rejects duplicate child entries, shared children and non-sibling children", () => {
  itemError(
    mappingConversation(
      [
        { key: "a", parent: null, children: ["b", "b"], message: textMessage("m1", "user", "a") },
        { key: "b", parent: "a", children: [], message: textMessage("m2", "assistant", "b") },
      ],
      {},
      "b",
    ),
    "invalid_tree",
  );
  itemError(
    mappingConversation(
      [
        { key: "a", parent: null, children: ["b", "c"], message: textMessage("m1", "user", "a") },
        { key: "b", parent: "a", children: [], message: textMessage("m2", "assistant", "b") },
        { key: "c", parent: "a", children: ["b"], message: textMessage("m3", "assistant", "c") },
      ],
      {},
      "b",
    ),
    "invalid_tree",
  );
  itemError(
    mappingConversation(
      [
        { key: "a", parent: null, children: ["b"], message: textMessage("m1", "user", "a") },
        { key: "b", parent: "a", children: ["a"], message: textMessage("m2", "assistant", "b") },
      ],
      {},
      "b",
    ),
    "invalid_tree",
  );
});

test("rejects repeated message ids and node id mismatches", () => {
  itemError(
    mappingConversation(
      [
        { key: "root", parent: null, children: ["b"], message: textMessage("same", "user", "a") },
        { key: "b", parent: "root", children: [], message: textMessage("same", "assistant", "b") },
      ],
      {},
      "b",
    ),
    "invalid_tree",
  );
  itemError(
    mappingConversation([
      { key: "root", parent: null, children: [], message: textMessage("m1", "user", "a"), id: "other" },
    ]),
    "invalid_tree",
  );
});

test("requires a nonempty mapping object and a resolving current_node", () => {
  itemError(mappingConversation(standardSpecs(), { mapping: {} }, "root"), ["too_large", "invalid_conversation"]);
  itemError(mappingConversation(standardSpecs(), { mapping: [] }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { current_node: "absent" }), "invalid_tree");
  itemError(mappingConversation(standardSpecs(), { current_node: undefined }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { current_node: 7 }), "invalid_conversation");
});

test("rejects malformed nodes even when they sit off the selected branch", () => {
  const offPath = standardSpecs();
  offPath[1]!.children = ["branch"];
  offPath.push({
    key: "branch",
    parent: "n2",
    children: [],
    message: textMessage("m9", "assistant", "off path"),
  });
  rec(offPath[2]!.message).author = { role: 7 };
  itemError(mappingConversation(offPath), "invalid_conversation");

  const missingParts = standardSpecs();
  missingParts[1]!.children = ["branch"];
  missingParts.push({
    key: "branch",
    parent: "n2",
    children: [],
    message: { id: "m8", author: { role: "assistant" }, content: { content_type: "text" } },
  });
  itemError(mappingConversation(missingParts), "invalid_conversation");
});

test("requires node parent, children and message fields of the documented types", () => {
  const missingParent = mappingConversation(standardSpecs());
  delete rec(rec(missingParent.mapping).root!).parent;
  itemError(missingParent, "invalid_conversation");

  const missingChildren = mappingConversation(standardSpecs());
  delete rec(rec(missingChildren.mapping).root!).children;
  itemError(missingChildren, "invalid_conversation");

  const missingMessage = mappingConversation(standardSpecs());
  delete rec(rec(missingMessage.mapping).n2!).message;
  itemError(missingMessage, "invalid_conversation");

  const badChildType = mappingConversation(standardSpecs(), {});
  rec(rec(badChildType.mapping).root!).children = [7];
  itemError(badChildType, "invalid_conversation");

  itemError([7], "invalid_conversation");
  itemError([null], "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { mapping: { root: "not a node" } }), "invalid_conversation");
});

// ---------------------------------------------------------------------------
// Mapping: branch selection and counts
// ---------------------------------------------------------------------------

test("selects an internal current_node and preserves only its ancestry", () => {
  // root (structural) -> a (user) -> b (assistant) -> c (assistant leaf)
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["a"], message: null },
    { key: "a", parent: "root", children: ["b"], message: textMessage("m1", "user", "one", { create_time: 1000 }) },
    { key: "b", parent: "a", children: ["c"], message: textMessage("m2", "assistant", "two", { create_time: 2000 }) },
    { key: "c", parent: "b", children: [], message: textMessage("m3", "assistant", "three", { create_time: 3000 }) },
  ];
  const item = oneItem([mappingConversation(specs, {}, "b")]);
  assert.deepEqual(
    item.conversation!.messages.map((message) => message.id),
    ["m1", "m2"],
  );
  assert.deepEqual(item.counts, {
    sourceNodes: 4,
    sourceMessages: 3,
    discardedBranchNodes: 1,
    discardedBranchMessages: 1,
    quarantine: 0,
    omittedAttachments: 0,
  });
  assert.equal(warningCount(item, "branches_omitted"), 1);
});

test("keeps the selected sibling even when another leaf is newer", () => {
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["a", "b"], message: textMessage("m1", "user", "root", { create_time: 1000 }) },
    { key: "a", parent: "root", children: [], message: textMessage("m2", "assistant", "older", { create_time: 3000 }) },
    { key: "b", parent: "root", children: [], message: textMessage("m3", "assistant", "newer", { create_time: 9000 }) },
  ];
  const item = oneItem([mappingConversation(specs, {}, "a")]);
  assert.deepEqual(
    item.conversation!.messages.map((message) => message.id),
    ["m1", "m2"],
  );
  assert.equal(item.counts.discardedBranchMessages, 1);
  assert.equal(item.counts.discardedBranchNodes, 1);
  assert.equal(warningCount(item, "branches_omitted"), 1);
});

test("counts structural null-message nodes separately from messages", () => {
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["a", "leaf"], message: null },
    { key: "a", parent: "root", children: [], message: textMessage("m1", "user", "hi", { create_time: 1000 }) },
    { key: "leaf", parent: "root", children: [], message: null },
  ];
  const item = oneItem([mappingConversation(specs, {}, "a")]);
  assert.equal(item.conversation!.messages.length, 1);
  assert.deepEqual(item.counts, {
    sourceNodes: 3,
    sourceMessages: 1,
    discardedBranchNodes: 1,
    discardedBranchMessages: 0,
    quarantine: 0,
    omittedAttachments: 0,
  });
  assert.equal(warningCount(item, "branches_omitted"), 1);
});

test("keeps adjacent same-role messages as separate entries", () => {
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["b"], message: textMessage("m1", "user", "one", { create_time: 1000 }) },
    { key: "b", parent: "root", children: ["c"], message: textMessage("m2", "user", "two", { create_time: 1001 }) },
    { key: "c", parent: "b", children: [], message: textMessage("m3", "assistant", "three", { create_time: 1002 }) },
  ];
  const conversation = validConversation([mappingConversation(specs)]);
  assert.deepEqual(
    conversation.messages.map((message) => [message.id, message.role]),
    [
      ["m1", "user"],
      ["m2", "user"],
      ["m3", "assistant"],
    ],
  );
});

test("does not report off-branch content as retained warnings or counts", () => {
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["keep", "drop"], message: textMessage("m1", "user", "q", { create_time: 1000 }) },
    { key: "keep", parent: "root", children: [], message: textMessage("m2", "assistant", "kept", { create_time: 1001 }) },
    {
      key: "drop",
      parent: "root",
      children: [],
      message: {
        id: "m3",
        author: { role: "assistant" },
        content: {
          content_type: "multimodal_text",
          parts: ["dropped", { content_type: "image_asset_pointer" }],
        },
        create_time: 1002,
      },
    },
  ];
  const item = oneItem([mappingConversation(specs, {}, "keep")]);
  assert.equal(item.counts.omittedAttachments, 0);
  assert.equal(item.counts.discardedBranchMessages, 1);
  assert.equal(warningCount(item, "attachments_missing"), 0);
  assert.deepEqual(
    item.conversation!.messages.map((message) => message.id),
    ["m1", "m2"],
  );
});

test("reports omitted branches as one aggregated warning", () => {
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["a", "b", "c"], message: textMessage("m1", "user", "root", { create_time: 1000 }) },
    { key: "a", parent: "root", children: [], message: textMessage("m2", "assistant", "keep", { create_time: 1001 }) },
    { key: "b", parent: "root", children: [], message: textMessage("m3", "assistant", "drop", { create_time: 1002 }) },
    { key: "c", parent: "root", children: [], message: textMessage("m4", "assistant", "drop", { create_time: 1003 }) },
  ];
  const item = oneItem([mappingConversation(specs, {}, "a")]);
  assert.equal(item.counts.discardedBranchNodes, 2);
  assert.equal(item.counts.discardedBranchMessages, 2);
  assert.equal(item.warnings.filter((warning) => warning.code === "branches_omitted").length, 1);
  assert.equal(warningCount(item, "branches_omitted"), 2);
});

test("rejects a conversation whose retained path has no usable transcript", () => {
  itemError(
    mappingConversation([
      { key: "root", parent: null, children: ["b"], message: textMessage("m1", "user", "   ") },
      { key: "b", parent: "root", children: [], message: textMessage("m2", "assistant", "") },
    ]),
    "empty_conversation",
  );
  itemError(
    mappingConversation([{ key: "root", parent: null, children: [], message: null }], {}, "root"),
    "empty_conversation",
  );
});

// ---------------------------------------------------------------------------
// Mapping: roles and content
// ---------------------------------------------------------------------------

test("maps public assistant content to the assistant role", () => {
  const routed: NodeSpec[] = [
    { key: "root", parent: null, children: ["answer"], message: textMessage("m1", "user", "q", { create_time: 1000 }) },
    {
      key: "answer",
      parent: "root",
      children: [],
      message: textMessage("m2", "assistant", "public", { recipient: "all", channel: "final", create_time: 1001 }),
    },
  ];
  assert.equal(validConversation([mappingConversation(routed)]).messages[1]!.role, "assistant");

  const nullRouting: NodeSpec[] = [
    { key: "root", parent: null, children: ["answer"], message: textMessage("m1", "user", "q", { create_time: 1000 }) },
    {
      key: "answer",
      parent: "root",
      children: [],
      message: textMessage("m2", "assistant", "no routing", { recipient: null, channel: null, create_time: 1001 }),
    },
  ];
  assert.equal(validConversation([mappingConversation(nullRouting)]).messages[1]!.role, "assistant");

  const absentRouting: NodeSpec[] = [
    { key: "root", parent: null, children: ["answer"], message: textMessage("m1", "user", "q", { create_time: 1000 }) },
    {
      key: "answer",
      parent: "root",
      children: [],
      message: textMessage("m2", "assistant", "absent routing", { create_time: 1001 }),
    },
  ];
  assert.equal(validConversation([mappingConversation(absentRouting)]).messages[1]!.role, "assistant");
});

test("omits reasoning-channel assistant messages without fabricating parts", () => {
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["analysis"], message: textMessage("m1", "user", "q", { create_time: 1000 }) },
    {
      key: "analysis",
      parent: "root",
      children: [],
      message: textMessage("m2", "assistant", "internal reasoning", { channel: "analysis", create_time: 1001 }),
    },
  ];
  const item = oneItem([mappingConversation(specs)]);
  assert.equal(item.conversation!.messages.length, 1);
  assert.equal(item.conversation!.messages[0]!.role, "user");
  hasWarning(item, "reasoning_omitted");
  assert.equal(item.counts.quarantine, 0);
});

test("turns non-public recipients and tool roles into inert historical tool records", () => {
  const recipientSpecs: NodeSpec[] = [
    { key: "root", parent: null, children: ["tool"], message: textMessage("m1", "user", "run it", { create_time: 1000 }) },
    {
      key: "tool",
      parent: "root",
      children: [],
      message: textMessage("m2", "assistant", "payload", {
        author: { role: "assistant", name: "python" },
        recipient: "python",
        create_time: 1001,
      }),
    },
  ];
  const recipientConversation = validConversation([mappingConversation(recipientSpecs)]);
  assert.deepEqual(recipientConversation.messages[1], {
    id: "m2",
    createdAt: 1_001_000,
    role: "tool",
    originalRole: "assistant",
    parts: [{ type: "historical-tool", name: "python", text: "payload" }],
  });

  const roleSpecs: NodeSpec[] = [
    { key: "root", parent: null, children: [], message: textMessage("m1", "tool", "tool output", { create_time: 1000 }) },
  ];
  const roleConversation = validConversation([mappingConversation(roleSpecs)]);
  assert.equal(roleConversation.messages[0]!.role, "tool");
  assert.equal(roleConversation.messages[0]!.originalRole, "tool");
  assert.deepEqual(roleConversation.messages[0]!.parts, [
    { type: "historical-tool", name: "tool", text: "tool output" },
  ]);
});

test("quarantines system, developer, function and unknown roles", () => {
  for (const role of ["system", "developer", "function", "critic"]) {
    const conversation = validConversation([
      mappingConversation([
        { key: "root", parent: null, children: [], message: textMessage("m1", role, `${role} text`, { create_time: 1000 }) },
      ]),
    ]);
    assert.equal(conversation.messages[0]!.role, "quarantine");
    assert.equal(conversation.messages[0]!.originalRole, role);
    assert.deepEqual(conversation.messages[0]!.parts, [portableText(`${role} text`)]);
    assert.notEqual(conversation.messages[0]!.role, "user");
    assert.notEqual(conversation.messages[0]!.role, "assistant");
  }
});

test("aggregates quarantine counts and role warnings", () => {
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["b"], message: textMessage("m1", "system", "first", { create_time: 1000 }) },
    { key: "b", parent: "root", children: [], message: textMessage("m2", "critic", "second", { create_time: 1001 }) },
  ];
  const item = oneItem([mappingConversation(specs)]);
  assert.equal(item.counts.quarantine, 2);
  assert.equal(warningCount(item, "roles_quarantined"), 2);
  assert.deepEqual(
    item.conversation!.messages.map((message) => message.originalRole),
    ["system", "critic"],
  );

  const longRole = "r".repeat(150);
  const truncated = oneItem([
    mappingConversation([
      { key: "root", parent: null, children: [], message: textMessage("m1", longRole, "x", { create_time: 1000 }) },
    ]),
  ]);
  assert.equal(Array.from(truncated.conversation!.messages[0]!.originalRole!).length, 100);
  hasWarning(truncated, "label_shortened");
});

test("requires author, content and discriminators with the documented types", () => {
  const cases: Obj[] = [
    { id: "m1", content: { content_type: "text", parts: ["x"] } },
    { id: "m1", author: {}, content: { content_type: "text", parts: ["x"] } },
    { id: "m1", author: { role: 1 }, content: { content_type: "text", parts: ["x"] } },
    { id: "m1", author: { role: "user" }, content: { parts: ["x"] } },
    { id: "m1", author: { role: "user" }, content: { content_type: 1, parts: ["x"] } },
    { author: { role: "user" }, content: { content_type: "text", parts: ["x"] } },
    { id: "m1", author: { role: "user" }, content: { content_type: "text" } },
    { id: "m1", author: { role: "user" }, content: { content_type: "text", parts: "x" } },
    { id: "m1", author: { role: "user" }, content: { content_type: "text", parts: [7] } },
    { id: "m1", author: { role: "user" }, content: { content_type: "text", parts: [null] } },
  ];
  for (const message of cases) {
    itemError(
      mappingConversation([{ key: "root", parent: null, children: [], message }]),
      "invalid_conversation",
    );
  }
});

test("validates known optional message fields without failing on unknown metadata", () => {
  const withUnknown = mappingConversation(
    [
      {
        key: "root",
        parent: null,
        children: [],
        message: textMessage("m1", "user", "hello", {
          metadata: { anything: { nested: true }, attachments: [] },
          unknown_extra: "ignored",
        }),
      },
    ],
    { legacy_field: { ignored: true } },
  );
  const item = oneItem([withUnknown]);
  assert.equal(item.errorCode, null);
  hasWarning(item, "unknown_fields");

  const badAuthorName = textMessage("m1", "user", "hello", { author: { role: "user", name: 7 } });
  itemError(mappingConversation([{ key: "root", parent: null, children: [], message: badAuthorName }]), "invalid_conversation");

  const badRecipient = textMessage("m1", "user", "hello", { recipient: 7 });
  itemError(mappingConversation([{ key: "root", parent: null, children: [], message: badRecipient }]), "invalid_conversation");

  const badChannel = textMessage("m1", "user", "hello", { channel: 7 });
  itemError(mappingConversation([{ key: "root", parent: null, children: [], message: badChannel }]), "invalid_conversation");

  const badAttachments = textMessage("m1", "user", "hello", { metadata: { attachments: "nope" } });
  itemError(
    mappingConversation([{ key: "root", parent: null, children: [], message: badAttachments }]),
    "invalid_conversation",
  );
});

test("normalizes text and multimodal parts, including omitted attachments", () => {
  const specs: NodeSpec[] = [
    {
      key: "root",
      parent: null,
      children: [],
      message: {
        id: "m1",
        author: { role: "user" },
        content: {
          content_type: "multimodal_text",
          parts: [
            "look at this",
            { content_type: "image_asset_pointer", asset_pointer: "file-service://secret" },
            { content_type: "audio_asset_pointer" },
            { content_type: "video_asset_pointer" },
            { content_type: "file_asset_pointer" },
            { content_type: "surprise" },
          ],
        },
        create_time: 1000,
      },
    },
  ];
  const item = oneItem([mappingConversation(specs)]);
  assert.deepEqual(item.conversation!.messages[0]!.parts, [
    portableText("look at this"),
    { type: "missing-attachment", kind: "image", name: null },
    { type: "missing-attachment", kind: "audio", name: null },
    { type: "missing-attachment", kind: "video", name: null },
    { type: "missing-attachment", kind: "file", name: null },
    { type: "missing-attachment", kind: "unknown", name: null },
  ]);
  assert.equal(item.counts.omittedAttachments, 5);
  assert.equal(warningCount(item, "attachments_missing"), 5);
  assert.equal(warningCount(item, "unsupported_content"), 1);
  // Pointers, URLs and MIME data are never retained.
  assert.equal(JSON.stringify(item.conversation).includes("secret"), false);
});

test("metadata-only attachments become inert placeholders, counted once", () => {
  const text = textMessage("m1", "user", "see the attached report", {
    metadata: {
      attachments: [
        { id: "file-123", name: "report.pdf", mime_type: "application/pdf" },
        { id: "file-456", name: "photo.png", mime_type: "image/png" },
      ],
    },
  });
  const item = oneItem([mappingConversation([{ key: "root", parent: null, children: [], message: text }])]);
  assert.deepEqual(item.conversation!.messages[0]!.parts, [
    portableText("see the attached report"),
    { type: "missing-attachment", kind: "file", name: "report.pdf" },
    { type: "missing-attachment", kind: "image", name: "photo.png" },
  ]);
  assert.equal(item.counts.omittedAttachments, 2);
  assert.equal(warningCount(item, "attachments_missing"), 2);

  // The same upload named by a content part and by metadata is one missing attachment, not two.
  const multimodal = textMessage("m2", "user", "", {
    content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://file-789" }] },
    metadata: { attachments: [{ id: "file-789", name: "chart.png", mime_type: "image/png" }] },
  });
  const single = oneItem([mappingConversation([{ key: "root", parent: null, children: [], message: multimodal }])]);
  assert.deepEqual(single.conversation!.messages[0]!.parts, [{ type: "missing-attachment", kind: "image", name: null }]);
  assert.equal(single.counts.omittedAttachments, 1);
  assert.equal(JSON.stringify(single.conversation).includes("file-789"), false);
});

test("keeps multiline, fenced and inline code text literal while stripping markup", () => {
  const source = [
    "before <b>bold</b>",
    "```html",
    "<script>alert(1)</script>",
    "```",
    "inline `<img src=x>` here",
    "after <script>alert(2)</script>tail",
  ].join("\n");
  const conversation = validConversation([
    mappingConversation([
      { key: "root", parent: null, children: [], message: textMessage("m1", "user", source) },
    ]),
  ]);
  const text = (conversation.messages[0]!.parts[0] as { text: string }).text;
  assert.ok(text.includes("```html\n<script>alert(1)</script>\n```"));
  assert.ok(text.includes("inline `<img src=x>` here"));
  assert.ok(!text.includes("<b>"));
  assert.ok(!text.includes("<script>alert(2)</script>"));
  assert.ok(text.includes("tail"));
});

test("rejects unsupported content types according to the quarantine contract", () => {
  // The specification keeps a textual payload from an unsupported content type only as quarantine.
  const withText = validConversation([
    mappingConversation([
      {
        key: "root",
        parent: null,
        children: [],
        message: {
          id: "m1",
          author: { role: "assistant" },
          content: { content_type: "code", text: "print(1)" },
          create_time: 1000,
        },
      },
    ]),
  ]);
  assert.equal(withText.messages[0]!.role, "quarantine");
  assert.equal(withText.messages[0]!.originalRole, "assistant");
  assert.deepEqual(withText.messages[0]!.parts, [portableText("print(1)")]);
});

test("retains a generic omission marker for unsupported content without text", () => {
  const item = oneItem([
    mappingConversation([
      {
        key: "root",
        parent: null,
        children: [],
        message: {
          id: "m1",
          author: { role: "user" },
          content: { content_type: "mystery" },
          create_time: 1000,
        },
      },
    ]),
  ]);
  assert.deepEqual(item.conversation!.messages[0]!.parts, [
    { type: "missing-attachment", kind: "unknown", name: null },
  ]);
  hasWarning(item, "unsupported_content");
});

test("enforces per-message part and byte limits", () => {
  const atLimit = "a".repeat(IMPORT_LIMITS.messageBytes);
  assert.doesNotThrow(() =>
    validConversation([
      mappingConversation([
        { key: "root", parent: null, children: [], message: textMessage("m1", "user", atLimit) },
      ]),
    ]),
  );
  itemError(
    mappingConversation([
      { key: "root", parent: null, children: [], message: textMessage("m1", "user", `${atLimit}b`) },
    ]),
    ["too_large", "invalid_conversation"],
  );

  const atPartLimit = Array.from({ length: IMPORT_LIMITS.parts }, (_, index) => `p${index}`);
  assert.doesNotThrow(() =>
    validConversation([
      mappingConversation([
        {
          key: "root",
          parent: null,
          children: [],
          message: { id: "m1", author: { role: "user" }, content: { content_type: "text", parts: atPartLimit }, create_time: 1000 },
        },
      ]),
    ]),
  );
  itemError(
    mappingConversation([
      {
        key: "root",
        parent: null,
        children: [],
        message: {
          id: "m1",
          author: { role: "user" },
          content: { content_type: "text", parts: [...atPartLimit, "extra"] },
          create_time: 1000,
        },
      },
    ]),
    ["too_large", "invalid_conversation"],
  );
});

test("rejects a conversation whose normalized serialization exceeds 2 MiB", () => {
  const specs: NodeSpec[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 9; index += 1) {
    const key = `n${index}`;
    specs.push({
      key,
      parent,
      children: [],
      message: textMessage(`m${index}`, index % 2 === 0 ? "user" : "assistant", "x".repeat(250 * 1024), {
        create_time: 1000 + index,
      }),
    });
    if (parent !== null) {
      const previous = specs.find((spec) => spec.key === parent)!;
      previous.children = [key];
    }
    parent = key;
  }
  itemError(mappingConversation(specs), ["too_large", "invalid_conversation"]);
});

// ---------------------------------------------------------------------------
// Mapping: timestamps
// ---------------------------------------------------------------------------

test("rounds fractional seconds to milliseconds", () => {
  const conversation = validConversation([
    mappingConversation(
      [
        { key: "root", parent: null, children: [], message: textMessage("m1", "user", "hi", { create_time: 1000.61 }) },
      ],
      { create_time: 1000.4, update_time: 1000.61 },
    ),
  ]);
  assert.equal(conversation.createdAt, 1_000_400);
  assert.equal(conversation.messages[0]!.createdAt, 1_000_610);
  assert.equal(conversation.updatedAt, 1_000_610);
});

test("infers missing conversation and message times from the selected path", () => {
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["b"], message: textMessage("m1", "user", "late", { create_time: 2000 }) },
    { key: "b", parent: "root", children: [], message: textMessage("m2", "assistant", "early", { create_time: 1500 }) },
  ];
  const item = oneItem([mappingConversation(specs, { create_time: undefined, update_time: undefined })]);
  assert.equal(item.conversation!.createdAt, 1_500_000);
  assert.equal(item.conversation!.updatedAt, 2_000_000);
  assert.deepEqual(
    item.conversation!.messages.map((message) => message.createdAt),
    [2_000_000, 1_500_000],
  );
  hasWarning(item, "timestamps_inferred");

  const absentMessageTime = oneItem([
    mappingConversation(
      [
        { key: "root", parent: null, children: [], message: textMessage("m1", "user", "hi", { create_time: undefined }) },
      ],
      { create_time: 500, update_time: 500 },
    ),
  ]);
  assert.equal(absentMessageTime.conversation!.messages[0]!.createdAt, 500_000);
  hasWarning(absentMessageTime, "timestamps_inferred");
});

test("uses the admission time when the source carries no times", () => {
  const conversation = validConversation([
    mappingConversation(
      [
        { key: "root", parent: null, children: [], message: textMessage("m1", "user", "hi", { create_time: undefined }) },
      ],
      { create_time: undefined, update_time: undefined },
    ),
  ]);
  assert.equal(conversation.createdAt, ADMISSION);
  assert.equal(conversation.updatedAt, ADMISSION);
  assert.equal(conversation.messages[0]!.createdAt, ADMISSION);
  // Inference is deterministic for the same admission time.
  const again = validConversation([
    mappingConversation(
      [
        { key: "root", parent: null, children: [], message: textMessage("m1", "user", "hi", { create_time: undefined }) },
      ],
      { create_time: undefined, update_time: undefined },
    ),
  ]);
  assert.deepEqual(again, conversation);
});

test("preserves explicit times across different admission times", () => {
  const first = validConversation([mappingConversation(standardSpecs())]);
  const second = validConversation([mappingConversation(standardSpecs())], ADMISSION + DAY_MS);
  assert.deepEqual(second, first);
});

test("derives an absent update time from the conversation and retained messages", () => {
  const conversation = validConversation([
    mappingConversation(standardSpecs(), { create_time: 1000, update_time: undefined }),
  ]);
  assert.equal(conversation.updatedAt, 1_001_000);
});

test("rejects invalid, negative, future and inverted timestamps", () => {
  itemError(mappingConversation(standardSpecs(), { create_time: -1 }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { create_time: (ADMISSION + 2 * DAY_MS) / 1000 }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { create_time: "1000" }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { create_time: Number.POSITIVE_INFINITY }), "invalid_conversation");
  itemError(mappingConversation(standardSpecs(), { update_time: 999 }), "invalid_conversation");
  itemError(
    mappingConversation([
      { key: "root", parent: null, children: [], message: textMessage("m1", "user", "x", { create_time: -1 }) },
    ]),
    "invalid_conversation",
  );
  itemError(
    mappingConversation([
      {
        key: "root",
        parent: null,
        children: [],
        message: textMessage("m1", "user", "x", { create_time: (ADMISSION + 2 * DAY_MS) / 1000 }),
      },
    ]),
    "invalid_conversation",
  );
});

test("accepts non-monotonic message times without reordering the transcript", () => {
  const conversation = validConversation([
    mappingConversation([
      { key: "root", parent: null, children: ["b"], message: textMessage("m1", "user", "first", { create_time: 3000 }) },
      { key: "b", parent: "root", children: [], message: textMessage("m2", "assistant", "second", { create_time: 1000 }) },
    ]),
  ]);
  assert.deepEqual(
    conversation.messages.map((message) => [message.id, message.createdAt]),
    [
      ["m1", 3_000_000],
      ["m2", 1_000_000],
    ],
  );
});

// ---------------------------------------------------------------------------
// Mapping: per-file and per-conversation caps
// ---------------------------------------------------------------------------

test("rejects more conversations than the file limit", () => {
  const many = Array.from({ length: IMPORT_LIMITS.conversations + 1 }, (_, index) =>
    mappingConversation(standardSpecs(), { id: `conv-${index}` }),
  );
  assert.equal(framingError(many), "too_large");
});

test("accepts exactly the conversation limit", () => {
  const many = Array.from({ length: IMPORT_LIMITS.conversations }, (_, index) =>
    mappingConversation(standardSpecs(), { id: `conv-${index}` }),
  );
  const result = normalize(many);
  assert.equal(result.items.length, IMPORT_LIMITS.conversations);
  assert.equal(result.items.every((item) => item.conversation !== null), true);
});

test("rejects a conversation above the node limit", () => {
  const specs: NodeSpec[] = [];
  let parent: string | null = null;
  for (let index = 0; index < IMPORT_LIMITS.nodesPerConversation + 1; index += 1) {
    const key = `n${index}`;
    specs.push({
      key,
      parent,
      children: [],
      message: textMessage(`m${index}`, index % 2 === 0 ? "user" : "assistant", "x", { create_time: 1000 }),
    });
    if (parent !== null) specs.find((spec) => spec.key === parent)!.children = [key];
    parent = key;
  }
  itemError(mappingConversation(specs), ["too_large", "invalid_conversation"]);
});

test("rejects a file above the total node limit instead of importing silently", () => {
  const big = (id: string): Obj => {
    const specs: NodeSpec[] = [];
    let parent: string | null = null;
    for (let index = 0; index < IMPORT_LIMITS.nodesPerConversation; index += 1) {
      const key = `n${index}`;
      specs.push({
        key,
        parent,
        children: [],
        message: textMessage(`m${index}`, index % 2 === 0 ? "user" : "assistant", "x", { create_time: 1000 }),
      });
      if (parent !== null) specs.find((spec) => spec.key === parent)!.children = [key];
      parent = key;
    }
    return mappingConversation(specs, { id, update_time: undefined });
  };
  const conversations = Array.from({ length: 11 }, (_, index) => big(`conv-${index}`));
  try {
    const result = normalize(conversations);
    assert.equal(
      result.items.every((item) => item.conversation === null),
      true,
      "over-total nodes must not produce importable conversations",
    );
  } catch (error) {
    assert.ok(error instanceof ImportFailure);
    assert.equal(error.code, "too_large");
  }
});

// ---------------------------------------------------------------------------
// Framing detection
// ---------------------------------------------------------------------------

test("rejects empty and structurally unsupported roots", () => {
  assert.equal(framingError([]), "empty_conversation");
  assert.equal(framingError({ hello: "world" }), "unsupported_format");
  assert.equal(framingError({ format: "other.format", version: 1, conversations: [] }), "unsupported_format");
  assert.equal(framingError({ format: 1, version: 1, conversations: [] }), "unsupported_format");
  assert.equal(framingError({ format: "okaychat.conversations", version: 1, exportedAt: 1, conversations: {} }), "invalid_conversation");
  // Non-container roots are not a supported format.
  assert.equal(framingError("text"), "unsupported_format");
  assert.equal(framingError(42), "unsupported_format");
  assert.equal(framingError(null), "unsupported_format");
});

test("never falls back to mapping detection after a format discriminator", () => {
  // A portable-shaped object that also carries mapping data must not be treated as a mapping export.
  assert.equal(
    framingError({
      format: "okaychat.conversations",
      version: 1,
      exportedAt: ADMISSION,
      conversations: [portableConversation()],
      mapping: {},
    }),
    "invalid_conversation",
  );
});

test("invalid individual conversations keep the rest of the file selectable", () => {
  const broken = mappingConversation(standardSpecs(), { id: "broken", current_node: "missing" });
  const result = normalize([broken, mappingConversation(standardSpecs(), { id: "good" })]);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]!.conversation, null);
  assert.equal(result.items[0]!.errorCode, "invalid_tree");
  assert.equal(result.items[1]!.errorCode, null);
  assert.ok(result.items[1]!.conversation !== null);
});

test("invalidates every occurrence of a duplicate source identity", () => {
  const first = mappingConversation(standardSpecs(), { id: "same" });
  const second = mappingConversation(standardSpecs(), { id: "same" });
  const third = mappingConversation(standardSpecs(), { id: "other" });
  const result = normalize([first, second, third]);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0]!.errorCode, "duplicate_source");
  assert.equal(result.items[1]!.errorCode, "duplicate_source");
  assert.equal(result.items[0]!.conversation, null);
  assert.equal(result.items[1]!.conversation, null);
  assert.equal(result.items[2]!.errorCode, null);
  assert.ok(result.items[2]!.conversation !== null);

  // An invalid occurrence still claims its identity and invalidates the valid one.
  const validOne = mappingConversation(standardSpecs(), { id: "mixed" });
  const invalidOne = mappingConversation(standardSpecs(), { id: "mixed", current_node: "missing" });
  const mixed = normalize([validOne, invalidOne]);
  assert.equal(mixed.items[0]!.errorCode, "duplicate_source");
  assert.equal(mixed.items[1]!.errorCode, "duplicate_source");
  assert.equal(mixed.items[0]!.conversation, null);
  assert.equal(mixed.items[1]!.conversation, null);
});

test("keeps per-item projections well formed", () => {
  const broken = mappingConversation(standardSpecs(), { id: "broken", current_node: "missing" });
  const result = normalize([mappingConversation(standardSpecs()), broken]);
  for (const [index, item] of result.items.entries()) {
    assert.equal(item.ordinal, index);
    assert.equal(item.conversation === null, item.errorCode !== null);
    assert.equal(Array.isArray(item.warnings), true);
    for (const warning of item.warnings) {
      assert.equal(WARNING_CODES.has(warning.code), true);
      assert.equal(warning.count > 0, true);
    }
    for (const value of Object.values(item.counts)) assert.equal(value >= 0, true);
  }
});

// ---------------------------------------------------------------------------
// Portable v1: schema and strictness
// ---------------------------------------------------------------------------

test("accepts a strict portable file and preserves conversation identity", () => {
  const file = portableFile([portableConversation()]);
  const item = oneItem(file);
  assert.equal(item.errorCode, null);
  assert.deepEqual(item.conversation, portableConversation());
  assert.deepEqual(item.counts, {
    sourceNodes: 2,
    sourceMessages: 2,
    discardedBranchNodes: 0,
    discardedBranchMessages: 0,
    quarantine: 0,
    omittedAttachments: 0,
  });
});

test("accepts source namespaces mapping-v1 and portable-v1 in portable input", () => {
  for (const namespace of ["mapping-v1", "portable-v1"] as const) {
    const conversation = portableConversation({ source: { namespace, id: "imported-1" } });
    assert.deepEqual(validConversation(portableFile([conversation])).source, { namespace, id: "imported-1" });
  }
  itemError(portableFile([portableConversation({ source: { namespace: "other" as never, id: "x" } })]), "invalid_conversation");
});

test("rejects unknown portable fields at every object level", () => {
  assert.equal(framingError(portableFile([portableConversation()], { extra: 1 })), "invalid_conversation");
  itemError(portableFile([{ ...portableConversation(), extra: 1 }]), "invalid_conversation");

  const extraSource = portableConversation({ source: { namespace: "portable-v1", id: "x", extra: 1 } as never });
  itemError(portableFile([extraSource]), "invalid_conversation");

  const extraMessage = structuredClone(portableConversation());
  rec(msgAt(extraMessage, 0)).extra = 1;
  itemError(portableFile([extraMessage]), "invalid_conversation");

  const extraPart = structuredClone(portableConversation());
  rec(partOf(extraPart, 0, 0)).extra = 1;
  itemError(portableFile([extraPart]), "invalid_conversation");
});

test("rejects unsupported portable versions and discriminators", () => {
  assert.equal(framingError(portableFile([portableConversation()], { version: 2 })), "unsupported_version");
  assert.equal(framingError(portableFile([portableConversation()], { version: "1" })), "unsupported_version");
  assert.equal(framingError({ format: "okaychat.conversations.v2", version: 1, exportedAt: 1, conversations: [] }), "unsupported_format");
  assert.equal(framingError(portableFile([])), "empty_conversation");
});

test("validates portable conversation and message fields strictly", () => {
  itemError(portableFile([portableConversation({ createdAt: 3000, updatedAt: 2000 })]), "invalid_conversation");
  itemError(portableFile([portableConversation({ status: "pinned" as never })]), "invalid_conversation");
  itemError(portableFile([portableConversation({ title: 7 as never })]), "invalid_conversation");
  itemError(portableFile([portableConversation({ messages: [] })]), ["empty_conversation", "invalid_conversation"]);
  itemError(portableFile([portableConversation({ source: { namespace: "portable-v1", id: "bad id" } })]), "invalid_conversation");

  const badRole = portableConversation();
  rec(msgAt(badRole, 0)).role = "system";
  itemError(portableFile([badRole]), "invalid_conversation");

  const badOriginalRole = portableConversation();
  rec(msgAt(badOriginalRole, 0)).originalRole = "system";
  itemError(portableFile([badOriginalRole]), "invalid_conversation");

  const nullOriginalRole = portableConversation({
    messages: [portableMessage("m1", "tool", [{ type: "historical-tool", name: "tool", text: "x" }], { originalRole: null })],
  });
  itemError(portableFile([nullOriginalRole]), "invalid_conversation");

  const emptyOriginalRole = portableConversation({
    messages: [portableMessage("m1", "quarantine", [portableText("x")], { originalRole: "" })],
  });
  itemError(portableFile([emptyOriginalRole]), "invalid_conversation");

  const duplicateMessage = portableConversation({
    messages: [portableMessage("m1", "user", [portableText("a")]), portableMessage("m1", "assistant", [portableText("b")])],
  });
  itemError(portableFile([duplicateMessage]), "invalid_conversation");
});

test("enforces portable role and part combinations", () => {
  const quarantine = portableConversation({
    messages: [
      portableMessage("m1", "quarantine", [
        portableText("system text"),
        { type: "missing-attachment", kind: "image", name: null },
      ]),
    ],
  });
  assert.equal(validConversation(portableFile([quarantine])).messages[0]!.role, "quarantine");

  const tool = portableConversation({
    messages: [portableMessage("m1", "tool", [{ type: "historical-tool", name: "tool", text: "out" }])],
  });
  assert.equal(validConversation(portableFile([tool])).messages[0]!.role, "tool");

  const assistantTool = portableConversation({
    messages: [portableMessage("m1", "assistant", [{ type: "historical-tool", name: "tool", text: "out" }])],
  });
  assert.equal(validConversation(portableFile([assistantTool])).messages[0]!.role, "assistant");

  const userTool = portableConversation({
    messages: [portableMessage("m1", "user", [{ type: "historical-tool", name: "tool", text: "out" }])],
  });
  itemError(portableFile([userTool]), "invalid_conversation");

  const toolText = portableConversation({
    messages: [portableMessage("m1", "tool", [portableText("out")])],
  });
  itemError(portableFile([toolText]), "invalid_conversation");

  const quarantineTool = portableConversation({
    messages: [portableMessage("m1", "quarantine", [{ type: "historical-tool", name: "tool", text: "out" }])],
  });
  itemError(portableFile([quarantineTool]), "invalid_conversation");

  const badKind = portableConversation({
    messages: [portableMessage("m1", "user", [{ type: "missing-attachment", kind: "sticker" as never, name: null }])],
  });
  itemError(portableFile([badKind]), "invalid_conversation");

  const emptyParts = portableConversation({ messages: [portableMessage("m1", "user", [])] });
  itemError(portableFile([emptyParts]), ["too_large", "invalid_conversation"]);
});

test("enforces strict portable time bounds and integers", () => {
  assert.equal(validConversation(portableFile([portableConversation()])).createdAt, 1000);
  assert.equal(
    validConversation(
      portableFile([portableConversation({ createdAt: ADMISSION + DAY_MS, updatedAt: ADMISSION + DAY_MS })]),
    ).updatedAt,
    ADMISSION + DAY_MS,
  );
  for (const value of [-1, 1.5, ADMISSION + DAY_MS + 1, Number.NaN]) {
    itemError(portableFile([portableConversation({ createdAt: value })]), "invalid_conversation");
  }
  const badMessageTime = portableConversation();
  rec(msgAt(badMessageTime, 0)).createdAt = 1.5;
  itemError(portableFile([badMessageTime]), "invalid_conversation");

  const futureMessage = portableConversation();
  rec(msgAt(futureMessage, 0)).createdAt = ADMISSION + DAY_MS + 1;
  itemError(portableFile([futureMessage]), "invalid_conversation");

  // Message timestamps need not be monotonic or unique.
  const unordered = portableConversation({
    messages: [
      portableMessage("m1", "user", [portableText("a")], { createdAt: 2000 }),
      portableMessage("m2", "assistant", [portableText("b")], { createdAt: 1000 }),
    ],
  });
  assert.deepEqual(
    validConversation(portableFile([unordered])).messages.map((message) => message.createdAt),
    [2000, 1000],
  );
});

test("validates the portable envelope timestamps", () => {
  for (const exportedAt of [-1, 1.5, ADMISSION + DAY_MS + 1, Number.NaN]) {
    assert.equal(framingError(portableFile([portableConversation()], { exportedAt })), "invalid_conversation");
  }
  assert.doesNotThrow(() => normalize(portableFile([portableConversation()], { exportedAt: ADMISSION + DAY_MS })));
});

test("enforces strict portable text, part and title bounds", () => {
  const atLimit = "a".repeat(IMPORT_LIMITS.messageBytes);
  assert.doesNotThrow(() =>
    normalize(
      portableFile([
        portableConversation({ messages: [portableMessage("m1", "user", [portableText(atLimit)])] }),
      ]),
    ),
  );
  itemError(
    portableFile([
      portableConversation({ messages: [portableMessage("m1", "user", [portableText(`${atLimit}b`)])] }),
    ]),
    ["too_large", "invalid_conversation"],
  );

  const tooManyParts = Array.from({ length: IMPORT_LIMITS.parts + 1 }, () => portableText("x"));
  itemError(
    portableFile([portableConversation({ messages: [portableMessage("m1", "user", tooManyParts)] })]),
    ["too_large", "invalid_conversation"],
  );

  const longTitle = "😀".repeat(201);
  const item = oneItem(portableFile([portableConversation({ title: longTitle })]));
  assert.equal(Array.from(item.conversation!.title!).length, 200);
  hasWarning(item, "title_shortened");

  const longLabel = portableConversation({
    messages: [portableMessage("m1", "user", [{ type: "missing-attachment", kind: "file", name: "n".repeat(241) }])],
  });
  const labelItem = oneItem(portableFile([longLabel]));
  const labelPart = labelItem.conversation!.messages[0]!.parts[0]!;
  assert.equal(labelPart.type, "missing-attachment");
  assert.equal(Array.from(labelPart.name ?? "").length, 240);
  hasWarning(labelItem, "label_shortened");
});

test("invalidates duplicate portable source identities across the file", () => {
  const first = portableConversation({ source: { namespace: "portable-v1", id: "same" } });
  const second = portableConversation({ source: { namespace: "portable-v1", id: "same" } });
  const third = portableConversation({ source: { namespace: "mapping-v1", id: "same" } });
  const result = normalize(portableFile([first, second, third]));
  assert.equal(result.adapter, "portable-v1");
  assert.equal(result.items[0]!.errorCode, "duplicate_source");
  assert.equal(result.items[1]!.errorCode, "duplicate_source");
  assert.equal(result.items[2]!.errorCode, null);
});

test("applies the conversation byte and message count caps to portable files", () => {
  const bigMessages = Array.from({ length: 9 }, (_, index) =>
    portableMessage(`m${index}`, index % 2 === 0 ? "user" : "assistant", [
      portableText("x".repeat(250 * 1024)),
    ]),
  );
  itemError(portableFile([portableConversation({ messages: bigMessages })]), ["too_large", "invalid_conversation"]);

  const tooManyMessages = Array.from({ length: IMPORT_LIMITS.nodesPerConversation + 1 }, (_, index) =>
    portableMessage(`m${index}`, "user", [portableText("x")]),
  );
  itemError(portableFile([portableConversation({ messages: tooManyMessages })]), ["too_large", "invalid_conversation"]);
});

// ---------------------------------------------------------------------------
// Round trip and sanitizer idempotence
// ---------------------------------------------------------------------------

test("mapping to portable round trip preserves the normalized transcript", () => {
  const specs: NodeSpec[] = [
    { key: "root", parent: null, children: ["answer"], message: textMessage("m1", "user", "hello", { create_time: 1000 }) },
    {
      key: "answer",
      parent: "root",
      children: ["tool"],
      message: {
        id: "m2",
        author: { role: "assistant" },
        content: {
          content_type: "multimodal_text",
          parts: ["answer", { content_type: "image_asset_pointer" }],
        },
        create_time: 1001,
      },
    },
    {
      key: "tool",
      parent: "answer",
      children: ["note"],
      message: {
        id: "m3",
        author: { role: "tool" },
        content: { content_type: "text", parts: ["tool output"] },
        create_time: 1002,
      },
    },
    {
      key: "note",
      parent: "tool",
      children: [],
      message: {
        id: "m4",
        author: { role: "system" },
        content: { content_type: "text", parts: ["system note"] },
        create_time: 1003,
      },
    },
  ];
  const imported = validConversation([
    mappingConversation(specs, { create_time: 1000, update_time: undefined, title: "Round trip" }),
  ]);
  assert.deepEqual(
    imported.messages.map((message) => message.role),
    ["user", "assistant", "tool", "quarantine"],
  );

  const result = normalize(portableFile([imported]));
  assert.equal(result.adapter, "portable-v1");
  assert.equal(result.items[0]!.errorCode, null);
  assert.deepEqual(result.items[0]!.conversation, imported);
});

test("sanitization is idempotent for stored text", () => {
  const source = "line one\r\nline two <b>bold</b> `code <tag>`";
  const first = validConversation([
    mappingConversation([
      { key: "root", parent: null, children: [], message: textMessage("m1", "user", source) },
    ]),
  ]);
  const second = normalize(portableFile([first]));
  assert.deepEqual(second.items[0]!.conversation, first);
});
