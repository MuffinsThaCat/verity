import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AnthropicLLM, OpenAICompatLLM } from "../src/lib/llm.js";

const Schema = z.object({ ok: z.boolean() });
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("a model that answers is healthy", async () => {
  const llm = new AnthropicLLM("k", "m", "https://x.invalid", reply(200, { content: [{ type: "text", text: '{"ok":true}' }] }));
  assert.deepEqual(await llm.json({ system: "s", user: "u", schema: Schema }), { ok: true });
  assert.deepEqual(llm.health(), { calls: 1, failures: 0, last: null });
});

test("a refused request is counted, with the reason, instead of passing quietly as 'no verdict'", async () => {
  const warn = console.warn; const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const llm = new AnthropicLLM("bad", "m", "https://x.invalid", reply(401, { error: "invalid x-api-key" }));
    assert.equal(await llm.json({ system: "s", user: "u", schema: Schema }), null);
    assert.equal(await llm.json({ system: "s", user: "u", schema: Schema }), null);
    const h = llm.health();
    assert.equal(h.calls, 2); assert.equal(h.failures, 2);
    assert.match(h.last ?? "", /HTTP 401/);
    assert.equal(lines.length, 1, "said once, not on every call");
    assert.match(lines[0]!, /returned nothing usable/);
  } finally { console.warn = warn; }
});

test("an answer that is not the JSON asked for, and a network error, are failures too", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const odd = new OpenAICompatLLM("https://x.invalid/v1", "k", "m", reply(200, { choices: [{ message: { content: "sorry, I cannot" } }] }));
    assert.equal(await odd.json({ system: "s", user: "u", schema: Schema }), null);
    assert.match(odd.health().last ?? "", /not the JSON/);
    const down = new OpenAICompatLLM("https://x.invalid/v1", "k", "m", (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch);
    assert.equal(await down.json({ system: "s", user: "u", schema: Schema }), null);
    assert.match(down.health().last ?? "", /ENOTFOUND/);
  } finally { console.warn = warn; }
});
