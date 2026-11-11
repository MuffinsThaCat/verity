import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Rel } from "../lib/types.js";

/**
 * Starter articles. One file per article: its claims (each may name a section), links between claims, and the lies the
 * demo offers to inject. A claim is referred to by its `key`, or `article#key` from another file.
 */
export interface SeedClaim { key?: string; text: string; prior_bps?: number; section?: string }
export interface SeedLink { a: string | number; b: string | number; rel: Rel; prior_bps?: number }
export interface SeedLie { text: string; section?: string; contradicts?: Array<string | number>; note?: string; prior_bps?: number }
/** A true sentence the demo can add to the article live, to show the encyclopedia growing. Nothing contradicts it. */
export interface SeedAdd { text: string; section?: string; note?: string }
export interface SeedFile { topic: string; claims: SeedClaim[]; links?: SeedLink[]; lies?: SeedLie[]; adds?: SeedAdd[] }

export interface LieOption {
  id: string;
  /** "lie": a false sentence backed with money, to be corrected. "add": a true sentence added at 50%, to be confirmed. */
  kind: "lie" | "add";
  article: string;
  /** Full topic the claim is opened under, section included. */
  topic: string;
  text: string;
  contradicts: Array<{ id: number; text: string }>;
  note: string;
  priorBps: number;
}

export interface Seeded {
  /** `article#key` and `article#index` → claim id. */
  ids: Map<string, number>;
  linkClaims: number[];
  lies: LieOption[];
}

export interface SeedTarget {
  createClaim(topic: string, text: string, priorBps: number, deposit: bigint): Promise<number | string | bigint>;
  createLink(a: number, b: number, rel: Rel, priorBps: number, deposit: bigint): Promise<number | string | bigint>;
}

/** The contract's own limit on a topic string, `article/section` included. */
export const MAX_TOPIC = 64;
const TOPIC = /^[a-z0-9_:-]{1,40}$/;
const SECTION = /^[a-z0-9_:-]{1,40}$/;

export const topicOf = (file: Pick<SeedFile, "topic">, section?: string) => (section ? `${file.topic}/${section}` : file.topic);

export function loadSeedDir(dir: string): SeedFile[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as SeedFile);
}

export function loadSeedFiles(paths: string[]): SeedFile[] {
  return paths.map((p) => JSON.parse(readFileSync(p, "utf8")) as SeedFile);
}

const refKey = (file: SeedFile, ref: string | number) => (typeof ref === "number" ? `${file.topic}#${ref}` : ref.includes("#") ? ref : `${file.topic}#${ref}`);

/** Everything that can be checked without touching a chain. Throws a message that names the file and the problem. */
export function validateSeeds(files: SeedFile[]): void {
  const known = new Set<string>();
  const topics = new Set<string>();
  for (const f of files) {
    if (!TOPIC.test(f.topic)) throw new Error(`seed "${f.topic}": topic must be lower-case letters, digits, - _ :`);
    if (topics.has(f.topic)) throw new Error(`seed "${f.topic}": two files for one article`);
    topics.add(f.topic);
    f.claims.forEach((c, i) => {
      if (c.section !== undefined && !SECTION.test(c.section)) throw new Error(`seed "${f.topic}": bad section "${c.section}"`);
      if (!c.text || c.text.length < 8 || c.text.length > 280) throw new Error(`seed "${f.topic}" claim ${i}: text must be 8 to 280 characters`);
      if (topicOf(f, c.section).length > MAX_TOPIC) throw new Error(`seed "${f.topic}" claim ${i}: "${topicOf(f, c.section)}" is longer than the contract's ${MAX_TOPIC}-character topic limit`);
      known.add(`${f.topic}#${i}`);
      if (c.key) {
        if (known.has(`${f.topic}#${c.key}`)) throw new Error(`seed "${f.topic}": duplicate key "${c.key}"`);
        known.add(`${f.topic}#${c.key}`);
      }
    });
  }
  for (const f of files) {
    const need = (ref: string | number, what: string) => {
      if (!known.has(refKey(f, ref))) throw new Error(`seed "${f.topic}": ${what} refers to unknown claim "${ref}"`);
    };
    for (const l of f.links ?? []) { need(l.a, "a link"); need(l.b, "a link"); }
    for (const lie of f.lies ?? []) {
      if (lie.section !== undefined && !SECTION.test(lie.section)) throw new Error(`seed "${f.topic}": bad section "${lie.section}" on a lie`);
      if (!lie.text || lie.text.length < 8 || lie.text.length > 280) throw new Error(`seed "${f.topic}": a lie must be 8 to 280 characters`);
      if (topicOf(f, lie.section).length > MAX_TOPIC) throw new Error(`seed "${f.topic}": a lie's topic "${topicOf(f, lie.section)}" is longer than the contract's ${MAX_TOPIC}-character limit`);
      for (const c of lie.contradicts ?? []) need(c, "a lie");
    }
    for (const add of f.adds ?? []) {
      if (add.section !== undefined && !SECTION.test(add.section)) throw new Error(`seed "${f.topic}": bad section "${add.section}" on an add`);
      if (!add.text || add.text.length < 8 || add.text.length > 280) throw new Error(`seed "${f.topic}": an add must be 8 to 280 characters`);
      if (topicOf(f, add.section).length > MAX_TOPIC) throw new Error(`seed "${f.topic}": an add's topic "${topicOf(f, add.section)}" is longer than the contract's ${MAX_TOPIC}-character limit`);
    }
  }
}

