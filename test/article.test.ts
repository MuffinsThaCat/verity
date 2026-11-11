import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArticle, diffArticles, titleOf } from "../src/article.js";
import type { ClaimView, Evidence } from "../src/lib/types.js";

const claim = (id: number, price: number, topic = "pluto", extra: Partial<ClaimView> = {}): ClaimView => ({
  id, topic, text: `Claim ${id}.`, creator: "a.near", created_ms: 0, price_bps: price,
  collateral: "0", reserve_yes: "0", reserve_no: "0", volume: "0", trades: 0, fee_pool: "0", evidence: [], links: [], link_id: null, tape: [], ...extra,
});
const WIKI = "https://en.wikipedia.org/w/index.php?title=Moons_of_Pluto&oldid=77&action=raw";
const ev = (id: number, claimId: number, stance: "Support" | "Refute", uri = WIKI, hash = "aa".repeat(32), backing = "1000"): Evidence => ({
  id, claim_id: claimId, author: "r.near", stance, uri, content_hash: hash, note: `"quote ${id}"`, bond: "0", backing, independent: "0",
  posted_ms: 0, price_at_post_bps: 5000, bond_state: "Open",
});

test("sub-topics become sections: the lead first, then in the order their first claim was opened", () => {
  const claims = [
    claim(5, 9000, "pluto/moons"), claim(1, 9000, "pluto"), claim(3, 9000, "pluto/discovery"), claim(4, 9000, "pluto/moons"),
    claim(9, 9000, "everest"), claim(10, 9000, "pluto", { link_id: 2 }),
  ];
  const a = buildArticle("pluto", claims, new Map());
  assert.deepEqual(a.sections.map((s) => s.key), ["", "discovery", "moons"]);
  assert.deepEqual(a.sections.map((s) => s.title), ["", "Discovery", "Moons"]);
  assert.deepEqual(a.sections[2]!.body.map((s) => s.claimId), [4, 5]);
  assert.deepEqual(a.body.map((s) => s.claimId), [1, 3, 4, 5], "the flat body stays in id order; another article and link markets are not in it");
  assert.equal(titleOf("mount-everest"), "Mount Everest");
  assert.equal(buildArticle("mount-everest", [claim(1, 9000, "mount-everest/geography")], new Map()).title, "Mount Everest");
});

test("a section whose claims are all rejected disappears from the page but its claims are listed as rejected", () => {
  const a = buildArticle("pluto", [claim(1, 9000), claim(2, 800, "pluto/moons"), claim(3, 700, "pluto/moons")], new Map());
  assert.deepEqual(a.sections.map((s) => s.key), [""]);
  assert.deepEqual(a.rejected.map((s) => s.claimId), [2, 3]);
  assert.equal(a.rejected[0]!.section, "moons");
});

test("one source cited by three claims is one numbered reference, numbered in reading order", () => {
  const claims = [claim(4, 9000, "pluto/moons"), claim(1, 9000), claim(2, 9000)];
  const other = "https://en.wikipedia.org/w/index.php?title=Pluto&oldid=5&action=raw";
  const evidence = new Map<number, Evidence[]>([
    [4, [ev(10, 4, "Support", WIKI), ev(11, 4, "Support", other, "bb".repeat(32), "500")]],
    [1, [ev(12, 1, "Support", other, "bb".repeat(32), "300")]],
    [2, [ev(13, 2, "Support", WIKI, "aa".repeat(32), "200")]],
  ]);
  const a = buildArticle("pluto", claims, evidence);
  assert.equal(a.references.length, 2);
  // reading order is the lead (claims 1, 2) before the section (claim 4): the page it cites first is "Pluto"
  assert.equal(a.references[0]!.uri, other);
  assert.deepEqual(a.references[0]!.claimIds, [1, 4]);
  assert.equal(a.references[0]!.backing, "800");
  assert.deepEqual(a.references[1]!.claimIds, [2, 4]);
  assert.equal(a.references[0]!.label, "Pluto (Wikipedia, revision 5)");
  assert.equal(a.references[0]!.quote, "quote 12");
  assert.deepEqual(a.body.find((s) => s.claimId === 4)!.refs, [{ n: 2, stance: "Support" }, { n: 1, stance: "Support" }]);
  assert.deepEqual(a.body.find((s) => s.claimId === 1)!.refs, [{ n: 1, stance: "Support" }]);
});

test("a source cited for and against is marked mixed, and a rejected claim's evidence is numbered after the page's", () => {
  const evidence = new Map<number, Evidence[]>([
    [1, [ev(1, 1, "Support")]],
    [2, [ev(2, 2, "Refute", WIKI), ev(3, 2, "Refute", "https://en.wikipedia.org/w/index.php?title=X&oldid=9&action=raw", "cc".repeat(32))]],
  ]);
  const a = buildArticle("pluto", [claim(1, 9000), claim(2, 700)], evidence);
  assert.equal(a.references[0]!.stance, "Mixed");
  assert.equal(a.references.length, 2);
  assert.deepEqual(a.rejected[0]!.refs.map((r) => r.n), [1, 2]);
});

test("a revision records a section's claim being removed from the page", () => {
  const before = buildArticle("pluto", [claim(1, 9000), claim(2, 9000, "pluto/moons")], new Map());
  const after = buildArticle("pluto", [claim(1, 9000), claim(2, 900, "pluto/moons")], new Map());
  assert.ok(diffArticles(before, after).some((c) => c.claimId === 2 && c.kind === "removed-from-body"));
  assert.notEqual(before.signature, after.signature);
});

test("a reference says whether its note is a quotation, so commentary is never checked as one", () => {
  const e = (id: number, note: string, uri: string): Evidence => ({ ...ev(id, 1, "Support", uri, String(id).repeat(64).slice(0, 64)), note });
  const a = buildArticle("pluto", [claim(1, 9000)], new Map([[1, [
    e(1, '"Pluto is a dwarf planet in the Kuiper belt."', "https://en.wikipedia.org/w/index.php?title=A&oldid=1&action=raw"),
    e(2, "the best overview of the topic", "https://en.wikipedia.org/w/index.php?title=B&oldid=2&action=raw"),
  ]]]));
  assert.deepEqual(a.references.map((r) => [r.isQuote, r.quote]), [[true, "Pluto is a dwarf planet in the Kuiper belt."], [false, "the best overview of the topic"]]);
  assert.equal(a.references[1]!.note, "the best overview of the topic");
});

test("a model-written lede may not offer or cite a claim the market does not back at 55%", async () => {
  const { writeLede } = await import("../src/article.js");
  const body = buildArticle("pluto", [claim(1, 9000), claim(2, 5000), claim(3, 6000)], new Map()).body;
  let seen = "";
  const llm = {
    name: "fake",
    json: async (a: { user: string }) => {
      seen = a.user;
      return { paragraphs: [{ text: "Claim 2 is true.", claim_ids: [2] }, { text: "Claims 1 and 3 hold.", claim_ids: [1, 3] }] };
    },
  };
  const r = await writeLede(llm as never, body);
  assert.doesNotMatch(seen, /#2 /, "the 50% claim is not offered to the model");
  assert.deepEqual(r.lede.map((p) => p.claimIds), [[1, 3]], "a paragraph that cites it anyway is dropped");
});
