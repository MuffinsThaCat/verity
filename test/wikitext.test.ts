import test from "node:test";
import assert from "node:assert/strict";
import { cleanWikitext } from "../src/lib/wikitext.js";
import { referenceCleanWikitext } from "./wikitext.reference.js";

// A small deterministic generator, so a failure can be reproduced from its seed.
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

const PIECES = [
  "[[", "]]", "[", "]", "|", "{{", "}}", "{|", "|}", "<ref>", "<ref name=a>", "<ref name=a/>", "<ref />", "</ref>", "<REF>", "</Ref>",
  "<!--", "-->", "<", ">", "<b>", "</b>", "<references/>", "[[File:", "[[Image:x", "[[category:", "[http://a.org", "[https://b.org/x", "[http://",
  " ", "  ", "\n", "\r", "\r\n", " ", "\t", "=", "==", "=== ", " ==", "'", "''", "'''", "&nbsp;", "{{convert|5|m}}", "{{lang|fr|bonjour}}",
  "word", "Pluto", "1930", "label", "x", "a|b", "*", "#", ":", "; ", "!", "é", "İ", "ß",
];

function soup(r: () => number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
  return s;
}

test("the single-pass cleaner gives exactly the text the regex version gave, on bracket and tag soup", () => {
  const r = rng(20261105);
  for (let i = 0; i < 6000; i++) {
    const text = soup(r, 1 + Math.floor(r() * 24));
    assert.equal(cleanWikitext(text), referenceCleanWikitext(text), `input ${JSON.stringify(text)}`);
  }
});

test("and on real-looking markup", () => {
  const page = [
    "{{Infobox planet|name=Pluto|moons=5}}",
    "'''Pluto''' (minor-planet designation: 134340 Pluto) is a [[dwarf planet]] in the [[Kuiper belt]].<ref name=\"nh\">{{cite web|url=http://x.org}}</ref>",
    "== Discovery ==",
    "It was discovered in [[1930]] by [[Clyde Tombaugh|Tombaugh]].<ref group=n>Note</ref> <!-- hidden --> See [http://example.org the site] and [https://b.org].",
    "{| class=\"wikitable\"\n|-\n| a || b\n|}",
    "[[File:Pluto.jpg|thumb|Pluto in 2015]]",
    "[[Category:Dwarf planets]]",
    "=== Moons ===",
    "Its height is {{convert|8848.86|m|ft}}.&nbsp;It has five moons.",
    "* list item that is short",
    "* a long list item that is more than sixty characters long, so it is kept in the output",
    "====Deep====",
    "==  Spaced  ==  ",
    "= single =",
    "==",
    "=",
  ].join("\n");
  assert.equal(cleanWikitext(page), referenceCleanWikitext(page));
  assert.match(cleanWikitext(page), /discovered in 1930 by Tombaugh/);
  assert.match(cleanWikitext(page), /Its height is 8848\.86 m\./);
});

// A page is at most 2 MB, and anyone can point evidence at any page. The regex version took minutes on each of these.
const BIG = 2_000_000;
const HOSTILE: Array<[string, string]> = [
  ["unclosed <", "<".repeat(BIG)],
  ["unclosed <ref>", "<ref>".repeat(BIG / 5)],
  ["unclosed <ref ", "<ref ".repeat(BIG / 5)],
  ["unclosed comments", "<!--".repeat(BIG / 4)],
  ["unclosed file links", "[[File:".repeat(BIG / 7)],
  ["unclosed links", "[[a".repeat(BIG / 3)],
  ["unclosed piped links", "[[a|b".repeat(BIG / 5)],
  ["unclosed external links", "[http://a b".repeat(BIG / 11)],
  ["external links with no whitespace", "[http://".repeat(BIG / 8)],
  ["external links and brackets", "[http://a]x ".repeat(BIG / 12)],
  ["table openers", "{|".repeat(BIG / 2)],
  ["template openers", "{{a".repeat(BIG / 3)],
  ["a heading of spaces", "=" + " ".repeat(BIG) + "x"],
  ["equals signs", "= ".repeat(BIG / 2)],
];

for (const [name, text] of HOSTILE) {
  test(`hostile page, ${name}: cleaned in well under a few seconds`, () => {
    const t0 = Date.now();
    cleanWikitext(text);
    const ms = Date.now() - t0;
    assert.ok(ms < 4000, `${name} took ${ms} ms`);
  });
}
