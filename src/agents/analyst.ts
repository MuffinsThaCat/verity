import type { Chain } from "../lib/chain.js";
import type { ActivitySink } from "../lib/activity.js";
import type { Judge, Verdict } from "../lib/judge.js";
import { searchQueryFor, searchSubjectsFor, type Source, type SourceProvider } from "../lib/sources.js";
import type { ClaimView, Evidence, Side } from "../lib/types.js";
import { YOCTO_PER_NEAR } from "../lib/units.js";
import { articleOf } from "../lib/uri.js";

export type Persona = "researcher" | "skeptic";

export interface AnalystOpts {
  name: string;
  persona: Persona;
  chain: Chain;
  judge: Judge;
  sources: SourceProvider;
  activity: ActivitySink;
  topics?: string[];
  /** Hard cap on one trade, in NEAR. This is the agent's own spending limit. */
  maxTradeNear?: number;
  /** Fraction of full Kelly to bet. Full Kelly is far too aggressive for a noisy judge. */
  kelly?: number;
  /** Smallest gap between the agent's belief and the price worth trading on. */
  minEdge?: number;
  maxClaimsPerCycle?: number;
  sourcesPerClaim?: number;
  /** Who is reviewing which claim. Defaults to one shared by every agent in the process, so two never post the same source. */
  locks?: ReviewLocks;
  /** The articles worth the agent's money (see `followedArticles`). Claims anywhere else are left alone. */
  followed?: () => Promise<Set<string>>;
  /** Where the claims come from (see `createScope`). Default: every claim on the contract. */
  claims?: () => Promise<ClaimView[]>;
  /** NEAR the agent never touches. */
  reserveNear?: number;
  recheckAfterMs?: number;
}

const toYocto = (near: number) => BigInt(Math.round(near * 1e6)) * (YOCTO_PER_NEAR / 1_000_000n);
const EVIDENCE_FEE_Y = 10n ** 22n;
const MIN_BOND_Y = 2n * 10n ** 22n;
const MAX_EVIDENCE_PER_CLAIM = 64;
/** The contract lets one account hold this many of a claim's evidence slots. */
const MAX_EVIDENCE_PER_AUTHOR = 8;

/**
 * What the contract asks for a piece of evidence on a claim that already has `count`: the 0.01 NEAR fee, a surcharge of one
 * eighth of it per piece already attached, and a bond of at least 0.02 NEAR. Anything above that becomes bond.
 */
export function evidenceDeposit(count: number): bigint {
  return (EVIDENCE_FEE_Y * (8n + BigInt(Math.max(0, count)))) / 8n + MIN_BOND_Y;
}
const MIN_TRADE = toYocto(0.012);
const RETRY_AFTER_FAILURE_MS = 15_000;
/** A trade that cites evidence must put at least the bond behind it, or the bond is forfeited; the bond is 0.02 NEAR. */
const MIN_CITING_STAKE = 0.025;
const MAX_BUY_ATTEMPTS = 3;

/**
 * Who is reviewing which claim. Without it two agents that pick the same claim in the same second both find "no evidence
 * yet" and both post the same source, each paying a fee and splitting the backing.
 */
export class ReviewLocks {
  private readonly held = new Map<number, { by: string; until: number }>();
  constructor(private readonly ttlMs = 120_000, private readonly now: () => number = Date.now) {}
  /** Takes the claim, or renews it for the agent that already holds it. False when another agent holds it. */
  tryAcquire(claimId: number, by: string): boolean {
    if (this.held.size > 256) this.purge();
    const h = this.held.get(claimId);
    if (h && h.until > this.now() && h.by !== by) return false;
    this.held.set(claimId, { by, until: this.now() + this.ttlMs });
    return true;
  }
  release(claimId: number, by: string) {
    if (this.held.get(claimId)?.by === by) this.held.delete(claimId);
  }
  /** Who holds the claim right now, if anyone. */
  holder(claimId: number): string | null {
    const h = this.held.get(claimId);
    return h && h.until > this.now() ? h.by : null;
  }
  get size() { return this.held.size; }
  private purge() {
    for (const [id, h] of this.held) if (h.until <= this.now()) this.held.delete(id);
  }
}

