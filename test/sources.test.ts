import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CachedProvider, Limiter, WikipediaProvider, cleanWikitext, searchQueryFor, searchSubjectsFor, sha256Hex, staticSource, verifyEvidenceHash, verifyEvidenceContent,
  type Source, type SourceProvider,
} from "../src/lib/sources.js";
import { gatherSources, chooseReading, type Reading } from "../src/agents/analyst.js";
import { CachedJudge, type Judge, type Verdict } from "../src/lib/judge.js";
import { articleOf, describeSource, prettyTopic, sectionOf } from "../src/lib/uri.js";
import { quotedText } from "../src/lib/wikitext.js";

const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const res = (status: number, body = "", headers: Record<string, string> = {}, url = "") =>
  ({ ok: status >= 200 && status < 300, status, url, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => bytes(body) }) as unknown as Response;

test("a 429 is retried after the server's Retry-After, and the wait is spent once, not per caller", async () => {
  let calls = 0;
  const waits: number[] = [];
  const f = (async () => (++calls === 1 ? res(429, "", { "retry-after": "3" }) : res(200, "hello"))) as unknown as typeof fetch;
  const out = await verifyEvidenceHash("https://en.wikipedia.org/x", sha256Hex("hello"), f, { limiter: new Limiter(0), sleepFn: async (ms) => { waits.push(ms); } });
  assert.ok(out.ok);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [3000]);
});

test("a 429 that never clears gives up after the retries instead of hanging", async () => {
  let calls = 0;
  const f = (async () => { calls++; return res(429); }) as unknown as typeof fetch;
  await assert.rejects(verifyEvidenceHash("https://en.wikipedia.org/x", "x", f, { limiter: new Limiter(0), retries: 2, sleepFn: async () => {} }), /429/);
  assert.equal(calls, 3);
});

test("the limiter runs requests one at a time", async () => {
  const lim = new Limiter(0);
  let running = 0, peak = 0;
  await Promise.all([1, 2, 3, 4].map(() => lim.run(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; })));
  assert.equal(peak, 1);
});

test("verification refuses a host that is not on the list, and a redirect to one", async () => {
  let called = false;
  const f = (async () => { called = true; return res(200, "x", {}, "https://evil.example/x"); }) as unknown as typeof fetch;
  await assert.rejects(verifyEvidenceHash("http://169.254.169.254/latest/meta-data", "x", f, { limiter: new Limiter(0), allowHosts: ["wikipedia.org"] }), /host not allowed/);
  assert.equal(called, false, "a refused host is never contacted");
  await assert.rejects(verifyEvidenceHash("https://en.wikipedia.org/x", "x", f, { limiter: new Limiter(0), allowHosts: ["wikipedia.org"] }), /redirected to a host that is not allowed/);
  await assert.rejects(verifyEvidenceHash("https://notwikipedia.org/x", "x", f, { limiter: new Limiter(0), allowHosts: ["wikipedia.org"] }), /host not allowed/, "a suffix match must respect the dot");
});

class Counting implements SourceProvider {
  readonly name = "counting";
  calls: string[] = [];
  constructor(private readonly docs: Source[]) {}
  async find(query: string) { this.calls.push(query); return this.docs; }
}

test("CachedProvider asks once, serves the rest from disk, and expires searches but not pages", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "verity-cache-"));
  const doc = staticSource("Pluto", "Pluto has five moons.");
  const inner = new Counting([doc]);
  let now = 1_000;
  const cache = new CachedProvider(inner, dir, { ttlMs: 100, now: () => now });
  const [a] = await cache.find("pluto moons", 2);
  const [b] = await cache.find("pluto moons", 2);
  assert.equal(inner.calls.length, 1);
  assert.deepEqual(a, b);
  await cache.find("pluto moons", 3);
  assert.equal(inner.calls.length, 2, "a different limit is a different question");
  now += 500;
  await cache.find("pluto moons", 2);
  assert.equal(inner.calls.length, 3, "a stale search is asked again");
  // a fresh process over the same directory sees what the first one stored
  const other = new CachedProvider(new Counting([]), dir, { offline: true });
  assert.equal((await other.find("pluto moons", 2))[0]!.contentHash, doc.contentHash);
  assert.deepEqual(await other.find("never asked", 2), [], "offline never reaches the network");
});

