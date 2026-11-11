import { test } from "node:test";
import assert from "node:assert/strict";
import { OfflineJudge, numbersIn, extractSlots, compareSlots, splitSentences, requiredNames } from "../src/lib/offlineJudge.js";
import { staticSource } from "../src/lib/sources.js";

const doc = (title: string, ...sentences: string[]) => staticSource(title, sentences.join("\n"));
const judge = new OfflineJudge();
const pluto = doc(
  "Pluto",
  "Pluto is a dwarf planet in the Kuiper belt.",
  "Pluto has five known natural satellites: Charon, Styx, Nix, Kerberos and Hydra.",
  "Pluto was discovered in 1930 by Clyde Tombaugh.",
);
const verdict = async (claim: string, src = pluto) => (await judge.judge(claim, src))!;

test("numbers", () => {
  assert.deepEqual(numbersIn("Pluto has twelve moons, found in 1,930"), [12, 1930]);
});

test("same figure supports, different figure refutes, unrelated is irrelevant", async () => {
  assert.equal((await verdict("Pluto has five known moons.")).stance, "support");
  const r = await verdict("Pluto has twelve known natural satellites.");
  assert.equal(r.stance, "refute");
  assert.ok(r.probability < 0.1);
  assert.match(r.quote, /five known natural satellites/);
  assert.match(r.rationale, /five where the claim says twelve/);
  assert.equal((await verdict("Photosynthesis converts light into chemical energy.")).stance, "irrelevant");
  assert.equal((await verdict("Pluto was discovered in 1930 by Tombaugh.")).stance, "support");
  assert.equal((await verdict("Pluto was discovered in 1950 by Tombaugh.")).stance, "refute");
});

test("a figure is compared only with a figure that counts the same thing", () => {
  const unit = (text: string) => [...extractSlots(text)[0]!.units];
  assert.deepEqual(unit("Pluto has five known natural satellites."), ["satellite"]);
  assert.deepEqual(unit("There are five known moons of the dwarf planet Pluto."), ["satellite"]);
  assert.deepEqual(unit("Pluto takes about 248 years to orbit the Sun."), ["year"]);
  assert.deepEqual(unit("for every two orbits that Neptune completes"), ["orbit"], "the verb is not the unit");
  assert.deepEqual(unit("a height of 8,848.86 m above sea level"), ["metre"]);
  const same = compareSlots(extractSlots("Pluto has five moons."), extractSlots("There are five known moons of Pluto."), false);
  assert.deepEqual([same.comparable, same.equal, same.conflicts.length], [1, 1, 0]);
  const unlike = compareSlots(extractSlots("Pluto takes about 248 years to orbit the Sun."), extractSlots("for every two orbits that Neptune completes"), true);
  assert.equal(unlike.comparable, 0, "248 years is not comparable with two orbits");
  const planets = compareSlots(extractSlots("Pluto has five known natural satellites."), extractSlots("Of the Solar System's eight planets and its nine most likely dwarf planets, six planets have satellites."), false);
  assert.equal(planets.comparable, 0, "five moons is not compared with eight planets");
});

test("years, names with numbers, days and ordinals are read for what they are", () => {
  const kinds = (t: string) => extractSlots(t).map((s) => `${s.kind}:${s.value}`);
  assert.deepEqual(kinds("Pluto was discovered in 1930."), ["year:1930"]);
  assert.deepEqual(kinds("Apollo 11 landed on the Moon on 20 July 1969."), ["year:1969"], "Apollo 11 is a name and 20 is a day");
  assert.deepEqual(kinds("The height is 8,848.86 metres."), ["qty:8848.86"]);
  assert.deepEqual(kinds("A ridge 1,500 metres long."), ["qty:1500"], "a figure followed by a unit is not a year");
  assert.deepEqual(kinds("Armstrong was the second person to walk on the Moon."), ["ord:2"]);
  assert.deepEqual(kinds("Armstrong was second to none."), [], "an ordinal counts only after 'the'");
  assert.deepEqual(kinds("two thousand people and one of them left"), ["qty:2000"], "'one of' is not a figure");
});

test("a figure within rounding is the same figure; 'about' allows more", async () => {
  const src = doc("Pluto", "Pluto's orbital period is about 248 years.");
  assert.equal((await verdict("Pluto's orbital period is about 250 years.", src)).stance, "support");
  assert.equal((await verdict("Pluto's orbital period is 300 years.", src)).stance, "refute");
  assert.equal((await verdict("Pluto's orbital period is 250 years.", src)).stance, "refute", "without 'about', 250 is not 248");
});

test("sentences are not split after an initial or an abbreviation", () => {
  const s = splitSentences("Pluto was discovered in 1930 by Clyde W. Tombaugh at Lowell Observatory. It is small and cold and far away. The peak of Mt. Everest is high above the clouds.");
  assert.equal(s.length, 3);
  assert.match(s[0]!, /Clyde W\. Tombaugh at Lowell Observatory\.$/);
  assert.match(s[2]!, /^The peak of Mt\. Everest/);
});

