import { test } from "node:test";
import assert from "node:assert/strict";
import { Analyst, ReviewLocks, evidenceDeposit, sizeStake } from "../src/agents/analyst.js";
import { BondKeeper } from "../src/agents/keeper.js";
import { MemoryActivity } from "../src/lib/activity.js";
import { OfflineJudge } from "../src/lib/offlineJudge.js";
import { StaticProvider, staticSource } from "../src/lib/sources.js";
import type { Chain } from "../src/lib/chain.js";
import type { ClaimView, Evidence } from "../src/lib/types.js";

const NEAR = 10n ** 24n;
const SLIPPAGE = "Smart contract panicked: slippage: fewer shares than min_shares";
const TEXT = "Pluto has five known natural satellites: Charon, Styx, Nix, Kerberos and Hydra.";
const CLAIM = "Pluto has five known natural satellites.";

const claimView = (id: number, price: number): ClaimView => ({
  id, topic: "pluto", text: CLAIM, creator: "c.near", created_ms: 0, price_bps: price, collateral: "0", reserve_yes: "0", reserve_no: "0",
  volume: "0", trades: 0, fee_pool: "0", evidence: [], links: [], link_id: null, tape: [],
});

class FakeChain {
  accountId = "fake.near";
  posted: Array<{ claimId: number; stance: string; hash: string; note: string; author?: string; deposit?: bigint }> = [];
  buys: Array<{ claimId: number; side: string; deposit: bigint; evidence: number | null }> = [];
  prices: number[];
  failBuys: number;
  claims: number;
  balanceNear: number;
  constructor(price = 5000, failBuys = 0, afterFailPrice = price, opts: { claims?: number; balanceNear?: number } = {}) {
    this.prices = [price, afterFailPrice];
    this.failBuys = failBuys;
    this.claims = opts.claims ?? 1;
    this.balanceNear = opts.balanceNear ?? 80;
  }
  private current = 0;
  async allClaims() { return Array.from({ length: this.claims }, (_, i) => claimView(i, this.prices[0]!)); }
  async balance() { return BigInt(Math.round(this.balanceNear * 1e6)) * 10n ** 18n; }
  async evidenceFor(id: number) { return this.posted.map((p, i) => ({ ...p, id: i, claim_id: p.claimId, content_hash: p.hash, author: p.author ?? this.accountId }) as unknown as Evidence).filter((e) => e.claim_id === id); }
  async postEvidence(claimId: number, stance: string, _u: string, hash: string, note: string, deposit?: bigint) { this.posted.push({ claimId, stance, hash, note, deposit }); return this.posted.length - 1; }
  async quoteBuy() { return { out: String(NEAR), fee: "0", price_before_bps: 0, price_after_bps: 0 }; }
  async buy(claimId: number, side: string, deposit: bigint, _min: bigint, evidence: number | null) {
    this.buys.push({ claimId, side, deposit, evidence });
    if (this.failBuys > 0) { this.failBuys--; this.current = 1; throw new Error(SLIPPAGE); }
    return "1";
  }
  async claim(id: number) { return claimView(id, this.prices[this.current]!); }
}

const analyst = (chain: FakeChain, activity: MemoryActivity, locks?: ReviewLocks, judge = new OfflineJudge(), name = "A", persona: "researcher" | "skeptic" = "researcher") =>
  new Analyst({ name, persona, chain: chain as unknown as Chain, judge, sources: new StaticProvider([staticSource("Pluto", TEXT)]), activity, topics: ["pluto"], maxTradeNear: 1, recheckAfterMs: 0, reserveNear: 2, ...(locks ? { locks } : {}) });

test("a buy that fails on slippage is retried, and the evidence is posted only once", async () => {
  const chain = new FakeChain(5000, 1, 5000);
  const act = new MemoryActivity();
  assert.equal(await analyst(chain, act).cycle(), 1);
  assert.equal(chain.posted.length, 1);
  assert.equal(chain.buys.length, 2, "one failed attempt, one that landed");
  assert.deepEqual(chain.buys.map((b) => b.evidence), [0, 0], "both cite the evidence");
  assert.ok(act.items.some((a) => a.kind === "info" && /trying again/.test(a.text)));
});

