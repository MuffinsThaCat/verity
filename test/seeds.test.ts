import { test } from "node:test";
import assert from "node:assert/strict";
import { applySeeds, loadSeedDir, resolveSeeds, restrictSeeds, seedCost, topicOf, validateSeeds, MAX_TOPIC, type SeedFile, type SeedTarget } from "../src/demo/seeds.js";

class Fake implements SeedTarget {
  claims: Array<{ topic: string; text: string; prior: number }> = [];
  links: Array<{ a: number; b: number; rel: string }> = [];
  async createClaim(topic: string, text: string, prior: number) { this.claims.push({ topic, text, prior }); return this.claims.length - 1; }
  async createLink(a: number, b: number, rel: string) { this.links.push({ a, b, rel }); return 100 + this.links.length; }
}
const money = { claimFee: 1n, seedDeposit: 1n, linkDeposit: 1n };
const claim = (text: string, extra = {}) => ({ text, ...extra });

test("the seed files in the repository are consistent: every reference resolves", () => {
  const files = loadSeedDir("seed");
  assert.ok(files.length >= 4);
  validateSeeds(files);
  for (const f of files) {
    assert.ok(f.claims.length >= 3, `${f.topic} has too few claims to be an article`);
    assert.ok((f.lies ?? []).length >= 1, `${f.topic} offers no lie to inject`);
    assert.ok(f.claims.length <= 60, "a topic holds at most 60 claims");
  }
});

test("claims open under their section; links may point into another file; lies resolve to ids and texts", async () => {
  const files: SeedFile[] = [
    { topic: "pluto", claims: [claim("Pluto is a dwarf planet.", { key: "dwarf" }), claim("Pluto has five moons.", { key: "five", section: "moons" })],
      links: [{ a: "dwarf", b: "solar#eight", rel: "Implies" }],
      lies: [{ text: "Pluto has twelve moons.", section: "moons", contradicts: ["five", "solar#eight"], note: "n" }] },
    { topic: "solar", claims: [claim("The Solar System has eight planets.", { key: "eight" })] },
  ];
  const chain = new Fake();
  const out = await applySeeds(chain, files, money);
  assert.deepEqual(chain.claims.map((c) => c.topic), ["pluto", "pluto/moons", "solar"]);
  assert.deepEqual(chain.links, [{ a: 0, b: 2, rel: "Implies" }]);
  assert.equal(out.ids.get("pluto#five"), 1);
  assert.equal(out.ids.get("pluto#1"), 1, "a claim is also reachable by its index");
  assert.equal(out.lies.length, 1);
  assert.equal(out.lies[0]!.topic, "pluto/moons");
  assert.equal(out.lies[0]!.id, "pluto:0");
  assert.deepEqual(out.lies[0]!.contradicts, [{ id: 1, text: "Pluto has five moons." }, { id: 2, text: "The Solar System has eight planets." }]);
  assert.equal(topicOf({ topic: "a" }), "a");
});

test("true sentences to add are options of their own kind: no contradiction, 50%, and every article offers one", async () => {
  const files = loadSeedDir("seed");
  for (const f of files) assert.ok((f.adds ?? []).length >= 1, `${f.topic} offers no true sentence to add`);
  const out = await applySeeds(new Fake(), files, money);
  const adds = out.lies.filter((l) => l.kind === "add");
  assert.equal(adds.length, files.reduce((n, f) => n + (f.adds ?? []).length, 0));
  for (const a of adds) { assert.deepEqual(a.contradicts, []); assert.equal(a.priorBps, 5000); }
  assert.ok(out.lies.filter((l) => l.kind === "lie").every((l) => l.contradicts.length > 0));
  assert.equal(new Set(out.lies.map((l) => l.id)).size, out.lies.length, "ids are unique");
  // An add is a sentence that is not already in the article.
  const existing = new Set(files.flatMap((f) => f.claims.map((c) => c.text)));
  for (const a of adds) assert.ok(!existing.has(a.text), `"${a.text}" is already a seed claim`);
  await assert.rejects(applySeeds(new Fake(), [{ topic: "a", claims: [claim("A perfectly fine claim.")], adds: [{ text: "x" }] }], money));
});