test("names: every named thing in the claim must be in the sentence, 'Apollo 11' with its number", () => {
  const names = requiredNames("Michael Collins remained in lunar orbit while Armstrong and Aldrin landed.");
  assert.equal(names.length, 3);
  assert.ok(names.every((re) => re.test("Collins stayed behind; Armstrong and Aldrin landed.")));
  assert.ok(!names.every((re) => re.test("Armstrong and Aldrin landed.")));
  const apollo = requiredNames("Apollo 11 was launched by a Saturn V rocket.");
  assert.ok(apollo[0]!.test("Apollo 11 lifted off") && !apollo[0]!.test("Apollo 4 lifted off"));
});

test("regression: a sentence about Armstrong and Aldrin must not support a claim about Collins", async () => {
  const claim = "Michael Collins remained in lunar orbit while Armstrong and Aldrin landed.";
  const other = doc("Neil Armstrong", "On July 20, 1969, Armstrong and Apollo 11 Lunar Module pilot Buzz Aldrin became the first people to land on the Moon in lunar orbit.");
  assert.equal((await verdict(claim, other)).stance, "irrelevant");
  const right = doc("Michael Collins", "Collins remained in lunar orbit in the command module while Armstrong and Aldrin descended to the surface.");
  assert.equal((await verdict(claim, right)).stance, "support");
});

test("regression: a moss on Everest is not the height of Everest", async () => {
  const claim = "The height of Mount Everest is 8,848.86 metres.";
  const moss = doc("Mount Everest", "A type of moss grows at 6480 m on Mount Everest and it may be the highest altitude plant species.");
  assert.equal((await verdict(claim, moss)).stance, "irrelevant", "shares Everest, altitude and metres, but its words are about a moss");
  const camp = doc("1924 British Mount Everest expedition", "They erected Camp IV on 21 May at a height of 7000 m.");
  assert.equal((await verdict(claim, camp)).stance, "irrelevant", "a pronoun-led sentence in an expedition article is not about the mountain");
  const real = doc("Mount Everest", "Its height was most recently measured in 2020 through a joint survey by Nepalese and Chinese authorities as 8,848.86 m.");
  assert.equal((await verdict(claim, real)).stance, "support");
  assert.equal((await verdict("The height of Mount Everest is 9,100 metres.", real)).stance, "irrelevant", "borrowing the title as subject can support a claim but never call one false");
  const direct = doc("Mount Everest", "The height of Mount Everest is 8,848.86 metres.");
  assert.equal((await verdict("The height of Mount Everest is 9,100 metres.", direct)).stance, "refute");
});

test("a long subject does not hide a figure from its own names: the window measures what is claimed, not who it is about", async () => {
  const page = doc("Mount Everest", "Tenzing Norgay and Edmund Hillary made the first documented ascent of Everest in 1953, using the Southeast Ridge route.");
  const lie = await verdict("Tenzing Norgay and Edmund Hillary made the first documented ascent of Everest in 1963.", page);
  assert.equal(lie.stance, "refute");
  assert.match(lie.rationale, /1953 where the claim says 1963/);
  assert.equal((await verdict("Tenzing Norgay and Edmund Hillary made the first documented ascent of Everest in 1953.", page)).stance, "support");
  const armstrong = doc("Neil Armstrong", "Neil Alden Armstrong (August 5, 1930 – August 25, 2012) was an American astronaut who, as the commander of the 1969 Apollo 11 mission, became the first person to walk on the Moon.");
  assert.equal((await verdict("Neil Armstrong was the second person to walk on the Moon.", armstrong)).stance, "refute");
});

test("regression: 248 years is not 'two orbits'", async () => {
  const resonance = doc("Pluto", "However, Pluto is also protected by its 3:2 orbital resonance with Neptune: for every two orbits that Neptune takes around the Sun, Pluto takes three.");
  assert.notEqual((await verdict("Pluto takes about 248 years to orbit the Sun.", resonance)).stance, "refute");
});

test("regression: a different year in a sentence that is not about the claim blocks support and cannot refute", async () => {
  const claim = "Edmund Hillary and Tenzing Norgay made the first confirmed ascent of Everest in 1963.";
  const expedition = doc("1953 British Mount Everest expedition", "The 1953 British Mount Everest expedition was the ninth mountaineering expedition to attempt the first ascent of Mount Everest, and Edmund Hillary and Tenzing Norgay reached the summit on 29 May.");
  assert.equal((await verdict(claim, expedition)).stance, "irrelevant");
});

test("ordinals: swapping first and second is caught, because it is a figure", async () => {
  const aldrin = doc("Buzz Aldrin", "Buzz Aldrin was the second person to walk on the Moon after Neil Armstrong.");
  assert.equal((await verdict("Buzz Aldrin was the second person to walk on the Moon.", aldrin)).stance, "support");
  const lie = await verdict("Buzz Aldrin was the first person to walk on the Moon.", aldrin);
  assert.equal(lie.stance, "refute");
  assert.match(lie.rationale, /second where the claim says first/);
});

