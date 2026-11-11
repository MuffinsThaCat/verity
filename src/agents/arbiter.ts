import type { Chain } from "../lib/chain.js";
import type { ActivitySink } from "../lib/activity.js";
import type { Side, Violation } from "../lib/types.js";
import { YOCTO_PER_NEAR } from "../lib/units.js";
import { BondKeeper } from "./keeper.js";

export interface ArbiterOpts {
  name: string;
  chain: Chain;
  activity: ActivitySink;
  /** Ignore links the crowd does not believe. */
  minLinkConfBps?: number;
  /** Ignore small inconsistencies. */
  minGapBps?: number;
  /** Cap per leg, in NEAR. */
  maxLegNear?: number;
  reserveNear?: number;
  cooldownMs?: number;
  /** Also settle evidence bonds whose window has passed (anyone may; nothing else does). Default true. */
  settleBonds?: boolean;
  /** Only links whose two claims are both in these articles are traded (see `followedArticles`). */
  followed?: () => Promise<Set<string>>;
}

const toYocto = (near: number) => BigInt(Math.round(near * 1e6)) * (YOCTO_PER_NEAR / 1_000_000n);

export interface Leg {
  claimId: number;
  side: Side;
}

/**
 * The legs that profit if a logical constraint between two claims is restored.
 *  A implies B, priced pA > pB:  A is too high or B is too low, so buy NO on A and YES on B.
 *  A excludes B, priced pA + pB > 1: both cannot be true, so buy NO on both.
 * These are convergence trades, not guaranteed arbitrage: nothing resolves, so profit depends on prices moving.
 */
export function legsFor(v: Pick<Violation, "rel" | "a" | "b">): Leg[] {
  return v.rel === "Implies"
    ? [{ claimId: v.a, side: "No" }, { claimId: v.b, side: "Yes" }]
    : [{ claimId: v.a, side: "No" }, { claimId: v.b, side: "No" }];
}

export class Arbiter {
  private readonly lastTrade = new Map<number, number>();
  private readonly o: Required<Omit<ArbiterOpts, "followed">> & { followed?: () => Promise<Set<string>> };
  private readonly rootOf = new Map<number, string>();
  private readonly keeper: BondKeeper | null;

  constructor(opts: ArbiterOpts) {
    this.o = { minLinkConfBps: 6_000, minGapBps: 600, maxLegNear: 0.6, reserveNear: 1.5, cooldownMs: 20_000, settleBonds: true, ...opts };
    this.keeper = this.o.settleBonds ? new BondKeeper(opts.chain, opts.name, opts.activity) : null;
  }

  get name() { return this.o.name; }

  private say(kind: Parameters<ActivitySink["emit"]>[0]["kind"], text: string, claimId?: number, data?: Record<string, unknown>) {
    this.o.activity.emit({ agent: this.o.name, kind, text, claimId, data });
  }

  /** One pass. Returns the number of legs traded. */
  async cycle(): Promise<number> {
    // Ask for more than are acted on: links in cooldown must not keep smaller ones from ever being served.
    const violations = await this.o.chain.violations(this.o.minLinkConfBps, this.o.minGapBps, 20, 3);
    this.say("scan", `${violations.length} inconsistent link(s)`);
    let legs = 0;
    const followed = await this.o.followed?.();
    let acted = 0;
    for (const v of violations) {
      if (acted >= 5) break;
      if (followed && !(await this.bothFollowed(v, followed))) continue;
      const last = this.lastTrade.get(v.link_id) ?? 0;
      if (Date.now() - last < this.o.cooldownMs) continue;
      acted++;
      try {
        legs += await this.act(v);
      } catch (e) {
        this.say("error", `link ${v.link_id}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
      this.lastTrade.set(v.link_id, Date.now());
    }
    if (this.keeper) {
      try { await this.keeper.cycle(); } catch (e) { this.say("error", `settling bonds: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
    }
    return legs;
  }

  /** A topic never changes its article, so each claim is looked up once. */
  private async articleOfClaim(id: number): Promise<string | null> {
    let r = this.rootOf.get(id);
    if (r === undefined) {
      const c = await this.o.chain.claim(id);
      if (!c) return null;
      r = c.topic.split("/")[0]!;
      this.rootOf.set(id, r);
    }
    return r;
  }

  private async bothFollowed(v: Violation, followed: Set<string>): Promise<boolean> {
    const [a, b] = [await this.articleOfClaim(v.a), await this.articleOfClaim(v.b)];
    return a !== null && b !== null && followed.has(a) && followed.has(b);
  }

  /** Whether the two claims of a link are still priced inconsistently. */
  private async stillInconsistent(v: Violation): Promise<boolean> {
    const [a, b] = await Promise.all([this.o.chain.claim(v.a), this.o.chain.claim(v.b)]);
    if (!a || !b) return false;
    const gap = v.rel === "Implies" ? a.price_bps - b.price_bps : a.price_bps + b.price_bps - 10_000;
    return gap > 0;
  }

  private async act(v: Violation): Promise<number> {
    const balance = await this.o.chain.balance();
    const spendable = Number(balance - toYocto(this.o.reserveNear)) / Number(YOCTO_PER_NEAR);
    if (spendable < 0.05) {
      this.say("skip", `link ${v.link_id}: out of spendable balance`);
      return 0;
    }
    // Bigger inconsistency, more conviction, but never more than the cap.
    const leg = Math.min(this.o.maxLegNear, spendable / 4, Math.max(0.05, (v.gap_bps / 10_000) * 3 * this.o.maxLegNear));
    const stake = toYocto(leg);
    const rel = v.rel === "Implies" ? `#${v.a} implies #${v.b}` : `#${v.a} excludes #${v.b}`;
    this.say("arb", `link ${v.link_id} (${rel}, belief ${Math.round(v.link_conf_bps / 100)}%): prices ${Math.round(v.price_a_bps / 100)}% / ${Math.round(v.price_b_bps / 100)}% break it by ${Math.round(v.gap_bps / 100)} points`, v.a, { violation: v });
    let done = 0;
    for (const l of legsFor(v)) {
      // Other agents trade the same claims, and the contract refuses a buy that got fewer shares than quoted. Before trying
      // again, check the contradiction is still there: someone else may just have closed it.
      for (let attempt = 1; ; attempt++) {
        const q = await this.o.chain.quoteBuy(l.claimId, l.side, stake, this.o.chain.accountId);
        try {
          await this.o.chain.buy(l.claimId, l.side, stake, (BigInt(q.out) * 95n) / 100n, null);
          break;
        } catch (e) {
          if (attempt >= 3 || !/slippage/.test(e instanceof Error ? e.message : String(e))) throw e;
          if (!(await this.stillInconsistent(v))) {
            this.say("info", `link ${v.link_id}: the prices moved and the contradiction is gone; leaving it`, v.a);
            return done;
          }
          this.say("info", `link ${v.link_id}: the price moved under us; trying again`, l.claimId);
        }
      }
      const after = await this.o.chain.claim(l.claimId);
      this.say("trade", `claim #${l.claimId}: bought ${l.side.toUpperCase()} with ${leg.toFixed(3)} NEAR -> price ${Math.round((after?.price_bps ?? 0) / 100)}%`, l.claimId, { side: l.side, after: after?.price_bps });
      done++;
    }
    return done;
  }
}
