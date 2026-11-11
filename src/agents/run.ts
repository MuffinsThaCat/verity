import { Chain } from "../lib/chain.js";
import { creds, NETWORK, RPC_URL, requireContract } from "../lib/config.js";
import { FileActivity } from "../lib/activity.js";
import { makeBrain } from "../lib/brain.js";
import { redactSecrets, sleep } from "../lib/log.js";
import { Analyst } from "./analyst.js";
import { Arbiter } from "./arbiter.js";
import { createScope } from "../lib/scope.js";

/**
 * Runs the three agent roles in one process, each with its own NEAR account:
 *   RESEARCHER_ACCOUNT_ID / RESEARCHER_PRIVATE_KEY, SKEPTIC_*, ARBITER_*
 * `AGENT_TOPICS=a,b` limits them to some topics. `AGENT_INTERVAL_MS` sets the pause between passes.
 */
export async function runAgents(opts: { stopped?: () => boolean } = {}) {
  const contract = requireContract();
  const brain = makeBrain();
  const activity = new FileActivity(process.env.ACTIVITY_LOG ?? "data/activity.jsonl");
  const topics = process.env.AGENT_TOPICS?.split(",").map((s) => s.trim()).filter(Boolean);
  const mk = (p: string) => { const c = creds(p); return new Chain(c.accountId, c.privateKey, contract, RPC_URL); };
  const maxTradeNear = Number(process.env.AGENT_MAX_TRADE_NEAR ?? 1);
  // The same articles the server shows: spam articles are not worth an agent's money (VERITY_ARTICLES / VERITY_MAX_ARTICLES).
  const scope = createScope(mk("ARBITER"), process.env.VERITY_ARTICLES?.split(",").map((s) => s.trim()).filter(Boolean), Number(process.env.VERITY_MAX_ARTICLES ?? 24));

  const agents = [
    new Analyst({ name: "Researcher", persona: "researcher", chain: mk("RESEARCHER"), judge: brain.judge, sources: brain.sources, activity, topics, maxTradeNear, followed: scope.followed, claims: scope.claims }),
    new Analyst({ name: "Skeptic", persona: "skeptic", chain: mk("SKEPTIC"), judge: brain.judge, sources: brain.sources, activity, topics, maxTradeNear, followed: scope.followed, claims: scope.claims }),
    new Arbiter({ name: "Arbiter", chain: mk("ARBITER"), activity, maxLegNear: maxTradeNear / 2, followed: scope.followed }),
  ];
  activity.emit({ agent: "runner", kind: "info", text: `agents up on ${NETWORK}: ${brain.judgeLabel}; sources: ${brain.sourcesLabel}` });
  const every = Number(process.env.AGENT_INTERVAL_MS ?? 15_000);
  // Each agent on its own clock: a slow Wikipedia read in an analyst's pass must not hold up the arbiter or the bond settling.
  await Promise.all(agents.map(async (a, i) => {
    await sleep(i * 700);
    while (!opts.stopped?.()) {
      try { await a.cycle(); } catch (e) { activity.emit({ agent: a.name, kind: "error", text: e instanceof Error ? e.message.split("\n")[0]! : String(e) }); }
      await sleep(every);
    }
  }));
}

if (process.argv[1]?.endsWith("agents/run.js")) {
  runAgents().catch((e) => { console.error(redactSecrets(e instanceof Error ? e.message : String(e))); process.exit(1); });
}
