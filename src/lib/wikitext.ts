/**
 * Pure text functions shared by the server and the browser (the server serves this file at /lib/wikitext.js), so the
 * page a reader re-checks is reduced to text by exactly the code the agents used. No imports, no Node APIs.
 */

/**
 * The few templates that carry a figure or a word a sentence depends on become that text; every other template is dropped.
 * Without this, "its height is {{convert|8848.86|m|ft}}" would lose the number.
 */
function flattenTemplate(body: string): string {
  const parts = body.split("|").map((p) => p.trim());
  const name = (parts.shift() ?? "").toLowerCase().replace(/_/g, " ");
  const pos = parts.filter((p) => !p.includes("="));
  switch (name) {
    case "convert": case "cvt": {
      if (pos.length >= 3 && /^(to|and|-|–|by)$/i.test(pos[1]!)) return `${pos[0]} to ${pos[2]} ${pos[3] ?? ""}`.trim();
      return `${pos[0] ?? ""} ${pos[1] ?? ""}`.trim();
    }
    case "nowrap": case "nobreak": case "small": case "abbr": case "val": case "em": case "strong": case "mvar": case "angle": return pos[0] ?? "";
    case "lang": case "transliteration": return pos[1] ?? pos[0] ?? "";
    case "circa": case "c.": return `c. ${pos[0] ?? ""}`.trim();
    case "as of": return `as of ${pos[0] ?? ""}`.trim();
    default: return "";
  }
}

/** Removes `{| … |}` tables in one pass. A lazy regex over the whole page is quadratic when openers are never closed. */
function stripTables(s: string): string {
  const lastClose = s.lastIndexOf("|}");
  let out = "";
  let i = 0;
  for (;;) {
    const a = s.indexOf("{|", i);
    if (a < 0) return out + s.slice(i);
    // No closer after this opener means none after any later one: drop the remaining markers and stop, rather than
    // rescanning to the end of the page from each of them.
    if (lastClose < a + 2) return out + s.slice(i).split("{|").join("");
    const b = s.indexOf("|}", a + 2);
    out += s.slice(i, a);
    i = b + 2;
  }
}

/*
 * Everything below runs on pages anyone can point evidence at, in the server and in a visitor's browser. A regex such as
 * `<ref[^>]*>[\s\S]*?<\/ref>` is quadratic on a page of unclosed openers (each `<ref` scans to the end before failing), so a
 * 2 MB page of them would stall the process for minutes. Each step is a single pass instead: where it needs "the next
 * closer", it asks a finder that remembers its last answer, so a run of openers costs one scan between them, not one each.
 * `test/wikitext.test.ts` holds the regex version these replaced and checks the output is the same.
 */

/** indexOf for rising `from`: the answer is remembered, so repeated calls do not rescan, and -1 is final. */
function finder(s: string, needle: string): (from: number) => number {
  let at = -2;
  return (from) => {
    if (at === -1) return -1;
    if (at >= from) return at;
    at = s.indexOf(needle, from);
    return at;
  };
}

/** The same for a pattern: the first match at or after `from`, or null. `re` must be global. */
function reFinder(s: string, re: RegExp): (from: number) => { at: number; end: number } | null {
  let hit: { at: number; end: number } | null | undefined;
  return (from) => {
    if (hit === null) return null;
    if (hit && hit.at >= from) return hit;
    re.lastIndex = from;
    const m = re.exec(s);
    hit = m ? { at: m.index, end: m.index + m[0].length } : null;
    return hit;
  };
}

/** Removes every `open … close`; an opener with no closer after it, and so every later one, is left as it is. */
function stripSpans(s: string, open: string, close: string): string {
  const nextClose = finder(s, close);
  let out = "";
  let i = 0;
  for (;;) {
    const a = s.indexOf(open, i);
    if (a < 0) break;
    const b = nextClose(a + open.length);
    if (b < 0) break;
    out += s.slice(i, a);
    i = b + close.length;
  }
  return out + s.slice(i);
}

