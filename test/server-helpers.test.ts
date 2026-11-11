import { test } from "node:test";
import assert from "node:assert/strict";
import { clientAddress, createClaimOnce, publicUrl, selectArticles } from "../src/server.js";
import { splitSentences } from "../src/lib/offlineJudge.js";

const req = (headers: Record<string, string | string[]>, addr = "10.0.0.1") => ({ headers, socket: { remoteAddress: addr } }) as never;

test("a rate-limited claim creation is never sent twice and never reported as failed when it landed", async () => {
  const limited = () => new Error('{"error": {"code": -429, "message": "Rate limit of your project plan exceeded"}}');
  const now = Date.now();
  const mk = (sends: { n: number }, onChain: Array<{ id: number; text: string; creator: string; created_ms: number }>, fail: (n: number) => boolean) => ({
    accountId: "demo.testnet",
    createClaim: async () => { sends.n++; if (fail(sends.n)) throw limited(); return 41; },
    claimsByTopic: async () => onChain,
  }) as never;
  const nowait = async () => {};

  // The transaction landed, then the 429 arrived: found on the chain, not sent again.
  const a = { n: 0 };
  assert.equal(await createClaimOnce(mk(a, [{ id: 40, text: "S", creator: "demo.testnet", created_ms: now }], () => true), "t", "S", 5000, 1n, now, nowait), 40);
  assert.equal(a.n, 1);
  // It never landed: sent again, once, and that succeeds.
  const b = { n: 0 };
  assert.equal(await createClaimOnce(mk(b, [], (n) => n === 1), "t", "S", 5000, 1n, now, nowait), 41);
  assert.equal(b.n, 2);
  // Somebody else's identical sentence, or an older one by the same account, is not ours.
  const c = { n: 0 };
  assert.equal(await createClaimOnce(mk(c, [{ id: 9, text: "S", creator: "other.testnet", created_ms: now }, { id: 8, text: "S", creator: "demo.testnet", created_ms: now - 600_000 }], (n) => n === 1), "t", "S", 5000, 1n, now, nowait), 41);
  assert.equal(c.n, 2);
  // Still limited after the retries: the error is reported, after a bounded number of sends.
  const d = { n: 0 };
  await assert.rejects(createClaimOnce(mk(d, [], () => true), "t", "S", 5000, 1n, now, nowait), /Rate limit/);
  assert.equal(d.n, 3);
  // Any other failure is reported at once.
  const e = { n: 0 };
  await assert.rejects(createClaimOnce({ accountId: "x", createClaim: async () => { e.n++; throw new Error("not enough balance"); }, claimsByTopic: async () => [] } as never, "t", "S", 5000, 1n, now, nowait), /not enough balance/);
  assert.equal(e.n, 1);
});

test("/api/config never shows an RPC provider's key", () => {
  assert.equal(publicUrl("https://rpc.testnet.fastnear.com?apiKey=SECRET"), "https://rpc.testnet.fastnear.com");
  assert.equal(publicUrl("https://user:SECRET@rpc.example.org/path/?token=SECRET#x"), "https://rpc.example.org/path");
  assert.equal(publicUrl("http://127.0.0.1:3030"), "http://127.0.0.1:3030");
  assert.equal(publicUrl("not a url"), "");
});

test("without a trusted proxy the client is the connection's address, whatever the headers say", () => {
  assert.equal(clientAddress(req({ "x-forwarded-for": "1.2.3.4" }), false), "10.0.0.1");
});

test("behind a trusted proxy the client is the last X-Forwarded-For entry, the one the proxy added", () => {
  assert.equal(clientAddress(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), true), "203.0.113.9");
  assert.equal(clientAddress(req({ "x-forwarded-for": ["6.6.6.6", "203.0.113.9"] }), true), "203.0.113.9");
  assert.equal(clientAddress(req({}), true), "10.0.0.1", "no header: fall back to the socket");
});

test("a server follows its first articles, or exactly the ones it is told to", () => {
  const roots = ["pluto", "everest", "junk1", "junk2", "junk3"];
  assert.deepEqual(selectArticles(roots, undefined, 2), ["pluto", "everest"]);
  assert.deepEqual(selectArticles(roots, [], 3), ["pluto", "everest", "junk1"]);
  assert.deepEqual(selectArticles(roots, ["junk2", "pluto"], 1), ["pluto", "junk2"], "an explicit list wins, in creation order");
});