test("if the price moved so far that the edge is gone, a small trade still backs the evidence, so its bond is not forfeited", async () => {
  const chain = new FakeChain(5000, 1, 9400);
  assert.equal(await analyst(chain, new MemoryActivity()).cycle(), 1);
  assert.equal(chain.buys.length, 2);
  assert.equal(chain.buys[1]!.deposit, 25n * 10n ** 21n, "0.025 NEAR, above the 0.02 bond");
  assert.equal(chain.buys[1]!.side, "Yes", "on the side the evidence argues for");
});

test("it gives up after three slippage failures, and says so instead of looping", async () => {
  const chain = new FakeChain(5000, 99, 5000);
  const act = new MemoryActivity();
  assert.equal(await analyst(chain, act).cycle(), 0);
  assert.equal(chain.buys.length, 3);
  assert.ok(act.items.some((a) => a.kind === "error" && /slippage/.test(a.text)));
});

test("two agents sharing locks never review the same claim at once, so the same source is not posted twice", async () => {
  const chain = new FakeChain(5000);
  const locks = new ReviewLocks();
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const slow = { name: "slow", judge: async (c: string, s: Parameters<OfflineJudge["judge"]>[1]) => { await gate; return new OfflineJudge().judge(c, s); } };
  const a = analyst(chain, new MemoryActivity(), locks, slow, "R", "researcher").cycle();
  const b = analyst(chain, new MemoryActivity(), locks, slow, "S", "skeptic").cycle();
  await new Promise((r) => setTimeout(r, 30));
  open();
  const [x, y] = await Promise.all([a, b]);
  assert.equal(x + y, 1, "one of them traded; the other left the claim alone");
  assert.equal(chain.posted.length, 1);
});

test("locks expire, can be taken back by their owner, and are released", () => {
  let now = 1000;
  const l = new ReviewLocks(100, () => now);
  assert.ok(l.tryAcquire(1, "a"));
  assert.ok(!l.tryAcquire(1, "b"));
  assert.ok(l.tryAcquire(1, "a"), "the owner may re-enter");
  now += 101;
  assert.ok(l.tryAcquire(1, "b"), "a lock whose owner vanished expires");
  l.release(1, "a");
  assert.ok(!l.tryAcquire(1, "a"), "only the owner releases");
  l.release(1, "b");
  assert.ok(l.tryAcquire(1, "a"));
});

test("stake sizing: Kelly capped, scaled by the reading's weight, never below the smallest trade or, citing evidence, the bond", () => {
  const base = { spendableNear: 70, kelly: 0.25, fraction: 0.5, maxTradeNear: 1.5 };
  assert.equal(sizeStake(base), 1.5);
  assert.equal(sizeStake({ ...base, weight: 0.35 }), 1.5 * 0.35);
  assert.equal(sizeStake({ ...base, spendableNear: 1, fraction: 0.01 }), 0.012, "the smallest trade");
  assert.equal(sizeStake({ ...base, spendableNear: 1, fraction: 0.01, cites: true }), 0.025, "enough to put the bond behind the evidence");
  assert.equal(sizeStake({ ...base, weight: 0 }), 0.012);
});

class FakeKeeperChain {
  settled: number[] = [];
  views = 0;
  constructor(public ev: Array<{ id: number; posted_ms: number; state: string }>, public cfg = { evidence: 0, bond_window_ms: 1000 }, public bal = 5n * NEAR, public settleError: string | null = null) { this.cfg.evidence = ev.length; }
  async config() { return this.cfg; }
  async evidencePage(from: number, limit = 100) { this.views++; return this.ev.slice(from, from + limit).map((e, i) => ({ id: from + i, claim_id: 7, posted_ms: e.posted_ms, bond_state: e.state }) as unknown as Evidence); }
  async evidence(id: number) { const e = this.ev[id]; return e ? ({ id, claim_id: 7, posted_ms: e.posted_ms, bond_state: e.state } as unknown as Evidence) : null; }
  async balance() { return this.bal; }
  async settleBond(id: number) { if (this.settleError) throw new Error(this.settleError); this.settled.push(id); this.ev[id]!.state = "Refunded"; return "Refunded"; }
}

