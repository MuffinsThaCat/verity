/**
 * Measures what `get_violations` costs in gas on a real (sandbox) node, with claims at their largest (a full 48-trade tape
 * written by accounts with long names), and extrapolates to a scan of MAX_VIOLATION_SCAN links. A view call is limited to
 * 200 Tgas by the nodes that serve it.
 *
 *   npm run build && node dist/scripts/measure-scan-gas.js
 *
 * It sends `get_violations` as a transaction, because only a transaction reports the gas it burned.
 *
 * Two shapes. By default CLAIMS claims are linked in every pair, so each claim is read again and again (the cheaper case:
 * repeated reads inside one call are cheaper than first reads). With DISTINCT_LINKS=N, 2N claims are linked in N separate
 * pairs, so every link reads three claims that nothing else in the scan reads: the case a real 200-link scan can be.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { Chain } from "../src/lib/chain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
// Reuse a sibling checkout's node binary when there is one, as the demo does; otherwise near-sandbox fetches its own.
if (!process.env.DIR_TO_DOWNLOAD_BINARY) {
  const sibling = path.join(root, "../1Hundo-near/.sandbox-bin");
  process.env.DIR_TO_DOWNLOAD_BINARY = existsSync(sibling) ? sibling : path.join(root, ".sandbox-bin");
}
const NEAR = 10n ** 24n;
const DISTINCT = Number(process.env.DISTINCT_LINKS ?? 0);
const CLAIMS = DISTINCT > 0 ? 2 * DISTINCT : Number(process.env.CLAIMS ?? 14);
const SCAN_CAP = Number(process.env.SCAN_CAP ?? 200);

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
  const editor = await mk("editor", 400n * NEAR);
  await new Account(verity, rpc, keys.get(verity) as `ed25519:${string}`).deployContract(readFileSync(path.join(root, "contracts/verity/res/verity.wasm")));
  const as = (id: string) => new Chain(id, keys.get(id), verity, rpc);
  await as(verity).call("new", { bond_window_secs: 60, fee_bps: 100 });

  // Account names as long as the contract lets them be, so each tape record is as big as it gets.
  const traders: string[] = [];
  for (let i = 0; i < 6; i++) traders.push(await mk(`${"t".repeat(40)}${i}`, 150n * NEAR));
  const longest = traders[0]!.length;

  const ed = as(editor);
  const ids: number[] = [];
  for (let i = 0; i < CLAIMS; i++) ids.push(Number(await ed.createClaim(`m${i}`, `Measurement claim number ${i} for the scan.`, 8000, 70n * 10n ** 21n + 2n * NEAR)));
  // Each trader works its own claims, so six run at once (one account's transactions must be in order, different accounts' need not be).
  await Promise.all(traders.map(async (t, k) => {
    const mine = ids.filter((_, i) => i % traders.length === k);
    for (let round = 0; round < 48; round++) for (const id of mine) await as(t).buy(id, round % 2 === 0 ? "Yes" : "No", NEAR / 10n);
  }));
  const tape = (await ed.claim(ids[0]!))!.tape.length;

  const gasOf = async () => {
    const r = await new Account(editor, rpc, keys.get(editor) as `ed25519:${string}`).callFunctionRaw({ contractId: verity, methodName: "get_violations", args: { min_link_conf_bps: 0, min_gap_bps: 1, limit: 50 }, deposit: 0n, gas: 300n * 10n ** 12n });
    const o = r as unknown as { transaction_outcome: { outcome: { gas_burnt: number } }; receipts_outcome: Array<{ outcome: { gas_burnt: number } }> };
    return BigInt(o.transaction_outcome.outcome.gas_burnt) + o.receipts_outcome.reduce((s, x) => s + BigInt(x.outcome.gas_burnt), 0n);
  };
  const g0 = await gasOf();
  let links = 0;
  const link = async (i: number, j: number) => { await ed.createLink(ids[i]!, ids[j]!, "Excludes", 9000, 70n * 10n ** 21n + NEAR); links++; };
  if (DISTINCT > 0) for (let k = 0; k < DISTINCT; k++) await link(2 * k, 2 * k + 1);
  else for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) await link(i, j);
  const g1 = await gasOf();
  const T = 10n ** 12n;
  const per = (g1 - g0) / BigInt(links);
  console.log(`${DISTINCT > 0 ? `${links} links over ${CLAIMS} distinct claims` : `${links} links over ${CLAIMS} claims linked in every pair`}; claims with ${tape}-trade tapes by accounts named ${longest} characters long`);
  console.log(`get_violations over 0 links: ${Number(g0 / T)} Tgas; over ${links} links: ${Number(g1 / T)} Tgas`);
  console.log(`per link scanned: ${(Number(per) / 1e12).toFixed(3)} Tgas -> a scan of ${SCAN_CAP} links: about ${Number(g0 / T) + Math.round((Number(per) * SCAN_CAP) / 1e12)} Tgas (a view call may use 200)`);
} finally {
  await sandbox.tearDown().catch(() => {});
}
// The sandbox's child process can keep this one alive after the result is printed.
process.exit(0);