test("CachedProvider shares one in-flight request between agents asking the same thing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "verity-cache-"));
  let n = 0;
  const slow: SourceProvider = { name: "slow", find: async () => { n++; await new Promise((r) => setTimeout(r, 20)); return [staticSource("T", "text")]; } };
  const cache = new CachedProvider(slow, dir);
  await Promise.all([cache.find("q", 1), cache.find("q", 1), cache.find("q", 1)]);
  assert.equal(n, 1);
});

test("cleanWikitext keeps the figure inside a convert template and drops other templates", () => {
  const t = cleanWikitext("Its height is {{convert|8848.86|m|ft|abbr=on}} and it is {{Infobox x|a=b}}in Asia. {{nowrap|A B}} {{cite web|url=x}}");
  assert.match(t, /Its height is 8848\.86 m and it is in Asia\./);
  assert.match(t, /A B/);
  assert.ok(!t.includes("{{") && !t.includes("cite"));
  assert.match(cleanWikitext("{{convert|5|to|9|km}} long"), /5 to 9 km long/);
});

test("subjects are the named things in a claim, in order, without dates or a leading article", () => {
  assert.deepEqual(searchSubjectsFor("The International Astronomical Union reclassified Pluto as a dwarf planet in 2006."), ["International Astronomical Union", "Pluto"]);
  assert.deepEqual(searchSubjectsFor("Apollo 11 landed on the Moon on 20 July 1969."), ["Apollo 11", "Moon"]);
  assert.deepEqual(searchSubjectsFor("Edmund Hillary and Tenzing Norgay made the first confirmed ascent of Everest in 1953."), ["Edmund Hillary", "Tenzing Norgay", "Everest"]);
  assert.equal(searchQueryFor("The official height of Mount Everest is 8,848.86 metres."), "official height mount everest metres");
});

test("gatherSources interleaves the searches, de-duplicates by content and honours the limit", async () => {
  const doc = (t: string) => staticSource(t, `${t} text`);
  const lists: Record<string, Source[]> = {
    "pluto moons": [doc("Moons of Pluto"), doc("List of moons")],
    "Pluto": [doc("Pluto"), doc("Moons of Pluto")],
  };
  const provider: SourceProvider = { name: "x", find: async (q, n) => (lists[q] ?? []).slice(0, n) };
  const got = await gatherSources(provider, "Pluto has moons.", 3);
  assert.deepEqual(got.map((s) => s.title), ["Moons of Pluto", "Pluto", "List of moons"]);
  assert.equal((await gatherSources(provider, "Pluto has moons.", 1)).length, 1);
  const failing: SourceProvider = { name: "f", find: async (q) => { if (q === "Pluto") throw new Error("429"); return [doc("A")]; } };
  assert.equal((await gatherSources(failing, "Pluto has moons.", 3)).length, 1, "a failed subject search does not lose the main one");
});

const verdict = (stance: Verdict["stance"], probability: number, relevance: number): Verdict => ({ stance, probability, relevance, quote: "q", rationale: "r" });
const read = (title: string, v: Verdict): Reading => ({ src: staticSource(title, title), v });