test("the keeper settles only matured bonds, remembers when the others mature, and does not re-read them meanwhile", async () => {
  let now = 10_000;
  const chain = new FakeKeeperChain([{ id: 0, posted_ms: 0, state: "Open" }, { id: 1, posted_ms: 9_500, state: "Open" }, { id: 2, posted_ms: 0, state: "Refunded" }]);
  const act = new MemoryActivity();
  const k = new BondKeeper(chain as unknown as Chain, "keeper", act, () => now);
  assert.equal(await k.cycle(), 1);
  assert.deepEqual(chain.settled, [0]);
  const viewsAfterFirst = chain.views;
  assert.equal(await k.cycle(), 0);
  assert.equal(chain.views, viewsAfterFirst, "nothing new to scan and nothing ready, so no reads");
  now += 600;
  assert.equal(await k.cycle(), 1);
  assert.deepEqual(chain.settled, [0, 1]);
  assert.ok(act.items.filter((a) => a.kind === "settle").length === 2);
});

test("the keeper copes with 'already settled' and a chain clock a little behind, and reports a real failure once per attempt", async () => {
  const act = new MemoryActivity();
  const c1 = new FakeKeeperChain([{ id: 0, posted_ms: 0, state: "Open" }], undefined, undefined, "Smart contract panicked: bond already settled");
  const k1 = new BondKeeper(c1 as unknown as Chain, "k", act, () => 5_000);
  assert.equal(await k1.cycle(), 0);
  assert.equal(await k1.cycle(), 0);
  assert.equal(act.items.filter((a) => a.kind === "error").length, 0, "someone else got there first; that is fine, and it is dropped");
  const c2 = new FakeKeeperChain([{ id: 0, posted_ms: 0, state: "Open" }], undefined, undefined, "Smart contract panicked: bond window still open");
  const k2 = new BondKeeper(c2 as unknown as Chain, "k", act, () => 5_000);
  await k2.cycle();
  assert.equal(act.items.filter((a) => a.kind === "error").length, 0);
  const c3 = new FakeKeeperChain([{ id: 0, posted_ms: 0, state: "Open" }], undefined, undefined, "Smart contract panicked: something else");
  await new BondKeeper(c3 as unknown as Chain, "k", act, () => 5_000).cycle();
  assert.equal(act.items.filter((a) => a.kind === "error").length, 1);
});

test("a keeper that cannot pay for gas says so once and settles when funded", async () => {
  const chain = new FakeKeeperChain([{ id: 0, posted_ms: 0, state: "Open" }], undefined, 10n ** 22n);
  const act = new MemoryActivity();
  const k = new BondKeeper(chain as unknown as Chain, "k", act, () => 5_000);
  assert.equal(await k.cycle(), 0);
  assert.equal(await k.cycle(), 0);
  assert.equal(act.items.filter((a) => a.kind === "skip").length, 1, "said once, not on every pass");
  chain.bal = 5n * NEAR;
  assert.equal(await k.cycle(), 1);
});

test("a failed scan is retried from the same bond, not skipped", async () => {
  const chain = new FakeKeeperChain([{ id: 0, posted_ms: 0, state: "Open" }, { id: 1, posted_ms: 0, state: "Open" }]);
  let failNext = true;
  const real = chain.evidencePage.bind(chain);
  chain.evidencePage = async (from: number, limit = 100) => { if (failNext) { failNext = false; throw new Error("rpc"); } return real(from, limit); };
  const k = new BondKeeper(chain as unknown as Chain, "k", new MemoryActivity(), () => 5_000);
  await assert.rejects(k.cycle(), /rpc/);
  assert.equal(await k.cycle(), 2, "no bond was lost");
});

