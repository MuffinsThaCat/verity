import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter } from "../src/agents/arbiter.js";
import { MemoryActivity } from "../src/lib/activity.js";
import type { Chain } from "../src/lib/chain.js";
import type { Violation } from "../src/lib/types.js";

const NEAR = 10n ** 24n;
const SLIPPAGE = "Smart contract panicked: slippage: fewer shares than min_shares";
const violation: Violation = { link_id: 0, link_claim: 9, rel: "Excludes", a: 1, b: 2, price_a_bps: 8000, price_b_bps: 9000, link_conf_bps: 9000, gap_bps: 7000, score: 6300 };

class FakeChain {
  accountId = "arb.near";
  buys: Array<{ claimId: number; side: string }> = [];
  constructor(private failures: number, private pricesAfterFailure: [number, number] = [8000, 9000]) {}
  private failed = false;
  async violations() { return [violation]; }
  async balance() { return 80n * NEAR; }
  async quoteBuy() { return { out: String(NEAR), fee: "0", price_before_bps: 0, price_after_bps: 0 }; }
  async buy(claimId: number, side: string) {
    this.buys.push({ claimId, side });
    if (this.failures > 0) { this.failures--; this.failed = true; throw new Error(SLIPPAGE); }
    return "1";
  }
  async claim(id: number) { return { id, topic: id === 1 ? "pluto/moons" : "junk", price_bps: this.failed ? this.pricesAfterFailure[id - 1]! : id === 1 ? 8000 : 9000 }; }
}
const arbiter = (chain: FakeChain, act: MemoryActivity) => new Arbiter({ name: "arb", chain: chain as unknown as Chain, activity: act, cooldownMs: 0, settleBonds: false, reserveNear: 2 });

test("an arbiter trade refused on slippage is retried while the contradiction still stands", async () => {
  const chain = new FakeChain(1);
  const act = new MemoryActivity();
  assert.equal(await arbiter(chain, act).cycle(), 2, "both legs landed");
  assert.equal(chain.buys.length, 3, "one refusal, then both legs");
  assert.ok(act.items.some((a) => /trying again/.test(a.text)));
  assert.ok(!act.items.some((a) => a.kind === "error"));
});

test("if another agent has already closed the contradiction, the arbiter leaves it instead of piling on", async () => {
  const chain = new FakeChain(1, [3000, 5000]);
  const act = new MemoryActivity();
  assert.equal(await arbiter(chain, act).cycle(), 0);
  assert.equal(chain.buys.length, 1, "no second attempt");
  assert.ok(act.items.some((a) => /contradiction is gone/.test(a.text)));
});

test("it gives up after three refusals and reports the error", async () => {
  const chain = new FakeChain(99);
  const act = new MemoryActivity();
  assert.equal(await arbiter(chain, act).cycle(), 0);
  assert.equal(chain.buys.length, 3);
  assert.ok(act.items.some((a) => a.kind === "error" && /slippage/.test(a.text)));
});

test("a link that touches an article the arbiter does not follow is left alone, so spam links cannot spend its money", async () => {
  const chain = new FakeChain(0);
  const act = new MemoryActivity();
  const a = new Arbiter({ name: "arb", chain: chain as unknown as Chain, activity: act, cooldownMs: 0, settleBonds: false, reserveNear: 2, followed: async () => new Set(["pluto"]) });
  assert.equal(await a.cycle(), 0);
  assert.equal(chain.buys.length, 0, "claim 2 is in the junk article");
  const both = new Arbiter({ name: "arb", chain: new FakeChain(0) as unknown as Chain, activity: new MemoryActivity(), cooldownMs: 0, settleBonds: false, reserveNear: 2, followed: async () => new Set(["pluto", "junk"]) });
  assert.equal(await both.cycle(), 2, "with both articles followed it trades as before");
});
