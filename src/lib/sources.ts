import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { sleep } from "./log.js";
import { cleanWikitext, quoteIsInSource } from "./wikitext.js";

export interface Source {
  title: string;
  /** Permanent address of the exact content that was hashed (a pinned revision, not "latest"). */
  url: string;
  /** Cleaned text the judge reads. */
  text: string;
  /** sha256 hex of the raw bytes served at `url`. Anyone can refetch and compare. */
  contentHash: string;
  provider: string;
}

export interface SourceProvider {
  readonly name: string;
  find(query: string, n: number): Promise<Source[]>;
}

type FetchFn = typeof fetch;

export const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

const UA = process.env.VERITY_USER_AGENT ?? "VerityBot/1.0 (NEAR hackathon research agent; contact via repository)";
const MAX_BYTES = 2_000_000;

/** Runs one request at a time with a pause between them, so a swarm of agents cannot hammer one host. */
export class Limiter {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  constructor(readonly gapMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.tail.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { this.nextAt = Date.now() + this.gapMs; }
    });
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }
}

/** One limiter for every real Wikipedia request in the process, whichever agent makes it. */
export const sharedLimiter = new Limiter(Number(process.env.VERITY_WIKI_GAP_MS ?? 350));

export interface GetOpts {
  limiter?: Limiter;
  timeoutMs?: number;
  /** Extra attempts after a 429 or 503. The wait honours Retry-After, capped at 20 s. */
  retries?: number;
  /** Refuse any URL, including the one a redirect lands on, whose host is not on this list. */
  allowHosts?: string[];
  sleepFn?: (ms: number) => Promise<void>;
}

const hostAllowed = (url: string, allow: string[]) => {
  try { const h = new URL(url).host; return allow.some((a) => h === a || h.endsWith(`.${a}`)); } catch { return false; }
};

/** Release a response nobody will read. An unread body keeps its connection busy until it is garbage collected. */
const discard = (res: Response) => {
  try { void (res.body as ReadableStream<Uint8Array> | null | undefined)?.cancel?.().catch(() => undefined); } catch { /* nothing to cancel */ }
};

/**
 * One request. When `allowHosts` is set, redirects are followed by hand and every hop is checked *before* it is
 * requested, so a redirect from an allowed host cannot make this process contact one that is not allowed.
 */
async function fetchFollowing(fetchFn: FetchFn, url: string, init: RequestInit, allowHosts: string[] | undefined): Promise<Response> {
  let target = url;
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(target, { ...init, redirect: allowHosts ? "manual" : "follow" });
    if (!allowHosts || res.status < 300 || res.status >= 400) return res;
    discard(res);
    const loc = res.headers?.get?.("location");
    if (!loc) throw new Error(`GET ${target} -> ${res.status} without a location`);
    const next = new URL(loc, target).toString();
    if (!hostAllowed(next, allowHosts)) throw new Error(`redirected to a host that is not allowed: ${new URL(next).host}`);
    if (hop >= 3) throw new Error(`GET ${url}: too many redirects`);
    target = next;
  }
}

/** Reads a body but stops at `max` bytes, so a huge page is refused as it arrives rather than after it has been buffered. */
async function readCapped(res: Response, max: number, url: string): Promise<Uint8Array> {
  const tooBig = () => new Error(`${url} is larger than ${max} bytes`);
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > max) throw tooBig();
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body || typeof body.getReader !== "function") {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw tooBig();
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => undefined); throw tooBig(); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export async function getBytes(fetchFn: FetchFn, url: string, o: GetOpts = {}): Promise<Uint8Array> {
  const { limiter = sharedLimiter, timeoutMs = 20_000, retries = 4, allowHosts, sleepFn = sleep } = o;
  if (allowHosts && !hostAllowed(url, allowHosts)) throw new Error(`host not allowed: ${new URL(url).host}`);
  return limiter.run(async () => {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchFollowing(fetchFn, url, { headers: { "user-agent": UA, accept: "*/*" }, signal: ctl.signal }, allowHosts);
        if ((res.status === 429 || res.status === 503) && attempt < retries) {
          const ra = Number(res.headers?.get?.("retry-after"));
          discard(res);
          await sleepFn(Math.min(20_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** attempt));
          continue;
        }
        if (!res.ok) { discard(res); throw new Error(`GET ${url} -> ${res.status}`); }
        if (allowHosts && res.url && !hostAllowed(res.url, allowHosts)) { discard(res); throw new Error(`redirected to a host that is not allowed: ${new URL(res.url).host}`); }
        return await readCapped(res, MAX_BYTES, url);
      } finally {
        clearTimeout(t);
      }
    }
  });
}