test("chooseReading acts on the most relevant source, not the most extreme one", () => {
  const strong = read("Moons of Pluto", verdict("support", 0.9, 1));
  const noisy = read("Some list", verdict("refute", 0.06, 0.55));
  const c = chooseReading([noisy, strong])!;
  assert.equal(c.pick, strong);
  assert.equal(c.dissent, false, "a much less relevant source does not count as disagreement");
  const peer = chooseReading([strong, read("Another", verdict("refute", 0.06, 0.95))])!;
  assert.equal(peer.dissent, true);
  assert.ok(Math.abs(peer.belief - 0.7) < 1e-9, "conviction is halved: 0.5 + (0.9 - 0.5) / 2");
  assert.equal(chooseReading([read("x", verdict("irrelevant", 0.5, 0)), read("y", verdict("support", 0.9, 0.3))]), null);
});

test("CachedJudge asks once per claim and content, and does not remember a failure", async () => {
  let asked = 0, fail = true;
  const inner: Judge = { name: "inner", judge: async () => { asked++; if (fail) { fail = false; return null; } return verdict("support", 0.9, 1); } };
  const j = new CachedJudge(inner);
  const src = staticSource("Pluto", "text");
  assert.equal(await j.judge("claim", src), null);
  const v = await j.judge("claim", src);
  assert.equal(v!.stance, "support");
  await j.judge("claim", src);
  assert.equal(asked, 2, "failure retried once, success remembered");
  await j.judge("another claim", src);
  await j.judge("claim", staticSource("Pluto", "different text"));
  assert.equal(asked, 4);
});

test("uri helpers", () => {
  assert.equal(articleOf("pluto/moons"), "pluto");
  assert.equal(sectionOf("pluto/moons"), "moons");
  assert.equal(sectionOf("pluto"), "");
  assert.equal(prettyTopic("mount-everest"), "Mount Everest");
  const w = describeSource("https://en.wikipedia.org/w/index.php?title=Moons_of_Pluto&oldid=123456&action=raw");
  assert.equal(w.title, "Moons of Pluto");
  assert.equal(w.rev, 123456);
  assert.equal(w.label, "Moons of Pluto (Wikipedia, revision 123456)");
  assert.equal(w.readable, "https://en.wikipedia.org/w/index.php?title=Moons_of_Pluto&oldid=123456");
  assert.equal(describeSource("https://mock-corpus.invalid/Pluto", { mockCorpus: true }).mock, true);
  assert.equal(describeSource("https://mock-corpus.invalid/Pluto").mock, false, "on a real network that address is just an address");
  assert.equal(describeSource("https://anything.invalid/x", { mockCorpus: true }).mock, false);
  assert.equal(describeSource("javascript:alert(1)").readable, null);
  assert.equal(describeSource("not a url").readable, null);
});

test("a redirect is checked before it is followed: an allowed host cannot send the request to a host that is not", async () => {
  const seen: string[] = [];
  const f = (async (url: string) => {
    seen.push(String(url));
    if (String(url).startsWith("https://en.wikipedia.org/a")) return res(302, "", { location: "http://169.254.169.254/latest" });
    return res(200, "x");
  }) as unknown as typeof fetch;
  await assert.rejects(verifyEvidenceHash("https://en.wikipedia.org/a", "x", f, { limiter: new Limiter(0), allowHosts: ["wikipedia.org"] }), /redirected to a host that is not allowed: 169\.254\.169\.254/);
  assert.deepEqual(seen, ["https://en.wikipedia.org/a"], "the second host was never requested");
  const ok = (async (url: string) => (String(url).endsWith("/a") ? res(301, "", { location: "/b" }) : res(200, "hello"))) as unknown as typeof fetch;
  assert.ok((await verifyEvidenceHash("https://en.wikipedia.org/a", sha256Hex("hello"), ok, { limiter: new Limiter(0), allowHosts: ["wikipedia.org"] })).ok, "a redirect inside the allowed hosts is followed");
  const loop = (async () => res(302, "", { location: "/a" })) as unknown as typeof fetch;
  await assert.rejects(verifyEvidenceHash("https://en.wikipedia.org/a", "x", loop, { limiter: new Limiter(0), allowHosts: ["wikipedia.org"] }), /too many redirects/);
});

