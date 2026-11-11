/**
 * One-command local demo: a real local NEAR node (near-sandbox), the real contract, a swarm of agents and the web UI.
 *
 *   npm run build:contract && npm run build && npm run demo
 *
 * No API key needed: the default mode reads real pinned Wikipedia revisions and uses a rule-based judge. Set
 * ANTHROPIC_API_KEY (or LLM_BASE_URL + LLM_API_KEY) to upgrade to a language-model judge. Set VERITY_MOCK=1 for
 * a fully offline run against a tiny static corpus, or run `npm run warm` once and set VERITY_CACHE_ONLY=1.
 */
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { Chain } from "../src/lib/chain.js";
import { Analyst } from "../src/agents/analyst.js";
import { Arbiter } from "../src/agents/arbiter.js";
import { FileActivity } from "../src/lib/activity.js";
import { sleep } from "../src/lib/log.js";
import { startServer, type AgentInfo } from "../src/server.js";
import { applySeeds, loadSeedDir, restrictSeeds, type SeedFile } from "../src/demo/seeds.js";
import { gatherSources } from "../src/agents/analyst.js";

// `--offline` answers from the on-disk cache alone (after `npm run warm`); the same as VERITY_CACHE_ONLY=1, on any shell.
if (process.argv.includes("--offline")) process.env.VERITY_CACHE_ONLY = "1";

// makeBrain() handles the three modes: LLM key → real judge, no key → rule-based judge + real Wikipedia,
// VERITY_MOCK=1 → static corpus.
const { makeBrain } = await import("../src/lib/brain.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const NEAR = 10n ** 24n;
const CLAIM_FEE = 70n * 10n ** 21n;
const PORT = Number(process.env.PORT ?? 8787);

// near-sandbox caches its node binary here (and its ESM build needs the variable set). Reuse a sibling checkout's
// cache when there is one so a first run does not download it again.
if (!process.env.DIR_TO_DOWNLOAD_BINARY) {
  const sibling = path.join(root, "../1Hundo-near/.sandbox-bin");
  process.env.DIR_TO_DOWNLOAD_BINARY = existsSync(sibling) ? sibling : path.join(root, ".sandbox-bin");
}
const dataDir = path.join(root, "data/demo");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const activityFile = path.join(dataDir, "activity.jsonl");

const brain = makeBrain();
console.log(`judge: ${brain.judgeLabel}\nsources: ${brain.sourcesLabel}`);

// In the offline mock the only documents are the Pluto ones; every other article would sit at 50%.
const seedFiles: SeedFile[] = process.env.VERITY_MOCK === "1"
  ? restrictSeeds(loadSeedDir(path.join(root, "seed")), ["pluto"])
  : loadSeedDir(path.join(root, "seed"));

// Offline, a claim whose search is not in the cache gets "no sources" and the agents just sit on it. Say which ones, up front,
// instead of leaving the demo to look broken (the cure is `VERITY_CACHE_DIR=seed-cache npm run warm`, then keep the result).
if (process.env.VERITY_CACHE_ONLY === "1" && process.env.VERITY_MOCK !== "1") {
  const missing: string[] = [];
  for (const f of seedFiles) for (const text of [...f.claims.map((c) => c.text), ...(f.lies ?? []).map((l) => l.text), ...(f.adds ?? []).map((a) => a.text)]) {
    if ((await gatherSources(brain.sources, text, 4)).length === 0) missing.push(text);
  }
  if (missing.length) console.warn(`[verity] the cache has no pages for ${missing.length} of the seed claims and lies, so the agents will find no sources for them:\n${missing.map((t) => `  - ${t}`).join("\n")}\nRun \`npm run warm\` online (VERITY_CACHE_DIR=seed-cache npm run warm to update the copy in the repository).`);
}

const sandbox = await Sandbox.start({});
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 4000).unref();
  await sandbox.tearDown().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const rpc = sandbox.rpcUrl;
const rootAccount = new Account(DEFAULT_ACCOUNT_ID, rpc, DEFAULT_PRIVATE_KEY as `ed25519:${string}`);
const keys = new Map<string, string>();
async function mk(name: string, near: bigint): Promise<string> {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
  await rootAccount.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: near });
  keys.set(id, kp.toString());
  return id;
}
// No agent ever sells, so each lie it corrects leaves a few NEAR in a position; this is what lets a demo be replayed dozens of times.
const FUND = 200n;
const ids = {
  verity: await mk("verity", 40n * NEAR), editor: await mk("editor", 200n * NEAR),
  researchA: await mk("researcher-a", FUND * NEAR), skepticA: await mk("skeptic-a", FUND * NEAR),
  researchB: await mk("researcher-b", FUND * NEAR), skepticB: await mk("skeptic-b", FUND * NEAR),
  arbiter: await mk("arbiter", FUND * NEAR), you: await mk("you", 400n * NEAR),
};
const chain = (id: string) => new Chain(id, keys.get(id), ids.verity, rpc);

