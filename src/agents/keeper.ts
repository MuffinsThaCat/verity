import type { Chain } from "../lib/chain.js";
import type { ActivitySink } from "../lib/activity.js";

/**
 * Settles evidence bonds once their window has passed. `settle_bond` can be called by anyone: it refunds the bond if the
 * capital behind trades citing the evidence reached the bond, and otherwise moves it to the claim's fee pool. Nothing
 * in the contract does it by itself, so without a keeper every bond stays "Open" forever and the agents' bonds stay locked.
 */
export class BondKeeper {
  private next = 0;
  /** Open bonds not yet settled, with the time (ms) from which each can be. Avoids re-reading a bond that cannot mature yet. */
  private readonly open = new Map<number, number>();
  private lowOnFunds = false;

  constructor(
    private readonly chain: Chain,
    private readonly name: string,
    private readonly activity: ActivitySink,
    private readonly now: () => number = Date.now,
    /** Settling costs the keeper gas and pays it nothing, so it stops, once and out loud, when its balance runs low. */
    private readonly minBalanceNear = 0.1,
  ) {}

  /** Returns the number of bonds settled this pass. */
  async cycle(): Promise<number> {
    const cfg = await this.chain.config();
    // In pages, so a restart on a contract with thousands of pieces of evidence costs dozens of calls, not thousands.
    while (this.next < cfg.evidence) {
      const page = await this.chain.evidencePage(this.next, 100);
      if (page.length === 0) break;
      for (const e of page) if (e.bond_state === "Open") this.open.set(e.id, e.posted_ms + cfg.bond_window_ms);
      this.next += page.length;
    }
    const ready = [...this.open].filter(([, readyAt]) => this.now() >= readyAt);
    if (ready.length === 0) return 0;
    if ((await this.chain.balance()) < BigInt(Math.round(this.minBalanceNear * 1e6)) * 10n ** 18n) {
      if (!this.lowOnFunds) this.activity.emit({ agent: this.name, kind: "skip", text: `${ready.length} bond(s) are ready to settle, but this account is below ${this.minBalanceNear} NEAR; waiting for funds` });
      this.lowOnFunds = true;
      return 0;
    }
    this.lowOnFunds = false;
    let settled = 0;
    for (const [id] of ready) {
      try {
        const claimId = (await this.chain.evidence(id))?.claim_id;
        const state = await this.chain.settleBond(id);
        this.open.delete(id);
        settled++;
        this.activity.emit({ agent: this.name, kind: "settle", claimId, text: `${claimId !== undefined ? `claim #${claimId}: ` : ""}settled evidence #${id}, bond ${String(state).toLowerCase()}`, data: { evidenceId: id, state } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/already settled/.test(msg)) this.open.delete(id);
        else if (/window still open/.test(msg)) this.open.set(id, this.now() + 5_000); // the chain's clock is a little behind ours
        else this.activity.emit({ agent: this.name, kind: "error", text: `settling evidence #${id}: ${msg.split("\n")[0]}` });
      }
    }
    return settled;
  }
}