test("a contract seeded earlier is matched by topic and text, and a missing target is dropped", () => {
  const files: SeedFile[] = [{
    topic: "pluto",
    claims: [claim("Pluto has five moons.", { key: "five", section: "moons" }), claim("Pluto was found in 1930.", { key: "found" })],
    lies: [{ text: "Pluto has twelve moons.", section: "moons", contradicts: ["five", "found"] }],
    adds: [{ text: "Charon was discovered in 1978.", section: "moons" }],
  }];
  const options = resolveSeeds(files, [
    { id: 7, topic: "pluto/moons", text: "Pluto has five moons." },
    { id: 8, topic: "pluto", text: "Some other claim." },
    { id: 9, topic: "pluto/moons", text: "Pluto was found in 1930." }, // right text, wrong topic: not the seed claim
  ]);
  assert.deepEqual(options.map((o) => [o.id, o.kind]), [["pluto:0", "lie"], ["pluto:add0", "add"]]);
  assert.deepEqual(options[0]!.contradicts, [{ id: 7, text: "Pluto has five moons." }]);
  assert.equal(options[1]!.topic, "pluto/moons");
  assert.deepEqual(resolveSeeds(files, []).map((o) => o.contradicts.length), [0, 0]);
});

test("a bad seed file is refused before anything is written", async () => {
  const chain = new Fake();
  const bad = (f: SeedFile[]) => assert.rejects(applySeeds(chain, f, money));
  await bad([{ topic: "Bad Topic", claims: [claim("A perfectly fine claim.")] }]);
  await bad([{ topic: "a", claims: [claim("short")] }]);
  await bad([{ topic: "a", claims: [claim("A perfectly fine claim.", { section: "Bad Section" })] }]);
  await bad([{ topic: "a", claims: [claim("A perfectly fine claim.", { key: "k" }), claim("Another fine claim here.", { key: "k" })] }]);
  await bad([{ topic: "a", claims: [claim("A perfectly fine claim.", { key: "k" })], links: [{ a: "k", b: "nope", rel: "Implies" }] }]);
  await bad([{ topic: "a", claims: [claim("A perfectly fine claim.")], lies: [{ text: "A lie of some length.", contradicts: ["b#x"] }] }]);
  await bad([{ topic: "a", claims: [claim("A perfectly fine claim.")] }, { topic: "a", claims: [claim("A second file for a.")] }]);
  assert.equal(chain.claims.length, 0);
});

test("a subset of the real seeds is still consistent: links and contradictions that leave it are dropped", async () => {
  const all = loadSeedDir("seed");
  assert.throws(() => validateSeeds(all.filter((f) => f.topic === "pluto")), /unknown claim/, "pluto alone has a dangling cross-article link");
  const only = restrictSeeds(all, ["pluto"]);
  validateSeeds(only);
  assert.equal(only.length, 1);
  assert.deepEqual(only[0]!.links, []);
  assert.ok(only[0]!.lies!.length >= 1 && only[0]!.lies!.every((l) => (l.contradicts ?? []).every((c) => !String(c).includes("#"))));
  const chain = new Fake();
  await applySeeds(chain, only, money);
  assert.equal(chain.links.length, 0);
  const solar = restrictSeeds(all, ["solar-system"]);
  validateSeeds(solar);
  assert.ok(solar[0]!.lies!.every((l) => !(l.contradicts ?? []).includes("pluto#iau")), "a lie keeps only the contradictions that are still there");
  assert.deepEqual(restrictSeeds(all, all.map((f) => f.topic)).map((f) => f.links?.length), all.map((f) => f.links?.length), "keeping everything changes nothing");
});

test("the contract's 64-character topic limit applies to article/section together", async () => {
  const f: SeedFile = { topic: "a".repeat(40), claims: [claim("A perfectly fine claim.", { section: "b".repeat(40) })] };
  assert.ok(topicOf(f, "b".repeat(40)).length > MAX_TOPIC);
  await assert.rejects(applySeeds(new Fake(), [f], money), /64-character topic limit/);
  const lie: SeedFile = { topic: "a".repeat(30), claims: [claim("A perfectly fine claim.")], lies: [{ text: "A lie of some length.", section: "c".repeat(40) }] };
  await assert.rejects(applySeeds(new Fake(), [lie], money), /64-character limit/);
});

test("seedCost is what applySeeds spends in deposits", async () => {
  const files = loadSeedDir("seed");
  const m = { claimFee: 7n, seedDeposit: 100n, linkDeposit: 50n };
  const claims = files.reduce((n, f) => n + f.claims.length, 0);
  const links = files.reduce((n, f) => n + (f.links?.length ?? 0), 0);
  assert.equal(seedCost(files, m), BigInt(claims) * 107n + BigInt(links) * 57n);
  let spent = 0n;
  const counting: SeedTarget = {
    createClaim: async (_t, _x, _p, deposit) => { spent += deposit; return spent; },
    createLink: async (_a, _b, _r, _p, deposit) => { spent += deposit; return spent; },
  };
  await applySeeds(counting, files, m);
  assert.equal(spent, seedCost(files, m));
});