/**
 * Only the given articles, with every link and every "contradicts" that points at an article left out dropped, so a subset
 * of the seeds is still a consistent set (the offline demo has documents for one article only).
 */
export function restrictSeeds(files: SeedFile[], articles: string[]): SeedFile[] {
  const kept = files.filter((f) => articles.includes(f.topic));
  const known = new Set<string>();
  for (const f of kept) f.claims.forEach((c, i) => { known.add(`${f.topic}#${i}`); if (c.key) known.add(`${f.topic}#${c.key}`); });
  return kept.map((f) => ({
    ...f,
    links: (f.links ?? []).filter((l) => known.has(refKey(f, l.a)) && known.has(refKey(f, l.b))),
    lies: (f.lies ?? []).map((lie) => ({ ...lie, contradicts: (lie.contradicts ?? []).filter((c) => known.has(refKey(f, c))) })),
  }));
}

/** What seeding these files will spend, in yocto, before gas. */
export function seedCost(files: SeedFile[], o: { claimFee: bigint; seedDeposit: bigint; linkDeposit: bigint }): bigint {
  let total = 0n;
  for (const f of files) {
    total += BigInt(f.claims.length) * (o.claimFee + o.seedDeposit);
    total += BigInt((f.links ?? []).length) * (o.claimFee + o.linkDeposit);
  }
  return total;
}

/** Opens every claim, then every link, so a link may point at a claim in another file. */
export async function applySeeds(
  chain: SeedTarget,
  files: SeedFile[],
  o: { claimFee: bigint; seedDeposit: bigint; linkDeposit: bigint; log?: (line: string) => void },
): Promise<Seeded> {
  validateSeeds(files);
  const ids = new Map<string, number>();
  const texts = new Map<number, string>();
  for (const f of files) {
    for (const [i, c] of f.claims.entries()) {
      const id = Number(await chain.createClaim(topicOf(f, c.section), c.text, c.prior_bps ?? 5000, o.claimFee + o.seedDeposit));
      ids.set(`${f.topic}#${i}`, id);
      if (c.key) ids.set(`${f.topic}#${c.key}`, id);
      texts.set(id, c.text);
      o.log?.(`#${id} [${topicOf(f, c.section)}] ${c.text}`);
    }
  }
  const linkClaims: number[] = [];
  for (const f of files) {
    for (const l of f.links ?? []) {
      const a = ids.get(refKey(f, l.a))!;
      const b = ids.get(refKey(f, l.b))!;
      linkClaims.push(Number(await chain.createLink(a, b, l.rel, l.prior_bps ?? 9000, o.claimFee + o.linkDeposit)));
      o.log?.(`link: #${a} ${l.rel} #${b}`);
    }
  }
  return { ids, linkClaims, lies: demoOptions(files, ids, texts) };
}

/** The lies and the true sentences a demo offers, with every "contradicts" resolved to a claim id. */
export function demoOptions(files: SeedFile[], ids: Map<string, number>, texts: Map<number, string>): LieOption[] {
  const out: LieOption[] = [];
  for (const f of files) {
    (f.lies ?? []).forEach((lie, i) => {
      const contradicts: Array<{ id: number; text: string }> = [];
      for (const c of lie.contradicts ?? []) {
        const id = ids.get(refKey(f, c));
        if (id !== undefined) contradicts.push({ id, text: texts.get(id) ?? "" });
      }
      out.push({
        id: `${f.topic}:${i}`, kind: "lie", article: f.topic, topic: topicOf(f, lie.section), text: lie.text,
        contradicts, note: lie.note ?? "", priorBps: lie.prior_bps ?? 8000,
      });
    });
    (f.adds ?? []).forEach((add, i) => {
      out.push({
        id: `${f.topic}:add${i}`, kind: "add", article: f.topic, topic: topicOf(f, add.section), text: add.text,
        contradicts: [], note: add.note ?? "", priorBps: 5000,
      });
    });
  }
  return out;
}

/**
 * For a contract that was seeded earlier (so this process never saw the ids): finds each seed claim on the chain by its topic
 * and text, and builds the same options `applySeeds` would have. A lie whose target is not on the chain loses that target.
 */
export function resolveSeeds(files: SeedFile[], onChain: Array<{ id: number; topic: string; text: string }>): LieOption[] {
  const ids = new Map<string, number>();
  const texts = new Map<number, string>();
  const byKey = new Map(onChain.map((c) => [`${c.topic}\n${c.text}`, c]));
  for (const f of files) {
    f.claims.forEach((c, i) => {
      const hit = byKey.get(`${topicOf(f, c.section)}\n${c.text}`);
      if (!hit) return;
      ids.set(`${f.topic}#${i}`, hit.id);
      if (c.key) ids.set(`${f.topic}#${c.key}`, hit.id);
      texts.set(hit.id, c.text);
    });
  }
  return demoOptions(files, ids, texts);
}
