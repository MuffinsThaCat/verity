/**
 * Fetches the local NEAR node the demo runs on, so that nothing needs the network when it matters.
 *
 *   npm run build && npm run fetch-node
 *
 * `npm run demo` starts a real nearcore node (a ~53 MB binary that near-sandbox downloads the first time it is asked to start
 * one). `npm run warm` makes the Wikipedia side work offline, but not this: without the binary already on disk, even
 * `npm run demo:offline` needs the network on a machine that has never run the demo. This starts the node once and stops it.
 * The binary goes to DIR_TO_DOWNLOAD_BINARY, else a sibling checkout's `.sandbox-bin` if there is one, else `.sandbox-bin` here.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "near-sandbox";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
if (!process.env.DIR_TO_DOWNLOAD_BINARY) {
  const sibling = path.join(root, "../1Hundo-near/.sandbox-bin");
  process.env.DIR_TO_DOWNLOAD_BINARY = existsSync(sibling) ? sibling : path.join(root, ".sandbox-bin");
}
const dir = process.env.DIR_TO_DOWNLOAD_BINARY;
console.log(`node binary directory: ${dir}`);
const sandbox = await Sandbox.start({});
console.log(`started a local node at ${sandbox.rpcUrl}`);
await sandbox.tearDown().catch(() => {});
console.log(`ready. In ${dir}: ${existsSync(dir) ? readdirSync(dir).join(", ") : "(nothing?)"}`);
process.exit(0);