test("the keeper walks the evidence in pages of 100, not one call per piece", async () => {
  const ev = Array.from({ length: 250 }, (_, id) => ({ id, posted_ms: 0, state: id % 2 === 0 ? "Open" : "Refunded" }));
  const chain = new FakeKeeperChain(ev);
  const k = new BondKeeper(chain as unknown as Chain, "k", new MemoryActivity(), () => 5_000);
  assert.equal(await k.cycle(), 125);
  assert.equal(chain.views, 3, "three page reads for 250 pieces");
});

const gated = () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  return { open, judge: { name: "slow", judge: async (c: string, s: Parameters<OfflineJudge["judge"]>[1]) => { await gate; return new OfflineJudge().judge(c, s); } } };
};
const tick = () => new Promise((r) => setTimeout(r, 30));

test("with no locks passed, agents in one process still exclude each other; with separate locks they do not (the control)", async () => {
  const shared = new FakeChain(5000);
  const g1 = gated();
  const a = analyst(shared, new MemoryActivity(), undefined, g1.judge, "default-R", "researcher").cycle();
  const b = analyst(shared, new MemoryActivity(), undefined, g1.judge, "default-S", "skeptic").cycle();
  await tick(); g1.open();
  await Promise.all([a, b]);
  assert.equal(shared.posted.length, 1, "the default is one lock for the process, so only one agent posted");

  const control = new FakeChain(5000);
  const g2 = gated();
  const c = analyst(control, new MemoryActivity(), new ReviewLocks(), g2.judge, "sep-R", "researcher").cycle();
  const d = analyst(control, new MemoryActivity(), new ReviewLocks(), g2.judge, "sep-S", "skeptic").cycle();
  await tick(); g2.open();
  await Promise.all([c, d]);
  assert.equal(control.posted.length, 2, "without shared locks the same source is posted twice: this is the race the locks prevent");
});

test("a claim another agent holds costs a look at the next claim, not a place in the quota", async () => {
  const chain = new FakeChain(5000, 0, 5000, { claims: 4 });
  const locks = new ReviewLocks();
  for (const id of [0, 1, 2]) locks.tryAcquire(id, "someone-else");
  const act = new MemoryActivity();
  const a = new Analyst({ name: "Q", persona: "researcher", chain: chain as unknown as Chain, judge: new OfflineJudge(), sources: new StaticProvider([staticSource("Pluto", TEXT)]), activity: act, maxClaimsPerCycle: 1, maxTradeNear: 1, recheckAfterMs: 0, reserveNear: 2, locks });
  assert.equal(await a.cycle(), 1);
  assert.deepEqual(chain.posted.map((p) => p.claimId), [3]);
  assert.equal(act.items.filter((x) => x.kind === "skip" && /is reviewing it/.test(x.text)).length, 3, "it says why it passed over each, once");
  await a.cycle();
  assert.equal(act.items.filter((x) => x.kind === "skip" && /is reviewing it/.test(x.text)).length, 3, "and does not repeat itself on the next pass");
});

test("a lock that expired while the sources were being read is taken again before posting; if it was lost, nothing is posted", async () => {
  let now = 1_000;
  const locks = new ReviewLocks(100, () => now);
  const chain = new FakeChain(5000);
  const g = gated();
  const act = new MemoryActivity();
  const a = new Analyst({ name: "slowpoke", persona: "researcher", chain: chain as unknown as Chain, judge: g.judge, sources: new StaticProvider([staticSource("Pluto", TEXT)]), activity: act, maxTradeNear: 1, recheckAfterMs: 60_000, reserveNear: 2, locks });
  const first = a.cycle();
  await tick();
  now += 200;
  assert.ok(locks.tryAcquire(0, "thief"), "the lock expired, so another agent can take the claim");
  g.open();
  assert.equal(await first, 0);
  assert.equal(chain.posted.length, 0, "it noticed it had lost the claim and posted nothing");
  assert.ok(act.items.some((x) => /took it while I was reading/.test(x.text)));
  locks.release(0, "thief");
  assert.equal(await a.cycle(), 1, "the claim was not marked as checked, so it comes back at once");
  assert.equal(chain.posted.length, 1);
});

