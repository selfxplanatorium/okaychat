import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { asSchema, wrapLanguageModel } from "ai";
import { z } from "zod";
import { openaiToolSchema, openaiToolSchemas } from "./openai-schema.js";

const record = z.object({ fields: z.record(z.union([z.string().startsWith("x-"), z.string().startsWith("y-")]), z.number()) });

for (const mode of ["generate", "stream"] as const) {
  test(`OpenAI ${mode} accepts a tool with implicit string propertyNames`, async () => {
    const schema = await asSchema(record).jsonSchema;
    const original = structuredClone(schema);
    let requests = 0;
    const provider = createOpenAI({
      apiKey: "test-only",
      fetch: async (_input, init) => {
        requests++;
        const body = JSON.parse(init!.body as string);
        const parameters = body.tools[0].parameters;
        assert.equal("propertyNames" in parameters.properties.fields, false);
        assert.deepEqual(parameters.properties.fields.additionalProperties, { type: "number" });
        const response = { id: "resp_test", object: "response", created_at: 1, model: "gpt-test", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } };
        return mode === "generate"
          ? Response.json(response)
          : new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const options = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }], tools: [{ type: "function" as const, name: "test", inputSchema: schema }] };
    // This is the exact SDK error users saw, before a network request can be made.
    await assert.rejects(() => provider.responses("gpt-test").doGenerate(options), /propertyNames that does not use a string schema/);
    assert.equal(requests, 0);
    const model = wrapLanguageModel({ model: provider.responses("gpt-test"), middleware: openaiToolSchemas });
    if (mode === "generate") await model.doGenerate(options);
    else {
      const result = await model.doStream(options);
      for await (const part of result.stream) assert.notEqual(part.type, "error");
    }
    assert.equal(requests, 1);
    assert.deepEqual(schema, original);
    assert.equal(record.safeParse({ fields: { invalid: 1 } }).success, false);
  });
}

test("normalization visits nested schema positions without touching literal data or names", () => {
  const nested = { type: "object" as const, propertyNames: { enum: ["a", "b"] }, additionalProperties: { type: "number" as const } };
  const schema = {
    type: "object" as const,
    properties: { propertyNames: { type: "string" as const }, nested: { anyOf: [{ type: "array" as const, items: nested }, { $ref: "#/$defs/record" }] } },
    $defs: { record: nested },
    default: { propertyNames: "literal data" },
  };
  const before = structuredClone(schema);
  const normalized = openaiToolSchema(schema);
  assert.deepEqual(schema, before);
  assert.deepEqual(normalized.properties!.propertyNames, { type: "string" });
  assert.deepEqual(normalized.default, schema.default);
  assert.deepEqual(normalized.$defs!.record, { type: "object", additionalProperties: { type: "number" } });
  assert.equal(JSON.stringify(normalized.properties!.nested).includes('"enum"'), false);
  assert.equal(JSON.stringify(normalized.properties!.nested).includes('"$ref"'), true);
});