/** One for the whole process: every agent that does not bring its own shares it, which is what keeps two of them off one claim. */
const processLocks = new ReviewLocks();

/**
 * NEAR to stake: fractional Kelly of what the agent can spend, capped, scaled by how much the reading deserves, and never
 * below the smallest trade (nor below the bond when the trade cites evidence, so the bond is not lost).
 */
export function sizeStake(o: { spendableNear: number; kelly: number; fraction: number; maxTradeNear: number; weight?: number; cites?: boolean }): number {
  const weight = Math.min(1, Math.max(0, o.weight ?? 1));
  const raw = Math.min(o.maxTradeNear, o.spendableNear * o.kelly * o.fraction) * weight;
  return Math.max(raw, o.cites ? MIN_CITING_STAKE : 0.012);
}

export interface TradeDecision {
  side: Side;
  /** The agent's probability that the claim is true. */
  belief: number;
  price: number;
  /** Fraction of bankroll to stake. */
  fraction: number;
}

/**
 * Kelly sizing for a binary share priced at `price` when the agent believes the claim is true with probability
 * `belief`. Buying YES risks `price` to win `1 - price`, so the full-Kelly fraction is (belief - price) / (1 - price).
 * Buying NO is the mirror image. Returns null when the edge is smaller than `minEdge`.
 */
export function decide(belief: number, price: number, minEdgeYes: number, minEdgeNo: number): TradeDecision | null {
  if (belief - price >= minEdgeYes) return { side: "Yes", belief, price, fraction: (belief - price) / (1 - price) };
  if (price - belief >= minEdgeNo) return { side: "No", belief, price, fraction: (price - belief) / price };
  return null;
}

/**
 * Sources for a claim: the best matches for its words, plus the page on each thing it names ("Pluto", "Mount Everest").
 * The second kind finds the page that corrects a wrong figure, which a search on the wrong figure would never surface.
 * Results are interleaved so the limit cuts evenly across the searches, and de-duplicated by content.
 */
export async function gatherSources(provider: SourceProvider, claim: string, total: number): Promise<Source[]> {
  const lists: Source[][] = [await provider.find(searchQueryFor(claim), total)];
  for (const subject of searchSubjectsFor(claim).slice(0, 2)) {
    try { lists.push(await provider.find(subject, 1)); } catch { /* the main search is enough */ }
  }
  const seen = new Set<string>();
  const out: Source[] = [];
  for (let i = 0; out.length < total && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const s = l[i];
      if (!s || seen.has(s.contentHash)) continue;
      seen.add(s.contentHash);
      out.push(s);
      if (out.length >= total) break;
    }
  }
  return out;
}

export interface Reading { src: Source; v: Verdict }

export interface Choice {
  pick: Reading;
  /** The probability the agent trades on: the picked verdict, pulled halfway to 50% when a relevant source disagrees. */
  belief: number;
  dissent: boolean;
}

/**
 * Which source to act on. The most relevant one, not the one that moves the price furthest: picking the largest edge
 * rewards the noisiest reading. If another relevant source takes the opposite side, the agent halves its conviction.
 */
export function chooseReading(reads: Reading[], minRelevance = 0.5): Choice | null {
  const usable = reads.filter((r) => r.v.stance !== "irrelevant" && r.v.relevance >= minRelevance);
  if (usable.length === 0) return null;
  const pick = usable.slice().sort((a, b) => b.v.relevance - a.v.relevance || Math.abs(b.v.probability - 0.5) - Math.abs(a.v.probability - 0.5))[0]!;
  const dissent = usable.some((r) => r !== pick && r.v.stance !== pick.v.stance && r.v.relevance >= pick.v.relevance - 0.2);
  return { pick, belief: dissent ? 0.5 + (pick.v.probability - 0.5) * 0.5 : pick.v.probability, dissent };
}

