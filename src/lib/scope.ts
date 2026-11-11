import type { Chain } from "./chain.js";
import type { ClaimView } from "./types.js";
import { mapLimit } from "./concurrency.js";
import { articleOf } from "./uri.js";

/**
 * Which articles are followed. Anyone can open a claim under a new first topic segment for a fraction of a NEAR, so an
 * unbounded list lets someone else decide what the server polls and what the agents spend their money on. An explicit list
 * wins; otherwise the first `max` in the order they were created (so later spam cannot displace the seeded articles).
 */
export function selectArticles(roots: string[], allow: string[] | undefined, max: number): string[] {
  if (allow && allow.length) return roots.filter((r) => allow.includes(r));
  return roots.slice(0, max);
}

/**
 * A list the contract only ever appends to (topics, links, evidence), read once and then only what is new. A poll after the first
 * asks for what was added since, usually nothing, so the cost of reading does not grow with the list, and a flood of junk costs one
 * catch-up in pages small enough for a view call. Callers that arrive while a read is under way share it: two reads starting
 * together would each append the same page, and the next one would start past the end and skip entries for good.
 */
export class AppendIndex<T> {
  readonly list: T[] = [];
  private inflight: Promise<T[]> | null = null;
  constructor(private readonly fetchPage: (from: number, limit: number) => Promise<T[]>, private readonly page: number) {}

  /** Fetches what was added since the last call and returns the full list. */
  refresh(): Promise<T[]> {
    if (!this.inflight) this.inflight = this.catchUp().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async catchUp(): Promise<T[]> {
    for (;;) {
      const got = await this.fetchPage(this.list.length, this.page);
      this.list.push(...got);
      if (got.length < this.page) return this.list;
    }
  }
}

export class TopicIndex extends AppendIndex<string> {
  constructor(chain: Pick<Chain, "topics">, page = 200) {
    super((from, limit) => chain.topics(from, limit), page);
  }

  /** First path segments, in the order the articles were created; the link topic is not an article. */
  roots(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of this.list) {
      if (t === "meta:links") continue;
      const r = articleOf(t);
      if (!seen.has(r)) { seen.add(r); out.push(r); }
    }
    return out;
  }
}

export interface Scope {
  /** The articles worth the agents' money. */
  followed(): Promise<Set<string>>;
  /** The claims of those articles (and possibly others: callers filter by `followed`), read the cheaper of the two ways. */
  claims(): Promise<ClaimView[]>;
}

const CLAIMS_PAGE = 50;

/**
 * What the agents follow. The topic list is read at most once per `ttlMs` (a topic never changes its article, so a slightly old
 * answer only ever misses an article created in the last minute). Claims are read page by page when that takes fewer calls than
 * one per followed topic, and topic by topic otherwise, so the cost follows what is followed, not how much junk exists.
 */
export function createScope(
  chain: Pick<Chain, "topics" | "claimsByTopic" | "config" | "allClaims">, allow: string[] | undefined, max: number, ttlMs = 60_000, now: () => number = Date.now,
): Scope {
  const index = new TopicIndex(chain);
  let cache: { at: number; set: Set<string> } | null = null;
  const load = async () => {
    if (cache && now() - cache.at < ttlMs) return cache.set;
    await index.refresh();
    cache = { at: now(), set: new Set(selectArticles(index.roots(), allow, max)) };
    return cache.set;
  };
  return {
    followed: load,
    async claims() {
      const set = await load();
      const topics = index.list.filter((t) => t !== "meta:links" && set.has(articleOf(t)));
      const pages = Math.ceil((await chain.config()).claims / CLAIMS_PAGE);
      if (pages <= topics.length) return chain.allClaims();
      return (await mapLimit(topics, 4, (t) => chain.claimsByTopic(t))).flat();
    },
  };
}

/** Just the followed articles, for callers that need nothing else. */
export function followedArticles(chain: Pick<Chain, "topics">, allow: string[] | undefined, max: number, ttlMs = 60_000, now: () => number = Date.now): () => Promise<Set<string>> {
  return createScope(chain as Pick<Chain, "topics" | "claimsByTopic" | "config" | "allClaims">, allow, max, ttlMs, now).followed;
}