test("an agent that cannot afford both the evidence and the trade that backs it does not post the evidence", async () => {
  const poor = new FakeChain(5000, 0, 5000, { balanceNear: 2.04 });
  const act = new MemoryActivity();
  assert.equal(await analyst(poor, act).cycle(), 0);
  assert.equal(poor.posted.length, 0);
  assert.equal(poor.buys.length, 0);
  assert.ok(act.items.some((x) => /out of spendable balance/.test(x.text)));
  const ok = new FakeChain(5000, 0, 5000, { balanceNear: 2.2 });
  assert.equal(await analyst(ok, new MemoryActivity()).cycle(), 1);
});

test("locks that expired are swept, so the table does not grow without bound", () => {
  let now = 0;
  const l = new ReviewLocks(10, () => now);
  for (let i = 0; i < 300; i++) l.tryAcquire(i, "a");
  assert.equal(l.size, 300);
  now += 20;
  l.tryAcquire(999, "b");
  assert.equal(l.size, 1);
  assert.equal(l.holder(999), "b");
  assert.equal(l.holder(5), null);
});

test("the evidence deposit follows the contract: a fee, an eighth of it for each piece already there, and a bond", () => {
  assert.equal(evidenceDeposit(0), 3n * 10n ** 22n);
  assert.equal(evidenceDeposit(8), 4n * 10n ** 22n);
  assert.equal(evidenceDeposit(64), 11n * 10n ** 22n);
  assert.equal(evidenceDeposit(3), 10n ** 22n * 11n / 8n + 2n * 10n ** 22n);
});

test("on a claim that already has evidence, an agent pays the higher deposit the contract now asks for", async () => {
  const chain = new FakeChain(5000);
  for (let i = 0; i < 9; i++) chain.posted.push({ claimId: 0, stance: "Support", hash: `${i}`.repeat(64), note: "x", author: `other${i}.near` });
  assert.equal(await analyst(chain, new MemoryActivity()).cycle(), 1);
  const mine = chain.posted[chain.posted.length - 1]!;
  assert.equal(mine.deposit, evidenceDeposit(10), "one more than the nine it can see, in case another lands first");
  assert.ok(mine.deposit! > evidenceDeposit(9));
});

test("an agent that holds its quota of slots on a claim cites what is there instead of posting more", async () => {
  const chain = new FakeChain(5000);
  for (let i = 0; i < 8; i++) chain.posted.push({ claimId: 0, stance: "Support", hash: `${i}`.repeat(64), note: "x" });
  assert.equal(await analyst(chain, new MemoryActivity()).cycle(), 1);
  assert.equal(chain.posted.length, 8, "nothing new was posted");
  assert.equal(chain.buys[0]!.evidence, 0, "it cited the first support evidence on the claim");
  const none = new FakeChain(5000);
  for (let i = 0; i < 8; i++) none.posted.push({ claimId: 0, stance: "Refute", hash: `${i}`.repeat(64), note: "x" });
  const act = new MemoryActivity();
  assert.equal(await analyst(none, act).cycle(), 0);
  assert.ok(act.items.some((a) => /out of evidence slots/.test(a.text)));
});

test("claims in articles the analyst does not follow are not read or traded", async () => {
  const chain = new FakeChain(5000);
  const act = new MemoryActivity();
  const a = new Analyst({ name: "A", persona: "researcher", chain: chain as unknown as Chain, judge: new OfflineJudge(), sources: new StaticProvider([staticSource("Pluto", TEXT)]), activity: act, maxTradeNear: 1, recheckAfterMs: 0, reserveNear: 2, followed: async () => new Set(["somewhere-else"]) });
  assert.equal(await a.cycle(), 0);
  assert.ok(!act.items.some((x) => x.kind === "source"), "nothing was read");
});