await new Account(ids.verity, rpc, keys.get(ids.verity) as `ed25519:${string}`).deployContract(readFileSync(path.join(root, "contracts/verity/res/verity.wasm")));
await chain(ids.verity).call("new", { bond_window_secs: 60, fee_bps: 100 });

const seeded = await applySeeds(chain(ids.editor), seedFiles, { claimFee: CLAIM_FEE, seedDeposit: 3n * NEAR, linkDeposit: 1n * NEAR });
console.log(`seeded ${seedFiles.length} articles, ${[...seedFiles].reduce((n, f) => n + f.claims.length, 0)} claims, ${seeded.linkClaims.length} link markets at 50%`);

// Two squads, each a researcher and a skeptic working their own articles; one arbiter watches every contradiction.
const articles = seedFiles.map((f) => f.topic);
const squadA = articles.filter((_, i) => i % 2 === 0);
const squadB = articles.filter((_, i) => i % 2 === 1);

const activity = new FileActivity(activityFile);
const shared = { judge: brain.judge, sources: brain.sources, activity, maxTradeNear: 1.5, maxClaimsPerCycle: 6, sourcesPerClaim: 4, recheckAfterMs: 90_000, reserveNear: 5 };
const roster: Array<{ info: AgentInfo; run: { cycle(): Promise<number> } }> = [
  { info: { name: "Researcher A", role: "researcher", accountId: ids.researchA, squad: "A", startNear: Number(FUND) }, run: new Analyst({ name: "Researcher A", persona: "researcher", chain: chain(ids.researchA), topics: squadA, ...shared }) },
  { info: { name: "Skeptic A", role: "skeptic", accountId: ids.skepticA, squad: "A", startNear: Number(FUND) }, run: new Analyst({ name: "Skeptic A", persona: "skeptic", chain: chain(ids.skepticA), topics: squadA, ...shared }) },
  { info: { name: "Researcher B", role: "researcher", accountId: ids.researchB, squad: "B", startNear: Number(FUND) }, run: new Analyst({ name: "Researcher B", persona: "researcher", chain: chain(ids.researchB), topics: squadB, ...shared }) },
  { info: { name: "Skeptic B", role: "skeptic", accountId: ids.skepticB, squad: "B", startNear: Number(FUND) }, run: new Analyst({ name: "Skeptic B", persona: "skeptic", chain: chain(ids.skepticB), topics: squadB, ...shared }) },
  { info: { name: "Arbiter", role: "arbiter", accountId: ids.arbiter, startNear: Number(FUND) }, run: new Arbiter({ name: "Arbiter", chain: chain(ids.arbiter), activity, maxLegNear: 0.8, reserveNear: 5, cooldownMs: 15_000, followed: async () => new Set(articles) }) },
];

startServer({
  port: PORT, network: "local sandbox", contractId: ids.verity, rpcUrl: rpc, activityFile, dataDir, llm: brain.llm,
  judgeLabel: brain.judgeLabel, sourcesLabel: brain.sourcesLabel, mockCorpus: process.env.VERITY_MOCK === "1", demo: { accountId: ids.you, privateKey: keys.get(ids.you)! }, pollMs: 2000,
  agents: roster.map((r) => r.info), lies: seeded.lies,
});
console.log(`\nVerity demo is live:  http://localhost:${PORT}\n(Ctrl+C stops the chain.)\n`);
if (process.env.VERITY_MOCK !== "1" && process.env.VERITY_CACHE_ONLY !== "1") console.log("First run reads Wikipedia slowly (it limits anonymous clients). `npm run warm` once makes every later run instant.\n");

// Each agent runs on its own clock, so a slow Wikipedia fetch in one squad does not stall the other.
const every = Number(process.env.AGENT_INTERVAL_MS ?? 6000);
await Promise.all(roster.map(async ({ info, run }, i) => {
  await sleep(i * 700);
  while (!stopping) {
    try { await run.cycle(); } catch (e) { activity.emit({ agent: info.name, kind: "error", text: e instanceof Error ? e.message.split("\n")[0]! : String(e) }); }
    await sleep(every);
  }
}));
