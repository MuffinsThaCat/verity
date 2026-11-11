/**
 * Opens the claims in the seed files as markets.
 *
 *   npm run seed                      # every file in seed/
 *   npm run seed seed/pluto.json      # just these (cross-file links need their targets in the same run)
 *
 * Refuses to run on a contract that already has claims (a second run would open every claim again); `npm run seed -- --force` overrides (the `--` matters: without it npm keeps the flag for itself and the script never sees it).
 * Uses EDITOR_ACCOUNT_ID / EDITOR_PRIVATE_KEY. `SEED_NEAR` is the pool depth per claim (default 1): a deeper pool is
 * harder to push around, which is the whole security budget of a perpetual market.
 */
import { Chain } from "../src/lib/chain.js";
import { creds, RPC_URL, requireContract } from "../src/lib/config.js";
import { YOCTO_PER_NEAR } from "../src/lib/units.js";
import { applySeeds, loadSeedDir, loadSeedFiles, seedCost, validateSeeds } from "../src/demo/seeds.js";

const force = process.argv.includes("--force");
const args = process.argv.slice(2).filter((a) => a !== "--force");
const files = args.length ? loadSeedFiles(args) : loadSeedDir("seed");
const c = creds("EDITOR");
const chain = new Chain(c.accountId, c.privateKey, requireContract(), RPC_URL);
const near = (n: number) => BigInt(Math.round(n * 1e6)) * (YOCTO_PER_NEAR / 1_000_000n);
const seed = Number(process.env.SEED_NEAR ?? 1);

const money = { claimFee: near(0.07), seedDeposit: near(seed), linkDeposit: near(Math.max(seed, 0.5)) };
validateSeeds(files);
const existing = (await chain.config()).claims;
if (existing > 0 && !force) throw new Error(`${requireContract()} already has ${existing} claims. Seeding again would open every claim a second time; run: npm run seed -- --force   if that is what you want.`);
// Seeding is not atomic, so find out first whether the editor can pay for all of it (gas needs a little extra).
const need = seedCost(files, money) + near(1);
const have = await chain.balance();
if (have < need) {
  const n = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(2);
  throw new Error(`${c.accountId} has ${n(have)} NEAR but seeding needs about ${n(need)}. Fund it, or lower SEED_NEAR (now ${seed}), or seed fewer files.`);
}
const seeded = await applySeeds(chain, files, { ...money, log: (l) => console.log(l) });
console.log(`\n${files.reduce((n, f) => n + f.claims.length, 0)} claims, ${seeded.linkClaims.length} link markets, ${seeded.lies.length} demo lies available`);