export { cleanWikitext };

const STOP = new Set("a an and are as at be been but by for from has have had in is it its of on or that the their there these this to was were which with who will would can could not no than then they them he she his her you your we our i".split(" "));

/** Lower-case content words. A figure like "8,848.86" stays one token instead of splitting into "848" and "86". */
export const keywords = (text: string): string[] =>
  Array.from(new Set(
    text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/[^a-z0-9\s.-]/g, " ").split(/\s+/)
      .map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter((w) => w.length > 2 && !STOP.has(w)),
  ));

/** The paragraphs of `text` that overlap most with the claim, in original order, up to maxChars. */
export function excerptFor(text: string, claim: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  const kw = new Set(keywords(claim));
  const paras = text.split("\n").map((p, i) => ({ p, i, score: keywords(p).filter((w) => kw.has(w)).length / Math.sqrt(1 + p.length / 200) }));
  paras.sort((a, b) => b.score - a.score || a.i - b.i);
  const keep: typeof paras = [];
  let used = 0;
  for (const x of paras) {
    if (x.score <= 0 && keep.length > 0) break;
    if (used + x.p.length > maxChars) continue;
    keep.push(x);
    used += x.p.length + 1;
  }
  return keep.sort((a, b) => a.i - b.i).map((x) => x.p).join("\n");
}

const NUMBER_WORDS = new Set("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion".split(" "));
const isYear = (w: string) => /^\d{4}$/.test(w) && Number(w) >= 1000 && Number(w) <= 2100;

/**
 * Words to search for. Figures are left out except years: a claim's figure is what is being checked, so letting a wrong
 * one steer the search would hide the page that corrects it ("twelve moons" must still find the page on Pluto's moons).
 */
export function searchQueryFor(claim: string): string {
  return keywords(claim).filter((w) => !NUMBER_WORDS.has(w) && (!/^[\d.]+$/.test(w) || isYear(w))).slice(0, 9).join(" ");
}

const MONTH_WORDS = new Set("january february march april may june july august september october november december".split(" "));
const LEADING_FUNCTION_WORD = /^(the|a|an|in|on|at|by|of|and|its|his|her|their)\s+/i;