export class Analyst {
  private readonly checked = new Map<number, { priceBps: number; at: number }>();
  private readonly o: Required<Omit<AnalystOpts, "topics" | "followed" | "claims">> & { topics?: string[]; followed?: () => Promise<Set<string>>; claims?: () => Promise<ClaimView[]> };

  constructor(opts: AnalystOpts) {
    this.o = {
      maxTradeNear: 1, kelly: 0.25, minEdge: 0.08, maxClaimsPerCycle: 3, sourcesPerClaim: 2, reserveNear: 1.5,
      recheckAfterMs: 10 * 60_000, locks: processLocks, ...opts,
    };
  }

  get name() { return this.o.name; }

  private say(kind: Parameters<ActivitySink["emit"]>[0]["kind"], text: string, claimId?: number, data?: Record<string, unknown>) {
    this.o.activity.emit({ agent: this.o.name, kind, text, claimId, data });
  }

  private pick(claims: ClaimView[], followed?: Set<string>): ClaimView[] {
    const now = Date.now();
    const fresh = claims.filter((c) => {
      if (c.link_id !== null) return false;
      if (followed && !followed.has(articleOf(c.topic))) return false;
      if (this.o.topics && !this.o.topics.some((t) => t === c.topic || t === articleOf(c.topic))) return false;
      const seen = this.checked.get(c.id);
      return !seen || Math.abs(seen.priceBps - c.price_bps) >= 500 || now - seen.at > this.o.recheckAfterMs;
    });
    if (this.o.persona === "skeptic") {
      // Audit the claims the market is most sure of that have the least evidence behind them. A skeptic that finds
      // the same source as someone else corroborates it; one that finds a contradicting source attacks the claim.
      return fresh.sort((a, b) => b.price_bps / (1 + b.evidence.length) - a.price_bps / (1 + a.evidence.length));
    }
    // Researchers go where nobody has looked: claims with no evidence, then the least-checked.
    return fresh.sort((a, b) => a.evidence.length - b.evidence.length || a.id - b.id);
  }

  /** A judge that is down gives nothing on every pass; one line a minute per claim says so without filling the feed. */
  private readonly noVerdictSaid = new Map<number, number>();
  private noVerdict(id: number, title: string) {
    if (Date.now() - (this.noVerdictSaid.get(id) ?? 0) < 60_000) return;
    this.noVerdictSaid.set(id, Date.now());
    this.say("error", `claim #${id}: the judge gave no verdict on "${title}"`, id);
  }

  private readonly busySaid = new Map<number, number>();
  private noteBusy(id: number) {
    if (Date.now() - (this.busySaid.get(id) ?? 0) < 60_000) return;
    this.busySaid.set(id, Date.now());
    this.say("skip", `claim #${id}: ${this.o.locks.holder(id) ?? "another agent"} is reviewing it; I will cite its evidence on a later pass`, id);
  }

