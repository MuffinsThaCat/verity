import { finalize, type Judge, type Verdict } from "./judge.js";
import { keywords, type Source } from "./sources.js";

/* ───────────────────────── words ───────────────────────── */

const WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MULT: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const MONTHS = new Set("january february march april may june july august september october november december".split(" "));
const ONE_NOT_A_NUMBER = new Set("of in who that which can could may might will would is was another or".split(" "));

/** Every number in the text, as a plain value. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const tok of text.toLowerCase().replace(/,(?=\d)/g, "").match(/\b\d+(?:\.\d+)?\b|\b[a-z']+\b/g) ?? []) {
    if (/^\d/.test(tok)) out.push(Number(tok));
    else if (tok in WORDS) out.push(WORDS[tok]!);
    else if (tok in MULT) out.push(MULT[tok]!);
  }
  return out;
}

/** Words that add little to whether a sentence is about the claim: they stay in the claim but do not count against overlap. */
const SOFT = new Set("known natural official officially approximately about around roughly nearly also major main total called named formally currently widely generally some".split(" "));
const SYNONYM: Record<string, string> = {
  moon: "satellite", satellite: "satellite", meter: "metre", metre: "metre", m: "metre", kilometer: "km", kilometre: "km", km: "km",
  ft: "foot", feet: "foot", foot: "foot", mi: "mile", mile: "mile", yr: "year", year: "year", tonne: "ton", ton: "ton",
  person: "people", people: "people", biggest: "largest", tallest: "highest", percent: "percent", "%": "percent",
  elevation: "height", altitude: "height",
};
/** Function words and adjectives that may sit between a figure and the thing it counts. */
const NOT_A_UNIT = new Set("the and of to in for with that its their most likely are is a an by on at from as earth small large big giant new old major minor different additional other more further only few many several distinct separate confirmed recorded successful tall long high early late total".split(" "));
const UNIT_WORDS = new Set(["metre", "km", "foot", "mile", "year", "ton", "people", "percent", "kg", "day", "hour", "minute", "second", "satellite", "planet"]);

