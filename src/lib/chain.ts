import { Account } from "near-api-js";
import type {
  Accounting, BondState, ClaimView, Evidence, Link, Quote, Rel, Side, Stance, VerityConfig, Violation,
} from "./types.js";
import { TGAS } from "./units.js";

export interface CallOpts {
  deposit?: bigint;
  gas?: bigint;
}

/** How many times a rate-limited read is retried: waits of 0.4, 0.8, 1.6, 3.2, then 6 seconds each (about 30 in all), plus jitter. */
export const VIEW_RETRIES = 8;

/**
 * True for a provider's "too many requests": HTTP 429 (as a status or as the error's numeric cause), the JSON-RPC error code -429
 * some providers wrap it in, or the words. A bare "429" is not enough: "claim 429 not found" is a real answer, not a limit.
 */
export function isRateLimited(e: unknown): boolean {
  if ((e as { cause?: unknown } | null)?.cause === 429) return true;
  const text = e instanceof Error ? e.message : String(e);
  return /code\W{0,3}-?429|status(?: code)?\W{0,3}429|http\W{0,3}429|too many requests|rate limit/i.test(text);
}

/** Runs a read, waiting out a provider's rate limit with backoff. Only for reads: repeating a write could send it twice. */
export async function retryRead<T>(read: () => Promise<T>, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (e) {
      if (attempt >= VIEW_RETRIES || !isRateLimited(e)) throw e;
      await wait(Math.min(6000, 400 * 2 ** attempt) + Math.random() * 300);
    }
  }
}

/** The contract's MAX_VIOLATION_SCAN: how many links one get_violations call looks at. */
export const VIOLATION_WINDOW = 64;

/** Thin typed wrapper over the Verity contract. */
export class Chain {
  readonly account: Account;

  constructor(
    readonly accountId: string,
    secretKey: string | undefined,
    readonly contractId: string,
    readonly rpcUrl: string,
  ) {
    this.account = secretKey
      ? new Account(accountId, rpcUrl, secretKey as `ed25519:${string}`)
      : new Account(accountId, rpcUrl);
  }

  /** A read. An RPC provider's rate limit (HTTP 429) is waited out with backoff, because a read can safely be repeated. */
  view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return retryRead(() => this.account.provider.callFunction<any>({ contractId: this.contractId, method, args }) as Promise<T>);
  }

  call<T = unknown>(methodName: string, args: Record<string, unknown>, opts: CallOpts = {}): Promise<T> {
    return this.account.callFunction<any>({
      contractId: this.contractId,
      methodName,
      args,
      deposit: opts.deposit ?? 0n,
      gas: opts.gas ?? 80n * TGAS,
    }) as Promise<T>;
  }

  balance(): Promise<bigint> {
    return retryRead(() => this.account.getBalance());
  }

  // views
  config() { return this.view<VerityConfig>("get_config"); }
  claim(id: number) { return this.view<ClaimView | null>("get_claim", { claim_id: id }); }
  claims(from = 0, limit = 50) { return this.view<ClaimView[]>("get_claims", { from_index: from, limit }); }
  /** One page of the topic list (the contract returns at most 200). See `TopicIndex` for reading all of it. */
  topics(from = 0, limit = 200) { return this.view<string[]>("get_topics", { from_index: from, limit }); }
  claimsByTopic(topic: string) { return this.view<ClaimView[]>("get_claims_by_topic", { topic }); }
  evidenceFor(claimId: number) { return this.view<Evidence[]>("get_claim_evidence", { claim_id: claimId }); }
  /** Up to 100 pieces of evidence from `from`, in id order. */
  evidencePage(from: number, limit = 100) { return this.view<Evidence[]>("get_evidence_page", { from_index: from, limit }); }
  evidence(id: number) { return this.view<Evidence | null>("get_evidence", { evidence_id: id }); }
  links(from = 0, limit = 100) { return this.view<Link[]>("get_links", { from_index: from, limit }); }
  position(claimId: number, account: string) {
    return this.view<{ yes: string; no: string }>("get_position", { claim_id: claimId, account });
  }
  /** Pass `account` so the quote includes the 0.002 NEAR a first trade of the claim costs that account. */
  quoteBuy(claimId: number, side: Side, amount: bigint, account?: string) {
    return this.view<Quote>("quote_buy", { claim_id: claimId, side, amount: amount.toString(), account: account ?? null });
  }
  quoteSell(claimId: number, side: Side, shares: bigint) {
    return this.view<Quote>("quote_sell", { claim_id: claimId, side, shares: shares.toString() });
  }
  /**
   * Inconsistent links, most significant first. One contract call reads only the newest VIOLATION_WINDOW links (more would
   * not fit in a view call's gas), so `windows` > 1 walks back through older ones, each its own call.
   */
  async violations(minLinkConfBps: number, minGapBps: number, limit = 10, windows = 1): Promise<Violation[]> {
    const call = (before?: number) => this.view<Violation[]>("get_violations", { min_link_conf_bps: minLinkConfBps, min_gap_bps: minGapBps, limit, ...(before === undefined ? {} : { before }) });
    if (windows <= 1) return call();
    const total = (await this.config()).links;
    const out: Violation[] = [];
    for (let k = 0; k < windows; k++) {
      const hi = total - k * VIOLATION_WINDOW;
      if (hi <= 0) break;
      out.push(...(await call(hi)));
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  accounting() { return this.view<Accounting>("get_accounting"); }

  /** Every claim, paged. */
  async allClaims(): Promise<ClaimView[]> {
    const out: ClaimView[] = [];
    for (let from = 0; ; from += 50) {
      const page = await this.claims(from, 50);
      out.push(...page);
      if (page.length < 50) return out;
    }
  }

  // writes
  createClaim(topic: string, text: string, priorBps: number, deposit: bigint) {
    return this.call<number>("create_claim", { topic, text, prior_bps: priorBps }, { deposit });
  }
  createLink(a: number, b: number, rel: Rel, priorBps: number, deposit: bigint) {
    return this.call<number>("create_link", { a, b, rel, prior_bps: priorBps }, { deposit });
  }
  postEvidence(claimId: number, stance: Stance, uri: string, contentHash: string, note: string, deposit: bigint) {
    return this.call<number>("post_evidence", { claim_id: claimId, stance, uri, content_hash: contentHash, note }, { deposit });
  }
  buy(claimId: number, side: Side, deposit: bigint, minShares = 0n, evidenceId: number | null = null) {
    return this.call<string>("buy", { claim_id: claimId, side, min_shares: minShares.toString(), evidence_id: evidenceId }, { deposit });
  }
  sell(claimId: number, side: Side, shares: bigint, minProceeds = 0n) {
    return this.call<string>("sell", { claim_id: claimId, side, shares: shares.toString(), min_proceeds: minProceeds.toString() });
  }
  settleBond(evidenceId: number) { return this.call<BondState>("settle_bond", { evidence_id: evidenceId }); }
  withdrawFees(claimId: number) { return this.call<string>("withdraw_fees", { claim_id: claimId }); }
}

export const bps = (x: number) => x / 10_000;
