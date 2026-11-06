/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { formFieldOf, formPayload, formProblems, newRow, settledRows, type FormState } from "./custom-connection-state";

// The custom connection form's retain/replace/remove/rename state machine, origin re-entry, immediate
// reserved-header feedback, and server field mapping. The server remains the authority.

const saved = (overrides: Partial<FormState> = {}): FormState => ({
  own: true,
  creating: false,
  name: "",
  baseURL: "https://gw.example/v1",
  savedBaseURL: "https://gw.example/v1",
  apiKey: "",
  removeKey: false,
  hasSavedKey: true,
  savedAuth: { mode: "api-key", headerName: "x-api-key" },
  authMode: "api-key",
  headerName: "x-api-key",
  headers: [newRow("x-extra")],
  query: [newRow("api-version")],
  savedHeaderCount: 1,
  savedQueryCount: 1,
  sourceMode: "discover",
  ids: "",
  savedSource: { mode: "discover" },
  ...overrides,
});

const fields = (state: FormState) => formProblems(state).map(([field, reason]) => `${field}:${reason}`);

test("an unchanged edit sends no secrets and keeps the saved configuration", () => {
  const state = saved();
  assert.deepEqual(fields(state), []);
  assert.deepEqual(formPayload(state), { enabled: true });
});

test("replace, retain, rename, and remove produce the documented rows", () => {
  const headers = [newRow("x-extra"), newRow("x-old"), newRow("x-gone"), newRow()];
  headers[0]!.value = "new";
  headers[1]!.name = "x-renamed";
  headers[2]!.removed = true;
  headers[3]!.name = "x-added";
  headers[3]!.value = "v";
  const query = [newRow("api-version")];
  const state = saved({ headers, query, savedHeaderCount: 3 });
  // The rename lost its saved value and needs a new one.
  assert.deepEqual(fields(state), ["transport.headers.1.value:required"]);
  headers[1]!.value = "r";
  const payload = formPayload(saved({ headers, query, savedHeaderCount: 3 }));
  assert.deepEqual(payload.transport?.headers, [{ name: "x-extra", value: "new" }, { name: "x-renamed", value: "r" }, { name: "x-added", value: "v" }]);
  // An untouched saved row is sent by name only: retain, never a mask.
  assert.deepEqual(payload.transport?.query, [{ name: "api-version" }]);
  assert.ok(!JSON.stringify(payload).includes("Saved value"));
  assert.equal(payload.apiKey, undefined);
});

test("an origin change asks for every saved value again and allows removal instead", () => {
  const state = saved({ baseURL: "https://other.example/v1" });
  assert.deepEqual(fields(state), ["apiKey:secret_reentry_required", "transport.headers.0.value:secret_reentry_required", "transport.query.0.value:secret_reentry_required"]);
  const headers = [newRow("x-extra")];
  headers[0]!.removed = true;
  const query = [newRow("api-version")];
  query[0]!.value = "2024-10-21";
  const ready = saved({ baseURL: "https://other.example/v1", apiKey: "k", headers, query });
  assert.deepEqual(fields(ready), []);
  const payload = formPayload(ready);
  assert.deepEqual(payload.transport?.headers, []);
  assert.deepEqual(payload.transport?.query, [{ name: "api-version", value: "2024-10-21" }]);
  assert.equal(payload.baseURL, "https://other.example/v1");
});

test("switching auth needs the key again; headers mode refuses a key and the remove control sends an empty key", () => {
  assert.deepEqual(fields(saved({ authMode: "bearer" })), ["apiKey:secret_reentry_required"]);
  assert.deepEqual(fields(saved({ headerName: "x-other" })), ["apiKey:secret_reentry_required"]);
  assert.deepEqual(fields(saved({ authMode: "headers", apiKey: "k" })), ["apiKey:key_not_allowed"]);
  assert.deepEqual(fields(saved({ authMode: "api-key", removeKey: true })), ["apiKey:required"]);
  assert.equal(formPayload(saved({ authMode: "bearer", removeKey: true })).apiKey, "");
});

test("reserved and colliding header names are reported as soon as they are typed", () => {
  for (const name of ["Authorization", "Cookie", "sec-ch-ua", "Proxy-Thing", ":path", "HOST"]) {
    const headers = [newRow()];
    headers[0]!.name = name;
    headers[0]!.value = "v";
    assert.deepEqual(fields(saved({ headers, savedHeaderCount: 0 })), ["transport.headers.0.name:reserved_header"], name);
  }
  const headers = [newRow()];
  headers[0]!.name = "X-API-KEY";
  headers[0]!.value = "v";
  assert.deepEqual(fields(saved({ headers, savedHeaderCount: 0 })), ["transport.headers.0.name:auth_header_collision"]);
  const crlf = [newRow()];
  crlf[0]!.name = "x-a";
  crlf[0]!.value = "a\r\nb";
  assert.deepEqual(fields(saved({ headers: crlf, savedHeaderCount: 0 })), ["transport.headers.0.value:control_character"]);
});

test("a deployment address needs exactly its manual id", () => {
  const base = "https://res.example/openai/deployments/team-chat";
  const create = (ids: string, sourceMode: "discover" | "manual") => saved({ own: false, creating: true, name: "Azure", baseURL: base, savedBaseURL: undefined, hasSavedKey: false, apiKey: "k", headers: [], query: [], sourceMode, ids });
  assert.ok(fields(create("", "discover")).includes("modelSource:deployment_mismatch"));
  assert.ok(fields(create("other", "manual")).includes("modelSource:deployment_mismatch"));
  assert.deepEqual(fields(create("team-chat", "manual")), []);
  assert.deepEqual(formPayload(create("team-chat", "manual")).modelSource, { mode: "manual", ids: ["team-chat"] });
});

test("server row indexes map back to form rows that include removed rows", () => {
  const headers = [newRow("x-a"), newRow("x-b"), newRow("x-c")];
  headers[0]!.removed = true;
  assert.equal(formFieldOf("transport.headers.1.name", { headers, query: [] }), "transport.headers.2.name");
  assert.equal(formFieldOf("transport.headers.9.value", { headers, query: [] }), "transport.headers");
  assert.equal(formFieldOf("apiKey", { headers, query: [] }), "apiKey");
});

test("after a save, typed values are cleared and removed rows disappear", () => {
  const rows = [newRow("x-a"), newRow()];
  rows[0]!.removed = true;
  rows[1]!.name = "x-b";
  rows[1]!.value = "secret";
  rows[1]!.revealed = true;
  assert.deepEqual(settledRows(rows).map(({ name, value, savedName, revealed }) => ({ name, value, savedName, revealed })), [{ name: "x-b", value: "", savedName: "x-b", revealed: false }]);
});