test("verifyEvidenceContent: the quote must be in the page, found by the same text reduction the agents used", async () => {
  const RAW = "{{Infobox planet|name=Pluto}}\n'''Pluto''' is a [[dwarf planet]] in the [[Kuiper belt]].<ref>x</ref> It has [[Moons of Pluto|five known moons]].";
  const f = (async () => res(200, RAW)) as unknown as typeof fetch;
  const o = { limiter: new Limiter(0) };
  const good = await verifyEvidenceContent("https://x.test/p", sha256Hex(RAW), "Pluto is a dwarf planet in the Kuiper belt.", f, o);
  assert.deepEqual([good.ok, good.quoteFound], [true, true]);
  const invented = await verifyEvidenceContent("https://x.test/p", sha256Hex(RAW), "Pluto has twelve known moons.", f, o);
  assert.deepEqual([invented.ok, invented.quoteFound], [true, false], "a real hash does not make an invented quote real");
  assert.equal((await verifyEvidenceContent("https://x.test/p", sha256Hex(RAW), null, f, o)).quoteFound, null);
  assert.equal((await verifyEvidenceContent("https://x.test/p", "00".repeat(32), "Pluto is a dwarf planet", f, o)).ok, false);
});

test("a page larger than the cap is refused as it arrives, by declared length or by streamed length", async () => {
  const big = new Uint8Array(2_100_000);
  const o = { limiter: new Limiter(0) };
  await assert.rejects(verifyEvidenceHash("https://en.wikipedia.org/big", "x", (async () => new Response(big)) as unknown as typeof fetch, o), /larger than 2000000 bytes/);
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(500_000)); } });
  await assert.rejects(verifyEvidenceHash("https://en.wikipedia.org/endless", "x", (async () => new Response(endless)) as unknown as typeof fetch, o), /larger than/);
  assert.ok(pulled <= 6, `the stream was cancelled after ${pulled} reads instead of being drained`);
  const lying = (async () => new Response("small", { headers: { "content-length": "9000000" } })) as unknown as typeof fetch;
  await assert.rejects(verifyEvidenceHash("https://en.wikipedia.org/declared", "x", lying, o), /larger than/);
  const fine = (async () => new Response("hello")) as unknown as typeof fetch;
  assert.ok((await verifyEvidenceHash("https://en.wikipedia.org/ok", sha256Hex("hello"), fine, o)).ok);
});