/** `<ref … />` and `<ref …> … </ref>`. */
function stripRefs(s: string): string {
  let t = s;
  {
    const gt = finder(t, ">");
    const opener = /<ref/gi;
    let out = "", copy = 0, pos = 0;
    for (;;) {
      opener.lastIndex = pos;
      const m = opener.exec(t);
      if (!m) break;
      const p = m.index;
      const g = gt(p + 4);
      if (g < 0) break;
      if (g - 1 >= p + 4 && t[g - 1] === "/") { out += t.slice(copy, p); copy = pos = g + 1; } else pos = p + 1;
    }
    t = out + t.slice(copy);
  }
  const gt = finder(t, ">");
  const closer = reFinder(t, /<\/ref>/gi);
  const opener = /<ref/gi;
  let out = "", copy = 0, pos = 0;
  for (;;) {
    opener.lastIndex = pos;
    const m = opener.exec(t);
    if (!m) break;
    const p = m.index;
    const g = gt(p + 4);
    if (g < 0) break;
    const c = closer(g + 1);
    if (!c) break;
    out += t.slice(copy, p);
    copy = pos = c.end;
  }
  return out + t.slice(copy);
}

/** `<anything but >` up to the next `>`. */
function stripTags(s: string): string {
  const gt = finder(s, ">");
  let out = "", copy = 0, pos = 0;
  for (;;) {
    const p = s.indexOf("<", pos);
    if (p < 0) break;
    const g = gt(p + 1);
    if (g < 0) break;
    if (g > p + 1) { out += s.slice(copy, p); copy = pos = g + 1; } else pos = p + 1;
  }
  return out + s.slice(copy);
}

