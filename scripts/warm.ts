/**
 * Fetches, once, every Wikipedia page the demo's claims and lies will ask for, and keeps them on disk.
 *
 *   npm run warm
 *
 * Wikipedia limits anonymous clients, and a conference network is a bad place to find that out. Pinned revisions never
 * change, so after this the demo can run with VERITY_CACHE_ONLY=1 and no network at all, and the hashes it posts still
 * match what `curl | shasum` gets from Wikipedia.
 */
import { gatherSources } from "../src/agents/analyst.js";
import { wikipedia } from "../src/lib/brain.js";
import { loadSeedDir } from "../src/demo/seeds.js";

if (process.env.VERITY_CACHE_ONLY === "1") throw new Error("VERITY_CACHE_ONLY=1 would only read the cache; unset it to warm it");
const provider = wikipedia();
const texts = loadSeedDir(process.env.SEED_DIR ?? "seed").flatMap((f) => [...f.claims.map((c) => c.text), ...(f.lies ?? []).map((l) => l.text), ...(f.adds ?? []).map((a) => a.text)]);
let pages = 0;
for (const [i, text] of texts.entries()) {
  try {
    const found = await gatherSources(provider, text, Number(process.env.SOURCES_PER_CLAIM ?? 4));
    pages += found.length;
    console.log(`[${i + 1}/${texts.length}] ${found.length} pages  ${text}`);
  } catch (e) {
    console.log(`[${i + 1}/${texts.length}] FAILED  ${text}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
}
console.log(`\ndone: ${pages} page reads cached in ${process.env.VERITY_CACHE_DIR ?? "data/cache"}`);
