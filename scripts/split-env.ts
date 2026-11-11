/**
 * Splits `.env.generated` (what `npm run bootstrap` writes) into the three files a deployment uses, so nobody copies lines by hand:
 *
 *   npm run build && npm run split-env
 *
 *   .env.agents  network, contract, and the researcher, skeptic and arbiter accounts WITH their keys   → DOTENV_CONFIG_PATH=.env.agents npm run agents
 *   .env.server  network, contract, and the three accounts' ids only, no keys                          → DOTENV_CONFIG_PATH=.env.server npm run server
 *   .env         network, contract, and the editor account with its key                                → npm run seed, npm run verify-evidence
 *
 * The contract account's own key (CONTRACT_*) goes into none of them. Files are written with mode 600, and nothing is overwritten:
 * if any of the three exists the script says which and stops, so it cannot replace keys that may be the only way into an account.
 * `.env.generated` itself is left where it is.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

export interface Split { agents: string; server: string; editor: string }

/** The three files' contents. Throws, naming what is missing, if the generated file is incomplete. */
export function splitEnv(generated: string): Split {
  const env = parseEnv(generated);
  const need = (k: string) => {
    const v = env.get(k);
    if (!v) throw new Error(`.env.generated has no ${k}; run npm run bootstrap to completion first`);
    return `${k}=${v}`;
  };
  const common = [need("NEAR_NETWORK"), need("VERITY_CONTRACT")];
  const roles = ["RESEARCHER", "SKEPTIC", "ARBITER"];
  const agents = [...common, ...roles.flatMap((r) => [need(`${r}_ACCOUNT_ID`), need(`${r}_PRIVATE_KEY`)]), "# VERITY_USER_AGENT=\"VerityBot/1.0 (your contact here)\"", "# ANTHROPIC_API_KEY=", "# AGENT_MAX_TRADE_NEAR=1"];
  const server = [...common, ...roles.map((r) => need(`${r}_ACCOUNT_ID`)), "PORT=8787", "# VERITY_USER_AGENT=\"VerityBot/1.0 (your contact here)\"", "# TRUST_PROXY=1"];
  const editor = [...common, need("EDITOR_ACCOUNT_ID"), need("EDITOR_PRIVATE_KEY")];
  return { agents: agents.join("\n") + "\n", server: server.join("\n") + "\n", editor: editor.join("\n") + "\n" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const source = path.join(root, ".env.generated");
  if (!existsSync(source)) throw new Error(`${source} does not exist; run npm run bootstrap first`);
  const parts = splitEnv(readFileSync(source, "utf8"));
  const targets: Array<[string, string]> = [[".env.agents", parts.agents], [".env.server", parts.server], [".env", parts.editor]];
  const present = targets.filter(([name]) => existsSync(path.join(root, name))).map(([name]) => name);
  if (present.length) throw new Error(`${present.join(", ")} already exist${present.length === 1 ? "s" : ""} and may hold keys; move ${present.length === 1 ? "it" : "them"} aside and run this again`);
  for (const [name, text] of targets) {
    const file = path.join(root, name);
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`wrote ${file}`);
  }
  console.log("\nCONTRACT_* stayed in .env.generated only (keep it somewhere safe). Now: npm run seed, then\n  DOTENV_CONFIG_PATH=.env.agents npm run agents   and   DOTENV_CONFIG_PATH=.env.server npm run server");
}