/** `[[File:…]]`, `[[Image:…]]`, `[[Category:…]]`. */
function stripFileLinks(s: string): string {
  const bracket = finder(s, "]");
  const opener = /\[\[(?:file|image|category):/gi;
  let out = "", copy = 0, pos = 0;
  for (;;) {
    opener.lastIndex = pos;
    const m = opener.exec(s);
    if (!m) break;
    const e = bracket(m.index + m[0].length);
    if (e < 0) break;
    if (s[e + 1] === "]") { out += s.slice(copy, m.index); copy = pos = e + 2; } else pos = m.index + 1;
  }
  return out + s.slice(copy);
}

/** `[[target|label]]` becomes label (when `piped`), then `[[target]]` becomes target. */
function flattenWikiLinks(s: string, piped: boolean): string {
  const bracket = finder(s, "]");
  const pipe = finder(s, "|");
  let out = "", copy = 0, pos = 0;
  for (;;) {
    const o = s.indexOf("[[", pos);
    if (o < 0) break;
    const c = o + 2;
    const e = bracket(c);
    if (e < 0) break;
    if (s[e + 1] === "]") {
      if (piped) {
        const p = pipe(c);
        if (p >= 0 && p < e) { out += s.slice(copy, o) + s.slice(p + 1, e); copy = pos = e + 2; continue; }
      } else {
        out += s.slice(copy, o) + s.slice(c, e);
        copy = pos = e + 2;
        continue;
      }
    }
    pos = o + 1;
  }
  return out + s.slice(copy);
}

/**
 * `[http://… label]` becomes label; then a bare `[http://…]` is dropped. Both follow the regexes they replaced exactly,
 * including their habit of letting the address run up to the next whitespace, `]` and all.
 */
function flattenExternalLinks(s: string): string {
  const opener = /\[https?:\/\//g;
  const ws = reFinder(s, /\s/g);
  // pass 1: [http://run<whitespace>label]
  {
    const nonWs = reFinder(s, /\S/g);
    const bracket = finder(s, "]");
    let out = "", copy = 0, pos = 0;
    for (;;) {
      opener.lastIndex = pos;
      const m = opener.exec(s);
      if (!m) break;
      const u = m.index + m[0].length;
      const w = ws(u);
      if (!w) break;
      let ok = false;
      if (w.at > u) {
        const start = nonWs(w.at);
        const labelAt = start ? start.at : s.length;
        const e = bracket(labelAt);
        if (e >= 0) { out += s.slice(copy, m.index) + s.slice(labelAt, e); copy = pos = e + 1; ok = true; }
      }
      if (!ok) pos = m.index + 1;
    }
    s = out + s.slice(copy);
  }
  // pass 2: [http://run] with the last ] inside the run
  const ws2 = reFinder(s, /\s/g);
  let out = "", copy = 0, pos = 0;
  let cacheEnd = -1, cacheLast = -1, cacheFrom = 0;
  for (;;) {
    opener.lastIndex = pos;
    const m = opener.exec(s);
    if (!m) break;
    const u = m.index + m[0].length;
    const w = ws2(u);
    const end = w ? w.at : s.length;
    // The last "]" of this run, found once however many openers share the run.
    if (end !== cacheEnd || u < cacheFrom) {
      cacheEnd = end; cacheFrom = u; cacheLast = -1;
      for (let k = end - 1; k >= u + 1; k--) if (s[k] === "]") { cacheLast = k; break; }
    }
    if (cacheLast >= u + 1) { out += s.slice(copy, m.index); copy = pos = cacheLast + 1; } else pos = m.index + 1;
  }
  return out + s.slice(copy);
}

const isWs = (ch: string) => /\s/.test(ch);

/** `== Heading ==` becomes `Heading`; one line at a time, never scanning past it. */
function headingLine(l: string): string {
  let a = 0;
  while (a < l.length && l[a] === "=") a++;
  if (a === 0) return l;
  let e = l.length;
  while (e > a && isWs(l[e - 1])) e--;
  if (e === a) return a >= 2 ? "" : l; // nothing but equals signs
  let b = a;
  while (b < e && isWs(l[b])) b++;
  if (l[e - 1] !== "=") return l;
  let s0 = e;
  while (s0 > b && l[s0 - 1] === "=") s0--;
  let c = s0;
  while (c > b && isWs(l[c - 1])) c--;
  return l.slice(b, c);
}

/** Deterministic reduction of MediaWiki markup to readable text. Exported so a verifier can reproduce it. */
export function cleanWikitext(raw: string): string {
  let s = stripSpans(raw, "<!--", "-->");
  s = stripRefs(s);
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/\{\{([^{}]*)\}\}/g, (_m, body: string) => flattenTemplate(body));
    if (next === s) break;
    s = next;
  }
  s = stripTables(s);
  s = stripFileLinks(s);
  s = flattenWikiLinks(s, true);
  s = flattenWikiLinks(s, false);
  s = flattenExternalLinks(s);
  s = s.replace(/'{2,5}/g, "");
  s = stripTags(s);
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/^[^\n\r\u2028\u2029]*/gm, headingLine);
  return s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !/^[*#:;|!]/.test(l) || l.length > 60).join("\n");
}

/** Lower-case, whitespace collapsed, quote marks dropped: the form in which a quote is compared with its source. */
export const normalizeForQuote = (s: string): string => s.toLowerCase().replace(/[\s\u00a0]+/g, " ").replace(/[“”"']/g, "").trim();

/** True when `quote` (at least 12 characters) appears in `source` word for word, ignoring case, spacing and quote marks. */
export const quoteIsInSource = (quote: string, source: string): boolean => {
  const q = normalizeForQuote(quote);
  return q.length >= 12 && normalizeForQuote(source).includes(q);
};

/**
 * The text inside an evidence note written as a quotation ("…" or “…”), or null. A note is free text; agents write the
 * passage they relied on in quotation marks, and only that can be looked for in a page. A short note ("see page") or
 * commentary is not a quote and must not be reported as one that is missing.
 */
export const quotedText = (note: string): string | null => {
  const m = /^\s*["“]([\s\S]+?)["”]\s*$/.exec(note);
  const inner = m ? m[1]!.trim() : "";
  return inner.length >= 12 ? inner : null;
};