test("a 2 MB line of initials is split in well under a few seconds", () => {
  const t0 = Date.now();
  splitSentences("A. B. ".repeat(350_000));
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test("ordinary sentences, initials and abbreviations still split as before", () => {
  const out = splitSentences("Pluto was discovered by Clyde W. Tombaugh in 1930. It is a dwarf planet in the Kuiper belt. Mt. Everest is the highest mountain above sea level.");
  assert.equal(out.length, 3);
  assert.match(out[0]!, /Clyde W\. Tombaugh/);
});

import { followedArticles } from "../src/lib/scope.js";

test("the agents' followed articles come from the topic list in creation order, skip the link topic, and are cached", async () => {
  let calls = 0; let clock = 0;
  const all = ["pluto/moons", "pluto", "meta:links", "everest", "junk1", "junk2"];
  const chain = { topics: async (from = 0, limit = 200) => { calls++; return all.slice(from, from + limit); } };
  const f = followedArticles(chain, undefined, 2, 1000, () => clock);
  assert.deepEqual([...(await f())], ["pluto", "everest"]);
  await f();
  assert.equal(calls, 1, "answered from memory");
  clock = 1500;
  await f();
  assert.equal(calls, 2, "one more look, which finds nothing new");
  assert.deepEqual([...(await followedArticles(chain, ["junk2"], 2)())], ["junk2"]);
});

import { TopicIndex } from "../src/lib/scope.js";

test("the topic index pages through a long list once, then asks only for what is new", async () => {
  const all: string[] = [];
  for (let i = 0; i < 1_050; i++) all.push(i % 3 === 0 ? `art${Math.floor(i / 3)}` : `art${Math.floor(i / 3)}/sec${i % 3}`);
  const asked: Array<[number, number]> = [];
  const chain = { topics: async (from = 0, limit = 200) => { asked.push([from, limit]); return all.slice(from, from + Math.min(limit, 200)); } };
  const index = new TopicIndex(chain, 200);
  assert.equal((await index.refresh()).length, 1_050);
  assert.equal(asked.length, 6, "five full pages and a short one");
  assert.ok(asked.every(([, l]) => l <= 200), "no page asks for more than the contract returns");
  asked.length = 0;
  await index.refresh();
  assert.deepEqual(asked, [[1_050, 200]], "a second look asks only past what it has");
  all.push("newcomer");
  await index.refresh();
  assert.equal(index.list[index.list.length - 1], "newcomer");
  assert.equal(index.roots().length, 351, "350 articles and the newcomer, each once, in creation order");
  assert.equal(index.roots()[0], "art0");
});

test("the link topic is not an article", async () => {
  const index = new TopicIndex({ topics: async (from = 0) => (from === 0 ? ["meta:links", "pluto"] : []) });
  await index.refresh();
  assert.deepEqual(index.roots(), ["pluto"]);
});

import { AppendIndex, createScope } from "../src/lib/scope.js";

test("two refreshes started together share one read: no page is appended twice and nothing is skipped afterwards", async () => {
  const all = Array.from({ length: 450 }, (_, i) => `t${i}`);
  let calls = 0;
  const index = new AppendIndex<string>(async (from, limit) => { calls++; await new Promise((r) => setTimeout(r, 5)); return all.slice(from, from + limit); }, 200);
  const [a, b, c] = await Promise.all([index.refresh(), index.refresh(), index.refresh()]);
  assert.equal(a.length, 450);
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  assert.equal(calls, 3, "three pages, read once for all three callers");
  all.push("later");
  await Promise.all([index.refresh(), index.refresh()]);
  assert.equal(index.list.length, 451);
  assert.equal(index.list[450], "later");
  assert.equal(new Set(index.list).size, 451, "no entry twice");
});

test("a failed read leaves the list consistent and the next one carries on from where it stopped", async () => {
  const all = Array.from({ length: 450 }, (_, i) => `t${i}`);
  let fail = true;
  const index = new AppendIndex<string>(async (from, limit) => { if (from >= 200 && fail) { fail = false; throw new Error("rpc down"); } return all.slice(from, from + limit); }, 200);
  await assert.rejects(index.refresh(), /rpc down/);
  assert.equal(index.list.length, 200);
  await index.refresh();
  assert.equal(index.list.length, 450);
  assert.equal(new Set(index.list).size, 450);
});

test("the scope reads claims page by page when that takes fewer calls than one per followed topic, and topic by topic otherwise", async () => {
  const topics = ["a", "a/x", "a/y", "b", "b/x", "junk"];
  const claim = (id: number, topic: string) => ({ id, topic }) as never;
  const calls: string[] = [];
  const make = (claims: number) => ({
    topics: async (from = 0, limit = 200) => topics.slice(from, from + limit),
    config: async () => ({ claims }) as never,
    allClaims: async () => { calls.push("all"); return [claim(1, "a")]; },
    claimsByTopic: async (t: string) => { calls.push(`topic:${t}`); return [claim(2, t)]; },
  });
  const few = createScope(make(120), ["a", "b"], 24);   // 3 pages <= 5 followed topics
  assert.equal((await few.claims()).length, 1);
  assert.deepEqual(calls, ["all"]);
  calls.length = 0;
  const many = createScope(make(5_000), ["a", "b"], 24); // 100 pages > 5 followed topics
  const got = await many.claims();
  assert.deepEqual(calls.sort(), ["topic:a", "topic:a/x", "topic:a/y", "topic:b", "topic:b/x"], "the junk topic is never read");
  assert.equal(got.length, 5);
});