/** The named things in a claim ("Mount Everest", "Apollo 11", "Pluto"), in order: each is worth a search of its own. */
export function searchSubjectsFor(claim: string): string[] {
  const runs = claim.match(/[A-Z][\w'’-]*(?:\s+(?:[A-Z][\w'’-]*|\d{1,3}\b))*/g) ?? [];
  const out: string[] = [];
  for (const run of runs) {
    let phrase = run.replace(LEADING_FUNCTION_WORD, "").replace(/['’]s\b/g, "").trim();
    phrase = phrase.split(/\s+/).filter((w) => !MONTH_WORDS.has(w.toLowerCase())).join(" ");
    if (phrase.length < 4 || STOP.has(phrase.toLowerCase()) || out.some((o) => o.toLowerCase() === phrase.toLowerCase())) continue;
    out.push(phrase);
  }
  return out;
}

export interface WikiOpts {
  limiter?: Limiter;
  retries?: number;
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Use the newest revision at least this old (0 = the latest). Default: VERITY_MIN_REVISION_AGE_HOURS, else 24 hours.
   * The latest revision is the least reviewed one; a vandal's edit that says a lie is true would otherwise be read, pinned
   * and cited, and would verify perfectly, because the hash really is that revision's.
   */
  minAgeMs?: number;
  now?: () => number;
}

interface WikiPage { pageid?: number; title: string; index?: number; revisions?: Array<{ revid: number; timestamp?: string }> }

export class WikipediaProvider implements SourceProvider {
  readonly name: string;
  private readonly minAgeMs: number;
  private readonly now: () => number;

  constructor(private readonly fetchFn: FetchFn = fetch, private readonly host = "https://en.wikipedia.org", private readonly o: WikiOpts = {}) {
    this.minAgeMs = o.minAgeMs ?? Number(process.env.VERITY_MIN_REVISION_AGE_HOURS ?? 24) * 3_600_000;
    this.now = o.now ?? Date.now;
    // The policy is part of the name, so a cache filled under another policy is not mistaken for this one's answers.
    this.name = this.minAgeMs > 0 ? `wikipedia:stable-${Math.round(this.minAgeMs / 3_600_000)}h` : "wikipedia";
  }

  private api(params: Record<string, string>) {
    return `${this.host}/w/api.php?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  }

  private async json<T>(url: string): Promise<T> {
    return JSON.parse(new TextDecoder().decode(await getBytes(this.fetchFn, url, this.o))) as T;
  }

  /** The revision to read: the latest if it has had time to be reviewed, else the newest one that has. Null if none has. */
  private async stableRevision(p: WikiPage): Promise<number | null> {
    const latest = p.revisions![0]!;
    if (this.minAgeMs <= 0) return latest.revid;
    const at = latest.timestamp ? Date.parse(latest.timestamp) : NaN;
    if (Number.isFinite(at) && this.now() - at >= this.minAgeMs) return latest.revid;
    if (p.pageid === undefined) return null;
    const older = await this.json<{ query?: { pages?: WikiPage[] } }>(this.api({
      action: "query", prop: "revisions", pageids: String(p.pageid), rvlimit: "1", rvdir: "older", rvstart: new Date(this.now() - this.minAgeMs).toISOString(), rvprop: "ids|timestamp",
    }));
    return older.query?.pages?.[0]?.revisions?.[0]?.revid ?? null;
  }

  /** One API call returns the ranked pages and the id of each one's current revision. */
  async find(query: string, n: number): Promise<Source[]> {
    const res = await this.json<{ query?: { pages?: WikiPage[] } }>(this.api({
      action: "query", generator: "search", gsrsearch: query, gsrlimit: String(n), prop: "revisions", rvprop: "ids|timestamp",
    }));
    const pages = (res.query?.pages ?? []).filter((p) => p.revisions?.[0]).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).slice(0, n);

    const out: Source[] = [];
    for (const p of pages) {
      try {
        const revid = await this.stableRevision(p);
        if (revid === null) continue; // too new to have been reviewed, and nothing older
        const url = `${this.host}/w/index.php?title=${encodeURIComponent(p.title.replace(/ /g, "_"))}&oldid=${revid}&action=raw`;
        const bytes = await getBytes(this.fetchFn, url, this.o);
        out.push({ title: p.title, url, text: cleanWikitext(new TextDecoder().decode(bytes)), contentHash: sha256Hex(bytes), provider: this.name });
      } catch { /* skip an unreadable page */ }
    }
    return out;
  }
}

export interface CacheOpts {
  /** How long a stored search stays fresh. A pinned revision never changes, so the pages themselves never expire. */
  ttlMs?: number;
  /** Answer only from the cache. For a demo on a bad network, after `npm run warm`. */
  offline?: boolean;
  now?: () => number;
}

interface QueryIndex { at: number; hashes: string[] }

/**
 * Remembers what a provider returned. Revisions are pinned by id, so a stored page is exactly what the network would
 * serve; only the question "which revision is current for this query" can go stale, and that gets a TTL.
 */
export class CachedProvider implements SourceProvider {
  readonly name: string;
  private readonly inflight = new Map<string, Promise<Source[]>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly inner: SourceProvider, private readonly dir: string, private readonly o: CacheOpts = {}) {
    this.name = inner.name;
    this.ttlMs = o.ttlMs ?? 6 * 3_600_000;
    this.now = o.now ?? Date.now;
    mkdirSync(path.join(dir, "q"), { recursive: true });
    mkdirSync(path.join(dir, "s"), { recursive: true });
  }

  private qfile(key: string) { return path.join(this.dir, "q", `${key}.json`); }
  private sfile(hash: string) { return path.join(this.dir, "s", `${hash}.json`); }

  private write(file: string, data: unknown) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  }

  private load(key: string, ignoreAge: boolean): Source[] | null {
    const f = this.qfile(key);
    if (!existsSync(f)) return null;
    try {
      const idx = JSON.parse(readFileSync(f, "utf8")) as QueryIndex;
      if (!ignoreAge && this.now() - idx.at > this.ttlMs) return null;
      const out: Source[] = [];
      for (const h of idx.hashes) out.push(JSON.parse(readFileSync(this.sfile(h), "utf8")) as Source);
      return out;
    } catch { return null; }
  }

  find(query: string, n: number): Promise<Source[]> {
    const key = sha256Hex(`${this.inner.name}|${n}|${query}`).slice(0, 32);
    const hit = this.load(key, !!this.o.offline);
    if (hit) return Promise.resolve(hit);
    if (this.o.offline) return Promise.resolve([]);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async () => {
      const found = await this.inner.find(query, n);
      for (const s of found) this.write(this.sfile(s.contentHash), s);
      if (found.length) this.write(this.qfile(key), { at: this.now(), hashes: found.map((s) => s.contentHash) } satisfies QueryIndex);
      return found;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

/** Fixed documents, for tests and offline demos. Not a source of truth: it returns whatever it was given. */
export class StaticProvider implements SourceProvider {
  readonly name = "static";
  constructor(private readonly docs: Source[]) {}
  async find(query: string, n: number): Promise<Source[]> {
    const kw = new Set(keywords(query));
    return this.docs
      .map((d) => ({ d, s: keywords(d.title + " " + d.text).filter((w) => kw.has(w)).length }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((x) => x.d);
  }
}

export function staticSource(title: string, text: string): Source {
  return { title, url: `https://mock-corpus.invalid/${encodeURIComponent(title)}`, text, contentHash: sha256Hex(text), provider: "static" };
}

/** Refetch an evidence URI and compare it with the hash recorded on chain. */
export async function verifyEvidenceHash(uri: string, expected: string, fetchFn: FetchFn = fetch, o: GetOpts = {}): Promise<{ ok: boolean; actual: string }> {
  const actual = sha256Hex(await getBytes(fetchFn, uri, o));
  return { ok: actual === expected, actual };
}

/**
 * As `verifyEvidenceHash`, and also: is the quote the agent posted really in that page? The page is reduced to text by
 * the same `cleanWikitext` the agents used. `quoteFound` is null when no quote was given.
 */
export async function verifyEvidenceContent(
  uri: string, expected: string, quote: string | null, fetchFn: FetchFn = fetch, o: GetOpts = {},
): Promise<{ ok: boolean; actual: string; quoteFound: boolean | null }> {
  const bytes = await getBytes(fetchFn, uri, o);
  const actual = sha256Hex(bytes);
  const quoteFound = quote ? quoteIsInSource(quote, cleanWikitext(new TextDecoder().decode(bytes))) : null;
  return { ok: actual === expected, actual, quoteFound };
}
