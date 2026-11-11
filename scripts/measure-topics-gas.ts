/**
 * Measures `get_topics`, which returns every topic ever opened. Anyone can open one for 0.57 NEAR (0.07 of it sunk), and the
 * server and the agents both call it, so its cost as the list grows is what bounds how much spam could blind them.
 *
 *   npm run build && TOPICS=600 node dist/scripts/measure-topics-gas.js
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { Chain } from "../src/lib/chain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
if (!process.env.DIR_TO_DOWNLOAD_BINARY) {
  const sibling = path.join(root, "../1Hundo-near/.sandbox-bin");
  process.env.DIR_TO_DOWNLOAD_BINARY = existsSync(sibling) ? sibling : path.join(root, ".sandbox-bin");
}
const NEAR = 10n ** 24n;
const TOTAL = Number(process.env.TOPICS ?? 600);
const STEP = Number(process.env.STEP ?? 150);
const WORKERS = 8;
// PAGED=1 measures the last page of 200 (what the clients now ask for) instead of the whole list.
const PAGED = process.env.PAGED === "1";

const sandbox = await Sandbox.start({});
try {
  const rpc = sandbox.rpcUrl;
  const rootAcc = new Account(DEFAULT_ACCOUNT_ID, rpc, DEFAULT_PRIVATE_KEY as `ed25519:${string}`);
  const keys = new Map<string, string>();
  const mk = async (name: string, near: bigint) => {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
    await rootAcc.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: near });
    keys.set(id, kp.toString());
    return id;
  };
  const verity = await mk("verity", 40n * NEAR);
  await new Account(verity, rpc, keys.get(verity) as `ed25519:${string}`).deployContract(readFileSync(path.join(root, "contracts/verity/res/verity.wasm")));
  const as = (id: string) => new Chain(id, keys.get(id), verity, rpc);
  await as(verity).call("new", { bond_window_secs: 60, fee_bps: 100 });
  const workers: string[] = [];
  const fund = BigInt(Math.ceil((TOTAL / WORKERS) * 0.6 + 20)) * NEAR;
  for (let i = 0; i < WORKERS; i++) workers.push(await mk(`w${i}`, fund));
  const who = workers[0]!;
  let made = 0;
  const measure = async () => {
    const r = (await new Account(who, rpc, keys.get(who) as `ed25519:${string}`).callFunctionRaw({ contractId: verity, methodName: "get_topics", args: PAGED ? { from_index: Math.max(0, made - 200), limit: 200 } : {}, deposit: 0n, gas: 300n * 10n ** 12n })) as unknown as {
      status?: { Failure?: unknown }; transaction_outcome: { outcome: { gas_burnt: number } }; receipts_outcome: Array<{ outcome: { gas_burnt: number } }>;
    };
    return { tgas: (Number(r.transaction_outcome.outcome.gas_burnt) + r.receipts_outcome.reduce((s, x) => s + Number(x.outcome.gas_burnt), 0)) / 1e12, failed: !!r.status?.Failure };
  };
  const pts: Array<[number, number]> = [];
  while (made < TOTAL) {
    const upTo = Math.min(TOTAL, made + STEP);
    await Promise.all(workers.map(async (w, k) => {
      for (let n = made + k; n < upTo; n += WORKERS) await as(w).createClaim(`topic-spam-${n}`, `Spam claim number ${n} under its own topic.`, 5000, 70n * 10n ** 21n + NEAR / 2n);
    }));
    made = upTo;
    const m = await measure();
    pts.push([made, m.tgas]);
    console.log(`${made} topics: get_topics ${m.tgas.toFixed(1)} Tgas${m.failed ? "  FAILED" : ""}`);
  }
  const [n0, g0] = pts[0]!;
  const [n1, g1] = pts[pts.length - 1]!;
  const per = (g1 - g0) / (n1 - n0);
  console.log(`about ${per.toFixed(3)} Tgas per topic; 200 Tgas is reached at about ${Math.round(n1 + (200 - g1) / per)} topics`);
} finally {
  await sandbox.tearDown().catch(() => {});
}
process.exit(0);