/** A small, symmetric stemmer: the same word in a claim and a source must land on the same string; that is all it must do. */
function stem(raw: string): string {
  let w = raw.toLowerCase().replace(/['’]s$/, "");
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return SYNONYM[w] ?? w;
}

/** "8848 m" and "29,031 ft" carry a unit that is too short for the keyword filter; spell it out first. */
const spellUnits = (text: string) =>
  text.replace(/(\d)\s*m\b(?!\w)/g, "$1 metres").replace(/(\d)\s*km\b/g, "$1 kilometres").replace(/(\d)\s*ft\b/g, "$1 feet");

// Figures and ordinals are compared as slots, so they are not also counted as words ("first" must not count against a source that says "second").
const contentStems = (text: string): string[] =>
  Array.from(new Set(keywords(spellUnits(text)).filter((w) => !SOFT.has(w) && !(w in WORDS) && !(w in MULT) && !(w in ORDINALS) && !/^\d/.test(w)).map(stem)));

/* ───────────────────────── numeric slots ───────────────────────── */

export interface Slot {
  kind: "year" | "qty" | "ord";
  value: number;
  /** What is being counted: the first real noun after the figure. Empty for a year. */
  units: Set<string>;
  raw: string;
  /** Index of the figure among the text's tokens, so a reader can look at the words around it. */
  at: number;
}

const TOKEN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|[A-Za-z][A-Za-z'’-]*|%/g;
export const tokenize = (text: string): string[] => [...text.matchAll(TOKEN)].map((m) => m[0]);

function firstNoun(toks: string[], from: number): Set<string> {
  const units = new Set<string>();
  for (let j = from; j < Math.min(toks.length, from + 5); j++) {
    const w = toks[j]!;
    if (!/^[A-Za-z%]/.test(w)) break;
    const low = w.toLowerCase();
    if ((low.length < 2 && low !== "m") || SOFT.has(low) || NOT_A_UNIT.has(low)) continue;
    units.add(stem(w));
    break;
  }
  return units;
}

/** The figures a text states, each with the noun it counts, so "five moons" is only ever compared with "eight moons". */
export function extractSlots(text: string): Slot[] {
  const toks = tokenize(text);
  const slots: Slot[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    const lower = t.toLowerCase();
    const digit = /^\d/.test(t);

    const ordinal = ORDINALS[lower];
    if (ordinal !== undefined && (toks[k - 1] ?? "").toLowerCase() === "the") {
      slots.push({ kind: "ord", value: ordinal, units: firstNoun(toks, k + 1), raw: t, at: k });
      continue;
    }

    let value: number;
    if (digit) value = Number(t.replace(/,/g, ""));
    else if (lower in WORDS) {
      if (lower === "one" && ONE_NOT_A_NUMBER.has((toks[k + 1] ?? "").toLowerCase())) continue;
      value = WORDS[lower]!;
    } else continue;
    if (!Number.isFinite(value)) continue;

    let used = 0;
    const mult = MULT[(toks[k + 1] ?? "").toLowerCase()];
    if (mult) { value *= mult; used = 1; }
    const prev = toks[k - 1];
    const after = toks[k + 1 + used];

    if (digit && prev && /^[A-Z][a-z]+$/.test(prev) && !MONTHS.has(prev.toLowerCase()) && value < 100 && !t.includes(".")) continue; // "Apollo 11"
    if (digit && value >= 1 && value <= 31 && ((prev && MONTHS.has(prev.toLowerCase())) || (after && MONTHS.has(after.toLowerCase())))) continue; // a day of the month

    const nextUnit = after && /^[A-Za-z%]/.test(after) ? stem(after) : "";
    if (digit && !t.includes(",") && !t.includes(".") && Number.isInteger(value) && value >= 1000 && value <= 2100 && !UNIT_WORDS.has(nextUnit)) {
      slots.push({ kind: "year", value, units: new Set(), raw: t, at: k });
      k += used;
      continue;
    }
    slots.push({ kind: "qty", value, units: firstNoun(toks, k + 1 + used), raw: used ? `${t} ${toks[k + 1]}` : t, at: k });
    k += used;
  }
  return slots;
}

const APPROX = /\b(about|around|approximately|roughly|nearly|circa)\b|~/i;

export interface Conflict { claim: string; source: string; at: number }
export interface SlotComparison {
  comparable: number;
  equal: number;
  conflicts: Conflict[];
  /** How many of the equal figures were ordinals ("the first person"): they agree whatever the sentence says was done first. */
  ordEqual: number;
  /** Figures that differ, in a sentence that is not clearly about the claim: they cannot refute it, and they stop it being supported. */
  doubtful: number;
}

export function compareSlots(claim: Slot[], source: Slot[], approximate: boolean): SlotComparison {
  const out: SlotComparison = { comparable: 0, equal: 0, conflicts: [], ordEqual: 0, doubtful: 0 };
  for (const cs of claim) {
    const cands = source.filter((ss) =>
      ss.kind === cs.kind && (cs.kind === "year" || [...cs.units].some((u) => ss.units.has(u))));
    if (cands.length === 0) continue;
    out.comparable++;
    const tol = cs.kind !== "qty" ? 0 : approximate ? 0.05 : 0.005;
    const same = cands.find((ss) => Math.abs(ss.value - cs.value) <= tol * Math.max(Math.abs(ss.value), Math.abs(cs.value)));
    if (same) { out.equal++; if (cs.kind === "ord") out.ordEqual++; }
    else out.conflicts.push({ claim: cs.raw, source: cands[0]!.raw, at: cands[0]!.at });
  }
  return out;
}

/* ───────────────────────── sentences ───────────────────────── */

const ABBREVIATION = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|Mt|Jr|Sr|vs|etc|approx|ca|No|Fig|Inc|Ltd|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.|\b[A-Z]\.)$/;

/** Sentences of at most ~600 characters, without splitting after an initial ("Clyde W. Tombaugh") or "St.". */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[])/);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur} ${p}` : p;
      // A run of initials ("A. B. C. …") would otherwise grow `cur` for ever and be re-tested in full each time. A sentence this long
      // is discarded below anyway.
      if (cur.length <= 1_200 && ABBREVIATION.test(cur)) continue;
      out.push(cur.trim());
      cur = "";
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.filter((s) => s.length >= 15 && s.length <= 600);
}

/* ───────────────────────── names ───────────────────────── */

const PRONOUN_LED = /^(it|he|she|they|its|his|her|their|this|these)\b/i;
const CAPITAL_RUN = /[A-Z][\w'’-]*(?:\s+(?:[A-Z][\w'’-]*|\d{1,3}\b))*/g;
const LEADING_DETERMINER = /^(the|a|an|in|on|at|by|of|and|its|his|her|their)\s+/i;
const FUNCTION_WORDS = new Set("the a an in on at by of and its his her their this that these those it he she they as for with".split(" "));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One pattern per named thing in the claim ("Neil Armstrong" → armstrong, "Apollo 11" → apollo 11). A sentence has to
 * mention every one to count as being about the claim: matching on common words alone let a sentence about Armstrong
 * and Aldrin "support" a claim about Collins.
 */
export function requiredNames(claim: string): RegExp[] {
  const out: RegExp[] = [];
  for (const run of claim.match(CAPITAL_RUN) ?? []) {
    const words = run.replace(LEADING_DETERMINER, "").replace(/['’]s\b/g, "").split(/\s+/).filter((w) => w && !MONTHS.has(w.toLowerCase()) && !FUNCTION_WORDS.has(w.toLowerCase()));
    let num: string | null = null;
    if (words.length > 1 && /^\d/.test(words[words.length - 1]!)) num = words.pop()!;
    while (words.length > 1 && words[words.length - 1]!.length < 3) words.pop();
    const tail = words[words.length - 1];
    if (!tail || tail.length < 3 || /^\d/.test(tail)) continue;
    const w = escapeRe(tail.toLowerCase());
    out.push(num ? new RegExp(`\\b${w}\\w*\\s+${num}\\b`, "i") : new RegExp(`\\b${w}`, "i"));
  }
  return out;
}

/** The stems of every word in the claim's capitalised names: the explicit-name check already covers them. */
function nameStemsOf(claim: string): Set<string> {
  const out = new Set<string>();
  for (const run of claim.match(CAPITAL_RUN) ?? []) {
    for (const w of run.replace(LEADING_DETERMINER, "").replace(/['’]s\b/g, "").split(/\s+/)) {
      const lw = w.toLowerCase();
      if (!w || FUNCTION_WORDS.has(lw) || MONTHS.has(lw) || /^\d/.test(w)) continue;
      out.add(stem(w));
    }
  }
  return out;
}

/* ───────────────────────── negation ───────────────────────── */

const NEGATIONS = new Set(["not", "no", "never", "neither", "nor", "isn't", "aren't", "wasn't", "weren't", "doesn't", "don't", "didn't", "cannot", "can't", "won't", "wouldn't"]);
const bare = (w: string) => w.replace(/[^a-z0-9'’-]/g, "");
const hasNegation = (text: string) => text.toLowerCase().split(/\s+/).some((w) => NEGATIONS.has(bare(w)));

/**
 * True when a negation is followed, inside the same clause and within six words, by one of the claim's own words:
 * "Pluto is no longer considered a planet" negates "planet". A negation about something else in the sentence ("has not
 * cleared its orbit … and is a dwarf planet") does not count.
 */
function negatesClaimTerms(sentence: string, claimStems: Set<string>): boolean {
  const words = sentence.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (!NEGATIONS.has(bare(words[i]!))) continue;
    // "not the largest dwarf planet", "not only", "not all": the negation scopes the superlative or quantifier, not what follows it.
    const next = bare(words[i + 1] ?? "");
    const after = bare(words[i + 2] ?? "");
    if (/^(only|all|every|always|entirely|fully|just|merely|quite|very|most|least)$/.test(next)) continue;
    if (next === "the" && (/est$/.test(after) || /^(most|least|only|first|last|same|single|sole)$/.test(after))) continue;
    for (let j = i + 1; j < Math.min(words.length, i + 7); j++) {
      if (claimStems.has(stem(bare(words[j]!)))) return true;
      if (/[,;:]$/.test(words[j]!)) break;
    }
  }
  return false;
}

/* ───────────────────────── the judge ───────────────────────── */

/** Pages that collect or retell rather than state: a list of fictional planets must not outweigh the article on the planets. */
const DERIVATIVE_TITLE = /^(list|lists|outline|timeline|index|comparison|fictional|bibliography|glossary)\b|\(disambiguation\)|\bin popular culture\b/i;

/** How far either side of a figure the claim's words must appear for a different figure to count as a contradiction. */
const WINDOW = 8;

/**
 * A rule-based stand-in for the language-model judge. It reads no meaning; it matches words and figures:
 *  - find the sentence that shares the most content words with the claim and names everything the claim names;
 *  - compare each figure in the claim only with figures that count the same thing (moons with moons, a year with a
 *    year, "the second person" with "the first person");
 *  - equal figures support; a different figure refutes, but only when at least 80% of the claim's words sit within
 *    a few words of that figure ("a moss grows at 6,480 m on Everest" shares Everest and metres with a claim about
 *    Everest's height, yet its words are about something else);
 *  - a negation counts only when it plainly attaches to the claim's own words.
 * Every verdict still has to quote the source verbatim, which `finalize` enforces. It is labelled as a rule-based
 * judge wherever it is shown, because it is one: a claim that is wrong in a way it cannot see (an inverted relation,
 * a swapped name) gets no refutation from it, and a language model is the right tool for those.
 */
export class OfflineJudge implements Judge {
  readonly name: string;
  constructor(label?: string) {
    this.name = label ?? "rule-based-judge";
  }

  async judge(claim: string, src: Source): Promise<Verdict | null> {
    const claimStems = contentStems(claim);
    if (claimStems.length === 0) return null;
    const claimSet = new Set(claimStems);
    const claimSlots = extractSlots(claim);
    const approximate = APPROX.test(claim);
    const names = requiredNames(claim);
    // The words that say what is being claimed, apart from who or what it is about. Those, not the names, have to sit next to a
    // different figure for it to count: a long subject ("Tenzing Norgay and Edmund Hillary made the first documented ascent")
    // would otherwise push the figure out of reach of its own names.
    const nameStems = nameStemsOf(claim);
    const predicate = [...claimSet].filter((w) => !nameStems.has(w));
    const titleStems = contentStems(src.title);
    // A sentence may refute only if it names, by itself, everything the claim names. A pronoun-led sentence ("They
    // ascended… reached an altitude of 8321 m") borrows the article's subject, which is good enough to support a claim
    // but not to call it false.
    const titleIsSubject = titleStems.length > 0 && titleStems.every((w) => claimSet.has(w));

    interface Cand { s: string; overlap: number; cmp: SlotComparison; score: number; explicit: boolean }
    let best: Cand | null = null;
    let runnerUp = 0;
    let scanned = 0;
    for (const s of splitSentences(src.text)) {
      // A whole article is thousands of sentences; let the server answer a request now and then while one is read.
      if (++scanned % 300 === 0) await new Promise<void>((r) => setImmediate(r));
      const sStems = new Set(contentStems(s));
      const pronounLed = PRONOUN_LED.test(s);
      if (pronounLed) for (const t of titleStems) sStems.add(t);
      let hit = 0;
      for (const w of claimSet) if (sStems.has(w)) hit++;
      const overlap = hit / claimSet.size;
      if (overlap < 0.34) continue;

      const explicit = names.every((re) => re.test(s));
      const inherited = !explicit && pronounLed && titleIsSubject && names.every((re) => re.test(`${src.title} ${s}`));
      if (!explicit && !inherited) continue;

      const cmp = claimSlots.length ? compareSlots(claimSlots, extractSlots(s), approximate) : { comparable: 0, equal: 0, conflicts: [], ordEqual: 0, doubtful: 0 };
      if (cmp.conflicts.length) {
        const toks = tokenize(s);
        const valid = cmp.conflicts.filter((c) => {
          if (!explicit) return false;
          const around = new Set(contentStems(toks.slice(Math.max(0, c.at - WINDOW), c.at + WINDOW + 1).join(" ")));
          if (predicate.length === 0) return true;
          let near = 0;
          for (const w of predicate) if (around.has(w)) near++;
          return near / predicate.length >= 0.8;
        });
        cmp.doubtful = cmp.conflicts.length - valid.length;
        cmp.comparable -= cmp.doubtful;
        cmp.conflicts = valid;
      }

      const score = overlap + (claimSlots.length ? (cmp.comparable ? 0.5 : -0.1) : 0) + (cmp.equal ? 0.1 : 0) + (explicit ? 0.05 : 0);
      if (!best || score > best.score) { runnerUp = best?.overlap ?? 0; best = { s, overlap, cmp, score, explicit }; }
      else if (overlap > runnerUp) runnerUp = overlap;
    }

    const none = (why: string) => finalize({ stance: "irrelevant", probability: 0.5, relevance: 0, quote: "", rationale: why }, src.text);
    if (!best) return none("no sentence addresses the claim");

    const quote = best.s.slice(0, 240);
    const relevance = Math.min(1, best.overlap + (titleIsSubject ? 0.1 : 0)) * (DERIVATIVE_TITLE.test(src.title) ? 0.7 : 1);
    const corroborated = runnerUp >= 0.6 ? 0.03 : 0;

    // Negation is settled before figures are compared: "Pluto does not have twelve moons" is true, and comparing 12
    // with Wikipedia's "five" would call it false.
    if (hasNegation(claim)) {
      // "X is not Y" cannot be judged against an affirmative sentence about X and Y: it may restate the claim ("is not a
      // planet" beside "is a dwarf planet") or contradict it, and words alone cannot tell which. Only a sentence that
      // also denies it can support it; anything else is silence, never a refutation.
      if (hasNegation(best.s) && best.overlap >= 0.6) {
        return finalize({ stance: "support", probability: Math.min(0.85, 0.65 + best.overlap * 0.2), relevance, quote, rationale: "the source also denies it" }, src.text);
      }
      return none("a negated claim cannot be judged from an affirmative sentence");
    }
    // A sentence that negates part of an affirmative claim is a weak signal ("no longer considered a planet" against
    // "Pluto is a planet"), because where a negation ends cannot be read from words. It argues against the claim, mildly,
    // and it must never be counted as support.
    if (best.overlap >= 0.6 && negatesClaimTerms(best.s, claimSet)) {
      if (claimSlots.length > 0) return none("the closest sentence negates part of the claim");
      return finalize({ stance: "refute", probability: 0.4, relevance, weight: 0.35, quote, rationale: "the source appears to say it no longer holds, or denies it" }, src.text);
    }

    if (claimSlots.length > 0) {
      if (best.cmp.comparable === 0 && best.cmp.doubtful === 0) return none("the closest sentence does not state a comparable figure");
      if (best.cmp.conflicts.length === 0 && best.cmp.doubtful > 0) return none("the closest sentence gives a different figure but is not clearly about this claim");
      if (best.cmp.conflicts.length > 0) {
        const c = best.cmp.conflicts[0]!;
        return finalize({ stance: "refute", probability: 0.06, relevance, quote, rationale: `the source says ${c.source} where the claim says ${c.claim}` }, src.text);
      }
      // "The first person to hold a ceremony on the Moon" agrees with "the first person to walk on the Moon" on the one thing an
      // ordinal says, and on nothing about what was done. When an ordinal is the agreement, nearly all the words must agree too.
      const needed = best.cmp.ordEqual > 0 ? 0.75 : best.cmp.equal ? 0.4 : 0.5;
      if (best.overlap < needed) return none("the closest sentence is only loosely about the claim");
      return finalize(
        { stance: "support", probability: Math.min(0.95, 0.74 + best.overlap * 0.17 + corroborated), relevance, quote, rationale: "the source states the same figure for the same thing" },
        src.text,
      );
    }

    if (best.overlap >= 0.6) {
      return finalize(
        { stance: "support", probability: Math.min(0.93, 0.7 + best.overlap * 0.2 + corroborated), relevance, quote, rationale: "the source says the same thing in the same terms" },
        src.text,
      );
    }
    return none("the closest sentence is only loosely about the claim");
  }
}
