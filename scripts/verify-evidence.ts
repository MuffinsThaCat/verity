/**
 * Audits the evidence on chain: refetches every source URI and compares its sha256 with the recorded hash, and, for a
 * Wikipedia revision, checks that the quotation in the note is really in the page.
 *
 *   npm run verify-evidence
 *
 * Wikipedia evidence is pinned to a revision (oldid), so a mismatch means the agent recorded something other than
 * what that revision serves. Only hosts in VERITY_VERIFY_HOSTS (default wikipedia.org) are contacted, and redirects are
 * checked before they are followed: the contract accepts any http:// evidence address, so an unrestricted fetch would let
 * whoever posted evidence aim this machine at an internal service (for example a cloud metadata address). Evidence on
 * another host is reported and skipped. Exit code 1 if any hash does not match or a quotation is missing.
 */
import { Chain } from "../src/lib/chain.js";
import { RPC_URL, requireContract } from "../src/lib/config.js";
import { verifyEvidenceContent } from "../src/lib/sources.js";
import { quotedText } from "../src/lib/wikitext.js";

const hosts = (process.env.VERITY_VERIFY_HOSTS ?? "wikipedia.org").split(",").map((s) => s.trim()).filter(Boolean);
const chain = new Chain("verifier.invalid", undefined, requireContract(), RPC_URL);
const cfg = await chain.config();
let bad = 0, skipped = 0;
for (let id = 0; id < cfg.evidence; id++) {
  const e = await chain.evidence(id);
  if (!e) continue;
  const host = (() => { try { return new URL(e.uri).host; } catch { return ""; } })();
  if (!/^https?:\/\//.test(e.uri) || /\.invalid$/.test(host)) { skipped++; console.log(`  skip  #${id} ${e.uri}`); continue; }
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) { skipped++; console.log(`  skip  #${id} host not on the allowlist (${hosts.join(", ")}): ${e.uri}`); continue; }
  const raw = /(^|\.)wikipedia\.org$/.test(host) && /[?&]action=raw\b/.test(e.uri);
  try {
    const r = await verifyEvidenceContent(e.uri, e.content_hash, raw ? quotedText(e.note) : null, fetch, { allowHosts: hosts });
    const missing = r.quoteFound === false;
    if (!r.ok || missing) bad++;
    const status = !r.ok ? "FAIL " : missing ? "QUOTE" : "ok   ";
    console.log(`  ${status} #${id} ${e.stance} claim ${e.claim_id} ${e.uri}${r.ok ? "" : `\n        recorded ${e.content_hash}\n        actual   ${r.actual}`}${missing ? "\n        the quoted text is not in the page" : ""}`);
  } catch (err) {
    bad++;
    console.log(`  FAIL  #${id} ${e.uri}: ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${cfg.evidence - bad - skipped} verified, ${bad} failed, ${skipped} skipped (non-http, mock, or not on the allowlist)`);
process.exit(bad ? 1 : 0);