test("table stripping is linear: many unclosed openers do not stall, and closed tables still go", () => {
  assert.equal(cleanWikitext("before {| a table\n| cell\n|} after").replace(/\s+/g, " ").trim(), "before after");
  const hostile = "{|".repeat(40_000) + " text that goes on and on";
  const t0 = Date.now();
  cleanWikitext(hostile);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test("a response that is not going to be read is released, not left holding its connection", async () => {
  let cancelled = 0;
  const unread = (status: number, headers: Record<string, string> = {}) =>
    new Response(new ReadableStream({ cancel() { cancelled++; } }), { status, headers });
  let n = 0;
  const f = (async () => (++n === 1 ? unread(429, { "retry-after": "0" }) : new Response("hello"))) as unknown as typeof fetch;
  const o = { limiter: new Limiter(0), sleepFn: async () => {} };
  assert.ok((await verifyEvidenceHash("https://en.wikipedia.org/a", sha256Hex("hello"), f, o)).ok);
  assert.equal(cancelled, 1, "the 429's body was cancelled");
  await assert.rejects(verifyEvidenceHash("https://en.wikipedia.org/b", "x", (async () => unread(404)) as unknown as typeof fetch, o), /404/);
  assert.equal(cancelled, 2, "so was the 404's");
  const hop = (async (u: string) => (String(u).endsWith("/a") ? unread(302, { location: "/b" }) : new Response("hello"))) as unknown as typeof fetch;
  await verifyEvidenceHash("https://en.wikipedia.org/a", sha256Hex("hello"), hop, { ...o, allowHosts: ["wikipedia.org"] });
  assert.equal(cancelled, 3, "and the redirect's");
});

test("only a note written as a quotation is a quote; commentary and short notes are not reported as missing quotes", () => {
  assert.equal(quotedText('"Pluto is a dwarf planet in the Kuiper belt."'), "Pluto is a dwarf planet in the Kuiper belt.");
  assert.equal(quotedText("“Pluto has five known moons.”"), "Pluto has five known moons.");
  assert.equal(quotedText('"has "inner" quotes inside it"'), 'has "inner" quotes inside it');
  assert.equal(quotedText("this page is the best overview"), null);
  assert.equal(quotedText('"too short"'), null);
  assert.equal(quotedText(""), null);
});

test("the revision read is the newest that has had time to be reviewed, so a fresh vandal's edit is not cited", async () => {
  const NOW = Date.parse("2026-11-05T12:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const seen: string[] = [];
  const server = (latest: { revid: number; timestamp: string }, older: Array<{ revid: number; timestamp: string }>) => (async (url: string) => {
    seen.push(String(url));
    const u = new URL(String(url));
    const json = (o: unknown) => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(o)).buffer }) as Response;
    if (u.searchParams.get("generator") === "search") return json({ query: { pages: [{ pageid: 7, title: "Pluto", index: 1, revisions: [latest] }] } });
    if (u.searchParams.get("rvdir") === "older") {
      assert.equal(u.searchParams.get("pageids"), "7");
      const cutoff = Date.parse(u.searchParams.get("rvstart")!);
      return json({ query: { pages: [{ pageid: 7, revisions: older.filter((r) => Date.parse(r.timestamp) <= cutoff).slice(0, 1) }] } });
    }
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(`text of ${u.searchParams.get("oldid")}`).buffer } as Response;
  }) as unknown as typeof fetch;
  const provider = (f: typeof fetch, minAgeMs = 24 * 3_600_000) => new WikipediaProvider(f, "https://wiki.test", { limiter: new Limiter(0), minAgeMs, now: () => NOW });
  const oldid = (src: Source[]) => new URL(src[0]!.url).searchParams.get("oldid");

  // an edit from two hours ago is skipped in favour of the newest one older than a day
  const young = server({ revid: 900, timestamp: hoursAgo(2) }, [{ revid: 880, timestamp: hoursAgo(5) }, { revid: 800, timestamp: hoursAgo(30) }, { revid: 700, timestamp: hoursAgo(90) }]);
  assert.equal(oldid(await provider(young).find("pluto", 1)), "800");
  // a revision that has stood for a day is used as it is, with no second lookup
  seen.length = 0;
  assert.equal(oldid(await provider(server({ revid: 900, timestamp: hoursAgo(25) }, [])).find("pluto", 1)), "900");
  assert.ok(!seen.some((u) => u.includes("rvdir=older")), "no extra call for a settled page");
  // nothing old enough (a page created this morning): the page is not used at all
  assert.deepEqual(await provider(server({ revid: 900, timestamp: hoursAgo(2) }, [{ revid: 880, timestamp: hoursAgo(1) }])).find("pluto", 1), []);
  // a revision with no timestamp counts as new
  assert.equal(oldid(await provider(server({ revid: 900 } as never, [{ revid: 800, timestamp: hoursAgo(30) }])).find("pluto", 1)), "800");
  // the policy can be turned off
  seen.length = 0;
  assert.equal(oldid(await provider(young, 0).find("pluto", 1)), "900");
  assert.ok(!seen.some((u) => u.includes("rvdir=older")));
  // and it is part of the provider's name, so caches filled under different policies are kept apart
  assert.equal(provider(young).name, "wikipedia:stable-24h");
  assert.equal(provider(young, 0).name, "wikipedia");
});