  /** One pass over the market. Returns the number of trades made. */
  async cycle(): Promise<number> {
    const claims = await (this.o.claims ? this.o.claims() : this.o.chain.allClaims());
    const candidates = this.pick(claims, await this.o.followed?.());
    this.say("scan", `${claims.length} claims, reviewing up to ${this.o.maxClaimsPerCycle}`);
    let trades = 0;
    let reviewed = 0;
    for (const c of candidates) {
      // The quota counts claims actually reviewed: one another agent is on costs a look at the next, not a slot.
      if (reviewed >= this.o.maxClaimsPerCycle) break;
      if (!this.o.locks.tryAcquire(c.id, this.o.name)) { this.noteBusy(c.id); continue; }
      let traded: boolean | null = false;
      try {
        try {
          traded = await this.review(c);
        } catch (e) {
          this.say("error", `claim #${c.id}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, c.id);
          // A read that failed (a rate limit, a timeout) is not a review. Look again soon, not after a full recheck period.
          this.checked.set(c.id, { priceBps: c.price_bps, at: Date.now() - this.o.recheckAfterMs + Math.min(RETRY_AFTER_FAILURE_MS, this.o.recheckAfterMs) });
          reviewed++;
          continue;
        }
      } finally {
        this.o.locks.release(c.id, this.o.name);
      }
      if (traded === null) continue; // the claim was taken from us while we read; nothing was done, so it is not "checked"
      reviewed++;
      if (traded) trades++;
      // A price that moved because of our own trade is not news; record the price we left it at.
      else this.checked.set(c.id, { priceBps: c.price_bps, at: Date.now() });
    }
    return trades;
  }

  private async bestVerdict(c: ClaimView): Promise<Choice | null> {
    const found = await gatherSources(this.o.sources, c.text, this.o.sourcesPerClaim);
    if (found.length === 0) {
      this.say("skip", `claim #${c.id}: no sources found`, c.id);
      return null;
    }
    const reads: Reading[] = [];
    for (const src of found) {
      this.say("source", `claim #${c.id}: reading "${src.title}"`, c.id, { url: src.url });
      const v = await this.o.judge.judge(c.text, src);
      if (!v) { this.noVerdict(c.id, src.title); continue; }
      if (v.stance === "irrelevant" || v.relevance < 0.5) continue;
      this.say("judge", `claim #${c.id}: ${v.stance} (${Math.round(v.probability * 100)}%) — "${v.quote.slice(0, 120)}"`, c.id, { source: src.title, rationale: v.rationale });
      reads.push({ src, v });
    }
    const choice = chooseReading(reads);
    if (choice?.dissent) this.say("info", `claim #${c.id}: sources disagree, halving conviction`, c.id);
    return choice;
  }

  /** True if it traded, false if it looked and did not, null if it had to stop because another agent took the claim. */
  private async review(c: ClaimView): Promise<boolean | null> {
    const choice = await this.bestVerdict(c);
    if (!choice) return false;
    const { src, v } = choice.pick;
    const price = c.price_bps / 10_000;

    // A skeptic wants more convincing before it buys YES, a researcher before it buys NO.
    const e = this.o.minEdge;
    const [yesEdge, noEdge] = this.o.persona === "skeptic" ? [e * 1.5, e * 0.75] : [e * 0.75, e * 1.5];
    const d = decide(choice.belief, price, yesEdge, noEdge);
    if (!d) {
      this.say("skip", `claim #${c.id}: belief ${Math.round(choice.belief * 100)}% vs price ${Math.round(price * 100)}% — no edge`, c.id);
      return false;
    }

    const weight = v.weight ?? 1;
    const stance = d.side === "Yes" ? "Support" : "Refute";
    const cites = v.stance === stance.toLowerCase();
    const balance = await this.o.chain.balance();
    const spendable = Number(balance - toYocto(this.o.reserveNear)) / Number(YOCTO_PER_NEAR);
    // Posting evidence costs a deposit and the trade that cites it must put the bond behind it: having paid for the one
    // and being unable to afford the other would forfeit the bond.
    // One more than the claim shows, in case another agent's evidence lands first: the contract would refuse a deposit that is short.
    const depositNear = Number(evidenceDeposit(Math.min(c.evidence.length + 1, MAX_EVIDENCE_PER_CLAIM))) / Number(YOCTO_PER_NEAR);
    const needed = cites ? depositNear + MIN_CITING_STAKE : 0.02;
    if (spendable < needed) {
      this.say("skip", `claim #${c.id}: out of spendable balance`, c.id);
      return false;
    }
    let stakeNear = sizeStake({ spendableNear: spendable, kelly: this.o.kelly, fraction: d.fraction, maxTradeNear: this.o.maxTradeNear, weight, cites });
    if (toYocto(stakeNear) < MIN_TRADE) return false;

    // Cite evidence only when its stance agrees with the side taken, so the contract's backing counts mean something.
    let evidenceId: number | null = null;
    if (cites) {
      // Reading the sources can take minutes under a rate limit, longer than the lock lasts. Take it again now: the check for
      // existing evidence and the post that follows must happen under it, and if another agent has the claim, leave it to them.
      if (!this.o.locks.tryAcquire(c.id, this.o.name)) {
        this.say("skip", `claim #${c.id}: ${this.o.locks.holder(c.id) ?? "another agent"} took it while I was reading; leaving it to them`, c.id);
        return null;
      }
      const attached = await this.o.chain.evidenceFor(c.id);
      let existing = attached.find((x: Evidence) => x.content_hash === src.contentHash && x.stance === stance);
      // At its quota of slots on this claim an agent cannot post more; it cites what is there on the same side instead.
      if (!existing && attached.filter((x: Evidence) => x.author === this.o.chain.accountId).length >= MAX_EVIDENCE_PER_AUTHOR) {
        existing = attached.find((x: Evidence) => x.stance === stance);
        if (!existing) { this.say("skip", `claim #${c.id}: out of evidence slots on this claim and nothing on this side to cite`, c.id); return false; }
      }
      if (existing) {
        evidenceId = existing.id;
        this.say("evidence", `claim #${c.id}: corroborating evidence #${existing.id} (same source, same hash)`, c.id, { reused: true, evidenceId: existing.id });
      } else {
        evidenceId = Number(await this.o.chain.postEvidence(c.id, stance, src.url, src.contentHash, `"${v.quote}"`.slice(0, 280), evidenceDeposit(Math.min(attached.length + 1, MAX_EVIDENCE_PER_CLAIM))));
        this.say("evidence", `claim #${c.id}: posted ${stance.toLowerCase()} evidence #${evidenceId} from ${src.title}`, c.id, { url: src.url, hash: src.contentHash });
      }
    }

    // Another agent can move the price between the quote and the buy, which the contract refuses as slippage. The evidence
    // is already posted, so give up only after looking again: if the edge is gone, still put the bond behind the evidence
    // (a small trade on the side it argues for) rather than forfeit the bond.
    let side = d.side;
    let fraction = d.fraction;
    for (let attempt = 1; ; attempt++) {
      const stake = toYocto(stakeNear);
      const q = await this.o.chain.quoteBuy(c.id, side, stake, this.o.chain.accountId);
      try {
        await this.o.chain.buy(c.id, side, stake, (BigInt(q.out) * 95n) / 100n, evidenceId);
        break;
      } catch (e) {
        if (attempt >= MAX_BUY_ATTEMPTS || !/slippage/.test(e instanceof Error ? e.message : String(e))) throw e;
        const now = await this.o.chain.claim(c.id);
        const again = decide(choice.belief, (now?.price_bps ?? c.price_bps) / 10_000, yesEdge, noEdge);
        if (again && again.side === d.side) {
          fraction = again.fraction;
          stakeNear = sizeStake({ spendableNear: spendable, kelly: this.o.kelly, fraction, maxTradeNear: this.o.maxTradeNear, weight, cites });
          this.say("info", `claim #${c.id}: the price moved under us; trying again at ${Math.round((now?.price_bps ?? 0) / 100)}%`, c.id);
        } else if (evidenceId !== null) {
          stakeNear = MIN_CITING_STAKE;
          this.say("info", `claim #${c.id}: the price moved and the edge is gone; backing the evidence with a small trade so its bond is not lost`, c.id);
        } else throw e;
      }
    }
    const after = await this.o.chain.claim(c.id);
    this.checked.set(c.id, { priceBps: after?.price_bps ?? c.price_bps, at: Date.now() });
    const nearAmt = stakeNear.toFixed(3);
    this.say(
      "trade",
      `claim #${c.id}: bought ${side.toUpperCase()} with ${nearAmt} NEAR (belief ${Math.round(d.belief * 100)}%, Kelly ${(fraction * this.o.kelly * 100).toFixed(0)}% of bankroll${weight < 1 ? `, weighted ${Math.round(weight * 100)}%` : ""}): ${Math.round(price * 100)}% -> ${Math.round((after?.price_bps ?? 0) / 100)}%`,
      c.id,
      { side, near: nearAmt, before: c.price_bps, after: after?.price_bps, evidenceId },
    );
    return true;
  }
}
