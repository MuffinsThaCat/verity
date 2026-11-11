/**
 * Creates the accounts, deploys the contract and initialises it. Run once per deployment.
 *
 *   ADMIN_ACCOUNT_ID=you.testnet ADMIN_PRIVATE_KEY=ed25519:... PREFIX=verity1 npm run bootstrap
 *
 * It creates `<PREFIX>-contract.<admin>` for the contract and `<PREFIX>-researcher`, `-skeptic`, `-arbiter`, `-editor` as
 * sub-accounts of the admin, funds them, and writes every key, the contract account's included, to `.env.generated` (mode 600).
 * Each key is written the moment its account exists, so a failure part-way leaves the keys of the accounts already funded.
 * Use a fresh PREFIX: an existing account would have no key we know. It refuses to run if `.env.generated` already exists.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Account, KeyPair } from "near-api-js";
import { NETWORK, RPC_URL } from "../src/lib/config.js";
import { YOCTO_PER_NEAR } from "../src/lib/units.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Set ${k}`); return v; };

const admin = need("ADMIN_ACCOUNT_ID");
const prefix = need("PREFIX");
const adminAcct = new Account(admin, RPC_URL, need("ADMIN_PRIVATE_KEY") as `ed25519:${string}`);
const near = (n: number) => BigInt(Math.round(n * 1e6)) * (YOCTO_PER_NEAR / 1_000_000n);
const fundAgent = Number(process.env.AGENT_FUND_NEAR ?? 10);
const fundEditor = Number(process.env.EDITOR_FUND_NEAR ?? 60);
const fundContract = Number(process.env.CONTRACT_FUND_NEAR ?? 6);
const bondWindow = Number(process.env.BOND_WINDOW_SECS ?? 3600);
const feeBps = Number(process.env.FEE_BPS ?? 100);

const wasm = readFileSync(path.join(root, "contracts/verity/res/verity.wasm"));
const keys: Record<string, string> = {};

// Never overwrite keys that may be the only way into funded accounts.
const out = path.join(root, ".env.generated");
if (existsSync(out)) throw new Error(`${out} already exists and may hold the only keys to accounts from an earlier run; move it aside first`);
writeFileSync(out, `NEAR_NETWORK=${NETWORK}\n`, { mode: 0o600 });
chmodSync(out, 0o600);
const save = (...lines: string[]) => appendFileSync(out, lines.join("\n") + "\n");

async function make(label: string, fund: number) {
  const id = `${prefix}-${label}.${admin}`;
  const kp = KeyPair.fromRandom("ed25519");
  await adminAcct.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: near(fund) });
  keys[id] = kp.toString();
  save(`${label.toUpperCase()}_ACCOUNT_ID=${id}`, `${label.toUpperCase()}_PRIVATE_KEY=${kp.toString()}`);
  console.log(`created ${id} with ${fund} NEAR`);
  return id;
}

const contractId = await make("contract", fundContract);
const contract = new Account(contractId, RPC_URL, keys[contractId] as `ed25519:${string}`);
await contract.deployContract(wasm);
await contract.callFunction({ contractId, methodName: "new", args: { bond_window_secs: bondWindow, fee_bps: feeBps }, gas: 30_000_000_000_000n });
save(`VERITY_CONTRACT=${contractId}`);
console.log(`deployed verity.wasm to ${contractId} (bond window ${bondWindow}s, fee ${feeBps} bps)`);

const roles = [["researcher", fundAgent], ["skeptic", fundAgent], ["arbiter", fundAgent], ["editor", fundEditor]] as const;
for (const [role, fund] of roles) await make(role, fund);
console.log(`\nWrote ${out}. Next:  npm run split-env  (it writes .env.agents, .env.server and .env from this file; see DEPLOY.md), then  npm run seed  and  npm run agents  and  npm run server  (seed every article together: they link to each other)`);
console.log(`The contract account's full-access key is in that file as CONTRACT_PRIVATE_KEY. Delete that key on ${contractId} when you are done deploying if you want the contract immutable, and then remove it from the file; keep it if you want to upgrade.`);
