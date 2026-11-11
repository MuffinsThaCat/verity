/**
 * Measures the gas of the calls the agents and the server make all the time, with the contract's limits filled: a page of
 * 50 full claims, a topic of 60, a claim with 64 pieces of evidence, a post on a claim with 63 and with 64 (the full case
 * that replaces forfeited evidence), and a link on a claim that already has 63. A view call may use 200 Tgas; the agents'
 * transactions are sent with 80.
 *
 *   npm run build && node dist/scripts/measure-call-gas.js
 *
 * Views are sent as transactions, because only a transaction reports the gas it burned. About ten minutes.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { Chain } from "../src/lib/chain.js";
import { evidenceDeposit } from "../src/agents/analyst.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
if (!process.env.DIR_TO_DOWNLOAD_BINARY) {
  const sibling = path.join(root, "../1Hundo-near/.sandbox-bin");
  process.env.DIR_TO_DOWNLOAD_BINARY = existsSync(sibling) ? sibling : path.join(root, ".sandbox-bin");
}
const NEAR = 10n ** 24n;
const T = 10n ** 12n;
const CLAIM_FEE = 70n * 10n ** 21n;

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
  const editor = await mk("editor", 900n * NEAR);
  await new Account(verity, rpc, keys.get(verity) as `ed25519:${string}`).deployContract(readFileSync(path.join(root, "contracts/verity/res/verity.wasm")));
  const as = (id: string) => new Chain(id, keys.get(id), verity, rpc);
  const acct = (id: string) => new Account(id, rpc, keys.get(id) as `ed25519:${string}`);
  await as(verity).call("new", { bond_window_secs: 60, fee_bps: 100 });
  const ed = as(editor);

  const gas = async (who: string, method: string, args: Record<string, unknown>, deposit = 0n) => {
    try {
      const r = (await acct(who).callFunctionRaw({ contractId: verity, methodName: method, args, deposit, gas: 300n * T })) as unknown as {
        status?: { Failure?: unknown }; transaction_outcome: { outcome: { gas_burnt: number } }; receipts_outcome: Array<{ outcome: { gas_burnt: number } }>;
      };
      const burnt = BigInt(r.transaction_outcome.outcome.gas_burnt) + r.receipts_outcome.reduce((s, x) => s + BigInt(x.outcome.gas_burnt), 0n);
      return { tgas: Number(burnt) / 1e12, failed: r.status?.Failure ? JSON.stringify(r.status.Failure).slice(0, 120) : null };
    } catch (e) { return { tgas: NaN, failed: e instanceof Error ? e.message.split("\n")[0]! : String(e) }; }
  };
  const rows: Array<[string, { tgas: number; failed: string | null }, string]> = [];
  const note = async (label: string, budget: string, p: Promise<{ tgas: number; failed: string | null }>) => {
    const r = await p;
    rows.push([label, r, budget]);
    console.log(`${r.failed ? "FAILED " : ""}${label}: ${Number.isNaN(r.tgas) ? "n/a" : r.tgas.toFixed(1)} Tgas (budget ${budget})${r.failed ? `  ${r.failed}` : ""}`);
  };

  // 60 claims in one topic, each with a full 48-trade tape written by accounts with long names.
  const traders: string[] = [];
  for (let i = 0; i < 6; i++) traders.push(await mk(`${"t".repeat(40)}${i}`, 200n * NEAR));
  const ids: number[] = [];
  for (let i = 0; i < 60; i++) ids.push(Number(await ed.createClaim("big", `Measurement claim number ${i} in the big topic.`, 8000, CLAIM_FEE + 2n * NEAR)));
  await Promise.all(traders.map(async (t, k) => {
    const mine = ids.filter((_, i) => i % traders.length === k);
    for (let round = 0; round < 48; round++) for (const id of mine) await as(t).buy(id, round % 2 === 0 ? "Yes" : "No", NEAR / 10n);
  }));
  console.log(`60 claims with ${(await ed.claim(ids[0]!))!.tape.length}-trade tapes written`);
  await note("get_claims, a page of 50 full claims", "view 200", gas(editor, "get_claims", { from_index: 0, limit: 50 }));
  await note("get_claims_by_topic, 60 full claims", "view 200", gas(editor, "get_claims_by_topic", { topic: "big" }));

  // A claim with 64 pieces of evidence from 9 authors (a claim holds 8 pieces per author).
  const authors: string[] = [];
  for (let i = 0; i < 10; i++) authors.push(await mk(`author${i}`, 60n * NEAR));
  const hub = Number(await ed.createClaim("hub", "The claim that collects as much evidence as it can hold.", 5000, CLAIM_FEE + 2n * NEAR));
  const post = (who: string, count: number, n: number) => ({ who, method: "post_evidence", args: { claim_id: hub, stance: "Support", uri: `https://en.wikipedia.org/w/index.php?title=T${n}&oldid=${n + 1}&action=raw`, content_hash: "ab".repeat(32), note: `"a quotation of some length number ${n}"` }, deposit: evidenceDeposit(count) });
  for (let i = 0; i < 62; i++) { const p = post(authors[i % 9]!, i, i); await as(p.who).postEvidence(hub, "Support", p.args.uri, p.args.content_hash, p.args.note, p.deposit); }
  { const p = post(authors[8]!, 62, 62); await note("post_evidence as the 63rd piece", "tx 80", gas(p.who, p.method, p.args, p.deposit)); }
  { const p = post(authors[0]!, 63, 63); await note("post_evidence as the 64th piece", "tx 80", gas(p.who, p.method, p.args, p.deposit)); }
  const count = (await ed.claim(hub))!.evidence.length;
  console.log(`hub claim now holds ${count} pieces`);
  await note("get_claim_evidence, 64 pieces", "view 200", gas(editor, "get_claim_evidence", { claim_id: hub }));

  // Full claim: wait out the bond window, forfeit one unbacked piece, then post a replacement.
  await new Promise((r) => setTimeout(r, 65_000));
  await as(editor).settleBond(0);
  { const p = post(authors[9]!, 64, 64); await note("post_evidence on a full claim (replaces a forfeited piece)", "tx 80", gas(p.who, p.method, p.args, p.deposit)); }

  // A claim with 63 links.
  const pivot = Number(await ed.createClaim("pivot", "The claim that is contradicted again and again.", 5000, CLAIM_FEE + NEAR));
  for (let i = 0; i < 63; i++) {
    const other = Number(await ed.createClaim(`lie${i}`, `Contradiction number ${i} of the pivot claim.`, 8000, CLAIM_FEE + NEAR));
    await ed.createLink(pivot, other, "Excludes", 9000, CLAIM_FEE + NEAR);
  }
  const last = Number(await ed.createClaim("lie63", "Contradiction number 63 of the pivot claim.", 8000, CLAIM_FEE + NEAR));
  await note("create_link as the 64th link on a claim", "tx 80", gas(editor, "create_link", { a: pivot, b: last, rel: "Excludes", prior_bps: 9000 }, CLAIM_FEE + NEAR));

  console.log("\n" + rows.map(([l, r, b]) => `| ${l} | ${Number.isNaN(r.tgas) ? "n/a" : r.tgas.toFixed(1)} Tgas | ${b} | ${r.failed ? "FAILED" : "ok"} |`).join("\n"));
} finally {
  await sandbox.tearDown().catch(() => {});
}
process.exit(0);
