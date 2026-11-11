/**
 * Prints the hash of the committed contract, and, when VERITY_CONTRACT is set, compares it with the code deployed there.
 *
 *   npm run build && npm run check-code                  # just the local hash
 *   VERITY_CONTRACT=verity1-contract.you.testnet npm run check-code
 *
 * The build is not reproducible (see contracts/verity/build.sh), so this cannot show the wasm was built from the source; it shows
 * whether the code on chain is byte for byte the file in this repository. NEAR's code hash is the base58 of the wasm's sha256.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Chain } from "../src/lib/chain.js";
import { RPC_URL } from "../src/lib/config.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(here, "../../contracts/verity/res/verity.wasm");
const wasm = readFileSync(wasmPath);
const sha = createHash("sha256").update(wasm).digest();
const local = base58(sha);
console.log(`${wasmPath}\n  ${wasm.length} bytes\n  sha256   ${sha.toString("hex")}\n  code hash ${local} (the form NEAR uses)`);

const contract = process.env.VERITY_CONTRACT;
if (contract) {
  const chain = new Chain("view.invalid", undefined, contract, RPC_URL);
  const acct = (await (chain.account.provider as unknown as { query(r: unknown): Promise<{ code_hash: string }> }).query({ request_type: "view_account", finality: "final", account_id: contract }));
  console.log(`  on chain  ${acct.code_hash}  (${contract})`);
  if (acct.code_hash === local) console.log("MATCH: the deployed code is this file.");
  else { console.log("DIFFERENT: the deployed code is not this file."); process.exit(1); }
}