test("regression: 'the first person to hold a ceremony on the Moon' does not support 'the first person to walk on the Moon'", async () => {
  const lie = "Buzz Aldrin was the first person to walk on the Moon.";
  const ceremony = doc("Buzz Aldrin", "A Presbyterian elder, Aldrin became the first person to hold a religious ceremony on the Moon, when he took communion.");
  assert.notEqual((await verdict(lie, ceremony)).stance, "support", "an ordinal agrees whatever was done first");
  const truth = doc("Neil Armstrong", "Neil Armstrong was the first person to walk on the Moon.");
  assert.equal((await verdict("Neil Armstrong was the first person to walk on the Moon.", truth)).stance, "support", "and a sentence that says the same thing still supports");
  const partial = doc("Neil Armstrong", "Armstrong became the first person to walk on the Moon in 1969.");
  assert.equal((await verdict("Neil Armstrong was the first person to walk on the Moon.", partial)).stance, "support", "even without the first name");
});

test("a source that lists or retells weighs less than the article", async () => {
  const claim = "The Solar System has eight planets.";
  const article = await verdict(claim, doc("Solar System", "There are eight planets in the Solar System."));
  const list = await verdict(claim, doc("Fictional planets of the Solar System", "There are eight planets in the Solar System."));
  assert.equal(list.stance, "support");
  assert.ok(list.relevance <= 0.7 && article.relevance > list.relevance, `${list.relevance} vs ${article.relevance}`);
});

test("negation: a sentence that says it no longer holds refutes; a negation about something else does not", async () => {
  const gone = doc("Pluto", "Pluto is no longer considered a planet by the International Astronomical Union.");
  const lie = await verdict("Pluto is a planet.", gone);
  assert.equal(lie.stance, "refute", "'no longer' reaches 'planet' four words on");
  const elsewhere = doc("Pluto", "Pluto has not cleared its orbit of other bodies and is therefore a dwarf planet in the Kuiper belt.");
  assert.equal((await verdict("Pluto is a dwarf planet in the Kuiper belt.", elsewhere)).stance, "support");
  const flipped = doc("Pluto", "Pluto is not a dwarf planet in the Kuiper belt.");
  assert.equal((await verdict("Pluto is a dwarf planet in the Kuiper belt.", flipped)).stance, "refute");
});

test("a negated claim with a figure is not compared with the figure: 'does not have twelve' is true", async () => {
  const v = await verdict("Pluto does not have twelve known natural satellites.");
  assert.equal(v.stance, "irrelevant");
  const solar = doc("Solar System", "There are eight planets in the Solar System.");
  assert.equal((await verdict("The Solar System does not have nine planets.", solar)).stance, "irrelevant");
});

test("a negation that scopes a superlative is not a negation of the claim; a middling-overlap sentence that negates it never supports it", async () => {
  const largest = doc("Pluto", "Pluto is not the largest dwarf planet in the Kuiper belt.");
  const v = await verdict("Pluto is a dwarf planet in the Kuiper belt.", largest);
  assert.notEqual(v.stance, "refute", "'not the largest' says nothing against 'a dwarf planet'");
  const mid = doc("Pluto", "Pluto is no longer considered a planet by astronomers.");
  const weak = await verdict("Pluto is a planet recognized by astronomers.", mid);
  assert.notEqual(weak.stance, "support");
  const lie = await verdict("Pluto is a planet.", mid);
  assert.equal(lie.stance, "refute");
  assert.ok(lie.probability >= 0.35 && lie.probability < 0.5, `a negation is a weak signal, not a 6% certainty: ${lie.probability}`);
  assert.ok(lie.weight !== undefined && lie.weight <= 0.5, "and an agent is told to stake a fraction of a normal stake on it");
  assert.equal((await verdict("Pluto has twelve known natural satellites.")).weight, undefined, "a clear figure conflict carries full weight");
});

test("a negated claim is never refuted by an affirmative sentence: it may restate the claim", async () => {
  const affirmative = doc("Pluto", "Pluto is a dwarf planet in the Kuiper belt.");
  const v = await verdict("Pluto is not a planet.", affirmative);
  assert.equal(v.stance, "irrelevant", "'is not a planet' beside 'is a dwarf planet' is true, not false");
  assert.equal((await verdict("Pluto is not a dwarf planet in the Kuiper belt.", affirmative)).stance, "irrelevant");
  const denies = doc("Pluto", "Pluto is not a planet because it has not cleared its orbit.");
  assert.equal((await verdict("Pluto is not a planet.", denies)).stance, "support", "a sentence that denies it too can support it");
});

test("every verdict's quote is in the source, word for word", async () => {
  for (const claim of ["Pluto has five known natural satellites.", "Pluto has twelve known natural satellites.", "Pluto was discovered in 1950 by Tombaugh."]) {
    const v = await verdict(claim);
    assert.ok(pluto.text.includes(v.quote), `${claim}: ${v.quote}`);
  }
});
