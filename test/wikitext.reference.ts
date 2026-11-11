/**
 * THE REGEX VERSION of cleanWikitext, kept only so test/wikitext.test.ts can check the single-pass version gives the same
 * text. It is quadratic on unclosed openers; nothing else may import it.
 *
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

/** Deterministic reduction of MediaWiki markup to readable text. Exported so a verifier can reproduce it. */
export function referenceCleanWikitext(raw: string): string {
  let s = raw;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/\{\{([^{}]*)\}\}/g, (_m, body: string) => flattenTemplate(body));
    if (next === s) break;
    s = next;
  }
  s = stripTables(s);
  s = s.replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, "");
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2").replace(/\[\[([^\]]*)\]\]/g, "$1");
  s = s.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1").replace(/\[https?:\/\/\S+\]/g, "");
  s = s.replace(/'{2,5}/g, "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
  // One deliberate difference from the original: `\s` there could run across a line break, so "==" above a line ending in "=" was
  // read as one heading. A heading is one line; the rest of this function is unchanged.
  s = s.replace(/^=+[^\S\n\r\u2028\u2029]*([^\n\r\u2028\u2029]*?)[^\S\n\r\u2028\u2029]*=+[^\S\n\r\u2028\u2029]*$/gm, "$1");
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
